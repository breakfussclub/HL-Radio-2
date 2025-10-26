// index.js — Local playlist bot with robust resume/restart (ffmpeg-only) + 300s threshold
// - Always spawn ffmpeg (even for fresh plays) -> consistent Ogg Opus stream
// - On resume/restart/next: kill old ffmpeg, spawn new one, create fresh resource, player.play(...)
// - Startup watchdog: if ffmpeg doesn't produce audio, skip to next track
// - Loop mode: continue
// - Resume threshold: 300s (resume below, restart at/above)
// - No unpause() usage

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  Events,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Env Vars =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID) {
  console.error("Missing DISCORD_TOKEN or VOICE_CHANNEL_ID env vars.");
  process.exit(1);
}

// ===== Config =====
const RESUME_RESTART_THRESHOLD_MS = 300 * 1000; // 300s = 5 minutes
const OPUS_BITRATE = "96k";
const OPUS_CHANNELS = "2";
const OPUS_APP = "audio";
const STARTUP_WATCHDOG_MS = 15000; // fail fast if no audio

function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:` : "") + `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

// ===== Playlist Loader =====
function parseLeadingNumber(basename) {
  const m = basename.match(/^(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function loadPlaylist(dir) {
  const files = fs
    .readdirSync(dir)
    .filter(f =>
      f.toLowerCase().endsWith(".ogg") ||
      f.toLowerCase().endsWith(".mp3") ||
      f.toLowerCase().endsWith(".wav") ||
      f.toLowerCase().endsWith(".m4a") ||
      f.toLowerCase().endsWith(".flac")
    )
    .map(f => ({ name: f, number: parseLeadingNumber(f) }));

  if (!files.length) {
    throw new Error("No supported audio files (.ogg | .mp3 | .wav | .m4a | .flac) in repo root.");
  }

  files.sort((a, b) => {
    const an = a.number, bn = b.number;
    if (an !== null && bn !== null) return an - bn;
    if (an !== null) return -1;
    if (bn !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  return files.map(f => path.join(dir, f.name));
}

// ===== Status Cleaner =====
function setListeningStatus(trackName) {
  let clean = trackName.replace(/\.[^/.]+$/, "");
  clean = clean.replace(/^\d+\s*/, "");
  clean = clean.replace(/-of$/i, "");
  clean = clean.replace(/[-_]/g, " ");
  clean = clean.replace(/\s+/g, " ").trim();
  clean = clean.replace(/\b\w/g, c => c.toUpperCase());
  try { client.user.setActivity(clean, { type: 2 }); } catch {}
}

// ===== Discord Bot Setup =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
});

let connection = null;
const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play
  }
});

let playlist = [];
let indexPtr = 0;
let hasStartedPlayback = false;
let keepAliveInterval = null;

// Resume state
let isPausedDueToEmpty = false;
let resumeOffsetMs = 0;
let startedAtMs = 0;
let currentTrackPath = null;
let ffmpegProc = null;
let startupWatchdog = null;

// ===== ffmpeg helpers =====
function killFfmpeg() {
  try { ffmpegProc?.kill("SIGKILL"); } catch {}
  ffmpegProc = null;
  if (startupWatchdog) {
    clearTimeout(startupWatchdog);
    startupWatchdog = null;
  }
}

function spawnFfmpeg(filePath, offsetMs = 0) {
  // Always transcode to Ogg Opus for Discord
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    ...(offsetMs > 0 ? ["-ss", Math.floor(offsetMs / 1000).toString()] : []),
    "-i", filePath,
    "-vn",
    "-ac", OPUS_CHANNELS,
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", OPUS_BITRATE,
    "-application", OPUS_APP,
    "-f", "ogg",
    "pipe:1",
  ];

  killFfmpeg(); // ensure clean state
  ffmpegProc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });

  // Swallow stderr to avoid noisy logs; useful if files have meta/icc chatter
  ffmpegProc.stderr?.on("data", () => {});
  ffmpegProc.on("exit", (code, signal) => {
    if (startupWatchdog) {
      clearTimeout(startupWatchdog);
      startupWatchdog = null;
    }
    // Normal end is handled by AudioPlayerStatus.Idle; nothing to do here
  });

  return ffmpegProc.stdout;
}

