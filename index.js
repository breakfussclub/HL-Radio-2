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

  if (files.length === 0) {
    throw new Error("No supported audio files (.ogg | .mp3 | .wav) in root.");
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

// ===== Discord Bot Setup =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let connection = null;
const player = createAudioPlayer();
let playlist = [];
let indexPtr = 0;

function playNext() {
  const filePath = playlist[indexPtr];
  try {
    const resource = createAudioResource(filePath, {
      inputType: StreamType.Arbitrary,
    });
    player.play(resource);
    console.log(`[PLAY] ${path.basename(filePath)} (${indexPtr + 1}/${playlist.length})`);
  } catch (err) {
    console.error(`[ERROR] Failed to play ${filePath}:`, err);
  }
  indexPtr = (indexPtr + 1) % playlist.length;
}

async function connectAndSubscribe(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== 2) {
    throw new Error("VOICE_CHANNEL_ID must point to a Voice Channel.");
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

player.on(AudioPlayerStatus.Idle, () => playNext());
player.on("error", err => {
  console.error("[PLAYER ERROR]", err);
  playNext();
});

client.once(Events.ClientReady, async () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);
  playlist = loadPlaylist(__dirname);
  console.log("[PLAYLIST]");
  playlist.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${path.basename(p)}`));
  await connectAndSubscribe(VOICE_CHANNEL_ID);
  playNext();
});

client.login(DISCORD_TOKEN);
