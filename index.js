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
} from "@discordjs/voice";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Env Vars (Railway) =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

// Fail fast if required vars are missing
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID) {
  console.error("Missing env vars. Required: DISCORD_TOKEN, VOICE_CHANNEL_ID");
  process.exit(1);
}

// ===== Load all .ogg files from the ROOT dir =====
function parseLeadingNumber(basename) {
  const m = basename.match(/^(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function loadPlaylist(dir) {
  const files = fs
    .readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith(".ogg"))
    .map(f => ({ name: f, number: parseLeadingNumber(f) }));

  if (files.length === 0) {
    throw new Error("No .ogg files found in repo root.");
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

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let connection = null;
const player = createAudioPlayer();
let playlist = [];
let indexPtr = 0;

// Play the next track in the loop
function playNext() {
  if (playlist.length === 0) return;
  const filePath = playlist[indexPtr];

  try {
    const resource = createAudioResource(filePath);
    player.play(resource);

    const base = path.basename(filePath);
    console.log(`[PLAY] ${base} (${indexPtr + 1}/${playlist.length})`);
  } catch (err) {
    console.error(`[ERROR] Failed to play ${filePath}:`, err);
  }

  indexPtr = (indexPtr + 1) % playlist.length;
}

async function connectAndSubscribe(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== 2) { // 2 = GuildVoice
    throw new Error("VOICE_CHANNEL_ID must refer to a voice channel");
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
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log("[VOICE] Reconnecting...");
    } catch {
      console.warn("[VOICE] Recreate connection after disconnect...");
      try { connection.destroy(); } catch {}
      await connectAndSubscribe(channelId);
    }
  });

  connection.subscribe(player);
}

player.on(AudioPlayerStatus.Idle, () => playNext());
player.on("error", (err) => {
  console.error("[PLAYER ERROR]", err.message);
  playNext();
});

client.once(Events.ClientReady, async () => {
  try {
    console.log(`[READY] Logged in as ${client.user.tag}`);

    playlist = loadPlaylist(__dirname);
    console.log(`[PLAYLIST] ${playlist.length} tracks loaded:`);
    playlist.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${path.basename(p)}`));

    await connectAndSubscribe(VOICE_CHANNEL_ID);
    playNext();
  } catch (err) {
    console.error("[BOOT ERROR]", err);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN);
