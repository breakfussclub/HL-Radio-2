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
} from "@discordjs/voice";
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
  client.user.setActivity(clean, { type: 2 });         // type 2 = LISTENING
}

// ===== Discord Bot Setup =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
});

let connection = null;
const player = createAudioPlayer();
let playlist = [];
let indexPtr = 0;
let hasStartedPlayback = false;

// ===== Playback =====
function playNext() {
  const filePath = playlist[indexPtr];
  const baseName = path.basename(filePath);

  try {
    const resource = createAudioResource(filePath, {
      inputType: StreamType.Arbitrary
    });

    player.play(resource);
    setListeningStatus(baseName);
    console.log(`[PLAY] ${baseName} (${indexPtr + 1}/${playlist.length})`);
  } catch (err) {
    console.error(`[ERROR] Failed to play ${baseName}:`, err);
  }

  indexPtr = (indexPtr + 1) % playlist.length;
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
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
      console.log("[VOICE] Reconnecting...");
    } catch {
      console.warn("[VOICE] Recreate connection...");
      connection.destroy();
      await connectAndSubscribe(channelId);
    }
  });

  connection.subscribe(player);
}

// ===== Auto Pause / Resume + Wait for First Listener =====
client.on("voiceStateUpdate", (oldState, newState) => {
  const channel = oldState.channel || newState.channel;
  if (!channel || channel.id !== VOICE_CHANNEL_ID) return;

  const humanMembers = channel.members.filter(m => !m.user.bot);

  // If empty, pause ONLY if currently playing
  if (humanMembers.size === 0) {
    if (player.state.status === AudioPlayerStatus.Playing) {
      player.pause();
      console.log("[VC] No listeners — pausing playback.");
    }
    return;
  }

  // If someone joined and we haven't started yet, start playback
  if (!hasStartedPlayback) {
    hasStartedPlayback = true;
    console.log("[VC] First listener joined — starting playback.");
    playNext();
    return;
  }

  // If paused, resume playback
  if (player.state.status === AudioPlayerStatus.Paused) {
    player.unpause();
    console.log("[VC] Listener joined — resuming playback.");
  }
});

// ===== Event Hooks =====
player.on(AudioPlayerStatus.Idle, () => {
  if (hasStartedPlayback) playNext();
});
player.on("error", err => {
  console.error("[PLAYER ERROR]", err);
  if (hasStartedPlayback) playNext();
});

// ===== On Ready =====
client.once(Events.ClientReady, async () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);

  playlist = loadPlaylist(__dirname);
  console.log("[PLAYLIST]");
  playlist.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${path.basename(p)}`));

  await connectAndSubscribe(VOICE_CHANNEL_ID);
  console.log("[VC] Waiting for listeners...");
});

// ===== Start Bot =====
client.login(DISCORD_TOKEN);
