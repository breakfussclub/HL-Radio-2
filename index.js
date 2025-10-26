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
  let clean = trackName.replace(/\.[^/.]+$/, "");
  clean = clean.replace(/^\d+\s*/, "");
  clean = clean.replace(/-of$/i, "");
  clean = clean.replace(/[-_]/g, " ");
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

// ===== ffmpeg play helper =====
function playFromOffset(filePath, offsetMs = 0) {
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
  ffmpegProc.stderr?.on("data", () => {});

  const resource = createAudioResource(ffmpegProc.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  startedAtMs = Date.now();
}

// ===== Play Next Track =====
function playNext() {
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

// ===== Auto-Pause / Resume + First Listener =====
client.on("voiceStateUpdate", (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humans = channel.members.filter(m => !m.user.bot);

  if (humans.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      const elapsed = Math.max(0, Date.now() - (startedAtMs || Date.now()));
      resumeOffsetMs += elapsed;
      isPausedDueToEmpty = true;
      try { player.pause(); } catch {}
      try { ffmpegProc?.kill("SIGKILL"); } catch {}
      ffmpegProc = null;
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
    if (!currentTrackPath) {
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

// ===== Events =====
player.on(AudioPlayerStatus.Idle, () => {
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