function playWithFfmpeg(filePath, offsetMs = 0) {
  currentTrackPath = filePath;
  const baseName = path.basename(filePath);
  setListeningStatus(baseName);

  const stdout = spawnFfmpeg(filePath, offsetMs);

  // Watchdog: if ffmpeg doesn't push any bytes soon, skip to next
  let gotData = false;
  const onFirstData = () => {
    gotData = true;
    if (startupWatchdog) {
      clearTimeout(startupWatchdog);
      startupWatchdog = null;
    }
    startedAtMs = Date.now();
  };
  stdout.once("data", onFirstData);

  startupWatchdog = setTimeout(() => {
    if (!gotData) {
      console.warn(`[WATCHDOG] No audio from ffmpeg — skipping: ${baseName}`);
      killFfmpeg();
      // Move pointer forward only for fresh plays (not resumes) — but both cases land here after playWithFfmpeg call
      // We'll emulate "track failed" -> advance
      resumeOffsetMs = 0;
      startedAtMs = 0;
      currentTrackPath = null;
      playNext();
    }
  }, STARTUP_WATCHDOG_MS);

  const resource = createAudioResource(stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
}

// ===== Play Next Track (uses ffmpeg, offset 0) =====
function playNext() {
  const filePath = playlist[indexPtr];
  const baseName = path.basename(filePath);

  console.log(`[PLAY] ${baseName} (${indexPtr + 1}/${playlist.length})`);
  resumeOffsetMs = 0;
  startedAtMs = 0;

  playWithFfmpeg(filePath, 0);

  // Advance pointer for loop-continuation
  indexPtr = (indexPtr + 1) % playlist.length;
}

// ===== Keep Alive =====
function startKeepAlive(connection) {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    try { connection?.configureNetworking(); } catch {}
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// ===== Voice Connection =====
async function connectAndSubscribe(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== 2) {
    throw new Error("VOICE_CHANNEL_ID must refer to a Voice Channel.");
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.warn("[VC] Disconnected — attempting quick recovery…");
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      setTimeout(() => {
        try { connection?.destroy(); } catch {}
        connection = null;
        connectAndSubscribe(channelId).catch(() => {});
      }, 3000);
    }
  });

  startKeepAlive(connection);
  connection.subscribe(player);
}

// ===== Auto-Pause / Resume + First Listener (ffmpeg-only) =====
client.on("voiceStateUpdate", (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter(m => !m.user.bot);

  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      // Calculate elapsed and remember offset; stop audio pipeline completely
      const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
      resumeOffsetMs += elapsed;
      isPausedDueToEmpty = true;

      try { player.stop(true); } catch {}
      killFfmpeg();

      console.log(`[VC] No listeners — paused @ ${hms(resumeOffsetMs)}.`);
    }
    return;
  }

  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log("[VC] First listener joined — starting playback.");
    playNext();
    return;
  }

  const overThreshold = resumeOffsetMs >= RESUME_RESTART_THRESHOLD_MS;

  if (isPausedDueToEmpty) {
    // Always rebuild pipeline via ffmpeg on resume
    const targetOffset = overThreshold ? 0 : resumeOffsetMs;
    console.log(
      overThreshold
        ? `🔁 Returning listener — restarting from beginning (≥ ${hms(RESUME_RESTART_THRESHOLD_MS)}).`
        : `▶️  Returning listener — resuming from ${hms(resumeOffsetMs)}.`
    );

    isPausedDueToEmpty = false;

    if (!currentTrackPath) {
      // Shouldn't happen normally, but guard: if we lost track, continue to next
      playNext();
    } else {
      playWithFfmpeg(currentTrackPath, targetOffset);
    }
  }
});

// ===== Events =====
player.on(AudioPlayerStatus.Playing, () => {
  // Fresh resource started
  // startedAtMs is set in playWithFfmpeg on first data
});

player.on(AudioPlayerStatus.Idle, () => {
  // End of current resource; advance unless paused due to empty (we kill pipeline then)
  if (isPausedDueToEmpty) return;
  resumeOffsetMs = 0;
  startedAtMs = 0;
  currentTrackPath = null;
  playNext();
});

player.on("error", err => {
  console.error("[PLAYER ERROR]", err);
  // On errors: advance to next
  resumeOffsetMs = 0;
  startedAtMs = 0;
  currentTrackPath = null;
  playNext();
});

// ===== On Ready =====
client.once(Events.ClientReady, async () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);

  playlist = loadPlaylist(__dirname);
  console.log("[PLAYLIST]");
  playlist.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2, "0")}. ${path.basename(p)}`));

  await connectAndSubscribe(VOICE_CHANNEL_ID);
  console.log("[VC] Waiting for listeners...");
});

// ===== Start Bot =====
client.login(DISCORD_TOKEN);
