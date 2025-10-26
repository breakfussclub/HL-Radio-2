// index.js — Local playlist bot with reliable resume/restart (ffmpeg-seek) and 300s threshold

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

// ===== Small helpers =====
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
      f.toLowerCase().endsWith(".wav")
    )
    .map(f => ({ name: f, number: parseLeadingNumber(f) }));

  if (!files.length) {
    throw new Error("No supported audio files (.ogg | .mp3 | .wav) in repo root.");
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
  let clean = trackName.replace(/\.[^/.]+$/, "");      // remove extension
  clean = clean.replace(/^\d+\s*/, "");                // remove leading number
  clean = clean.replace(/-of$/i, "");                  // remove -of at end
  clean = clean.replace(/[-_]/g, " ");                 // replace symbols with space
  clean = clean.replace(/\b\w/g, c => c.toUpperCase()); // capitalize words
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
    noSubscriber: NoSubscriberBehavior.Play // prevents disconnect
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
let ffmpegProc = null; // only non-null when we are playing via ffmpeg (resume/restart path)

// ===== ffmpeg play helper (for resume/restart with precise seek) =====
function playFromOffset(filePath, offsetMs = 0) {
  // Clean up any previous ffmpeg
  try { ffmpegProc?.kill("SIGKILL"); } catch {}
  ffmpegProc = null;

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", Math.floor(offsetMs / 1000).toString(),
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

  ffmpegProc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
  ffmpegProc.stderr?.on("data", () => {}); // keep stderr drained quietly

  const resource = createAudioResource(ffmpegProc.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  startedAtMs = Date.now();
}

// ===== Play Next Track (normal path) =====
function playNext() {
  // If we were in an ffmpeg session, stop it before moving to next track
  try { ffmpegProc?.kill("SIGKILL"); } catch {}
  ffmpegProc = null;

  currentTrackPath = playlist[indexPtr];
  const baseName = path.basename(currentTrackPath);

  try {
    const resource = createAudioResource(currentTrackPath, {
      inputType: StreamType.Arbitrary
    });

    resumeOffsetMs = 0;
    startedAtMs = Date.now();
    player.play(resource);
    setListeningStatus(baseName);
    console.log(`[PLAY] ${baseName} (${indexPtr + 1}/${playlist.length})`);
  } catch (err) {
    console.error(`[ERROR] Failed to play ${baseName}:`, err);
  }

  indexPtr = (indexPtr + 1) % playlist.length;
}

// ===== Silent Opus Keep-Alive (prevents disconnects while paused) =====
function startKeepAlive(connection) {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    try { connection?.configureNetworking(); } catch {}
  }, 15000); // every 15s
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

  // Auto-reconnect handler
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

// ===== Auto-Pause / Resume + Wait for First Listener =====
client.on("voiceStateUpdate", (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humanMembers = channel.members.filter(m => !m.user.bot);

  if (humanMembers.size === 0) {
    // Pause & capture progress only if currently playing
    if (player.state.status === AudioPlayerStatus.Playing) {
      const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
      resumeOffsetMs += elapsed;

      isPausedDueToEmpty = true;

      // Stop the player; if ffmpeg is active, kill it to avoid stale pipes
      try { player.pause(); } catch {}
      try { ffmpegProc?.kill("SIGKILL"); } catch {}
      ffmpegProc = null;

      console.log(`[VC] No listeners — paused @ ${hms(resumeOffsetMs)}.`);
    }
    return;
  }

  // First listener ever since boot
  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log("[VC] First listener joined — starting playback.");
    playNext();
    return;
  }

  // Resume logic with threshold:
  // - If under 5m, resume current track from offset using ffmpeg seek
  // - If 5m or more, restart current track from beginning using ffmpeg
  const overThreshold = resumeOffsetMs >= RESUME_RESTART_THRESHOLD_MS;

  if (isPausedDueToEmpty) {
    if (!currentTrackPath) {
      // Fallback: if for some reason we have no track cached, just play next
      console.log("[VC] Listener returned — no current track cached, moving to next.");
      isPausedDueToEmpty = false;
      playNext();
      return;
    }

    if (overThreshold) {
      console.log(`🔁 Returning listener — track played ${hms(resumeOffsetMs)}, above threshold, restarting from beginning.`);
      isPausedDueToEmpty = false;
      resumeOffsetMs = 0;
      playFromOffset(currentTrackPath, 0);
    } else {
      console.log(`▶️  Listener returned — resuming from ${hms(resumeOffsetMs)} (under threshold).`);
      isPausedDueToEmpty = false;
      playFromOffset(currentTrackPath, resumeOffsetMs);
    }
    return;
  }

  // Safety: if somehow paused without flag, treat the same way
  if (player.state.status === AudioPlayerStatus.Paused) {
    if (!currentTrackPath) {
      console.log("[VC] Listener returned — no current track cached, moving to next.");
      playNext();
      return;
    }
    if (overThreshold) {
      console.log(`🔁 Returning listener — track played ${hms(resumeOffsetMs)}, above threshold, restarting from beginning.`);
      resumeOffsetMs = 0;
      playFromOffset(currentTrackPath, 0);
    } else {
      console.log(`▶️  Listener returned — resuming from ${hms(resumeOffsetMs)} (under threshold).`);
      playFromOffset(currentTrackPath, resumeOffsetMs);
    }
  }
});

// ===== Event Hooks =====
player.on(AudioPlayerStatus.Idle, () => {
  // Track finished — continue playlist normally
  if (hasStartedPlayback) {
    resumeOffsetMs = 0;
    startedAtMs = 0;
    currentTrackPath = null;
    playNext();
  }
});

player.on("error", err => {
  console.error("[PLAYER ERROR]", err);
  if (hasStartedPlayback) {
    // On error, advance to next track
    resumeOffsetMs = 0;
    startedAtMs = 0;
    currentTrackPath = null;
    playNext();
  }
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
