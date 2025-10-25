require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType
} = require('@discordjs/voice');

const ytdlExec = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('❌ Missing env values. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TRACK_DIR = path.join(__dirname, 'tracks');
const SELF_DEAFEN = true;
const BITRATE = '96k';        // Opus bitrate to Discord
const DOWNLOAD_QUALITY = '128K';

// ─── DISCORD ──────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let connection = null;
let playlistFiles = [];
let index = 0;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function ensureDir(dir) {
  if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
}

function ffmpegFileToOggOpus(filePath) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', filePath,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', BITRATE,
    '-f', 'ogg',
    'pipe:1'
  ];
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim()));
  return child.stdout;
}

async function listMp3sOrdered() {
  const files = await fsp.readdir(TRACK_DIR);
  return files
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(f => path.join(TRACK_DIR, f));
}

async function downloadPlaylist() {
  console.log('⬇️  Checking for missing tracks… (no redownloads for A1 mode)');

  await ensureDir(TRACK_DIR);
  const before = await listMp3sOrdered();

  console.log('Downloading any missing tracks from playlist…');
  await ytdlExec(
    SC_PLAYLIST_URL,
    {
      output: path.join(TRACK_DIR, '%(playlist_index)02d-%(title)s.%(ext)s'),
      yesPlaylist: true,
      noPart: true,
      noCacheDir: true,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: DOWNLOAD_QUALITY,
      ffmpegLocation: ffmpegPath,
      ignoreErrors: true,
      continue: true,
      playlistEnd: 1000
    }
  );

  playlistFiles = await listMp3sOrdered();
  console.log(`✅ Playlist ready: ${playlistFiles.length} total, ${playlistFiles.length - before.length} new`);
}

async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: SELF_DEAFEN
  });
  connection.subscribe(player);
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
async function playCurrent() {
  const file = playlistFiles[index % playlistFiles.length];
  console.log(`▶️  Now Playing: ${path.basename(file)}`);

  try {
    const oggOut = ffmpegFileToOggOpus(file);
    const resource = createAudioResource(oggOut, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err);
    index++;
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playCurrent().catch(err => {
    console.error('Loop error:', err);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  index = (index + 1) % playlistFiles.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err);
  index = (index + 1) % playlistFiles.length;
  setTimeout(loopPlay, 2000);
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  await downloadPlaylist();
  await ensureConnection();
  loopPlay();
}

process.on('SIGTERM', () => {
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
