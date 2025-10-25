require('dotenv').config();
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

const ytDlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// ── ENV ───────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('❌ Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TRACK_DIR = path.resolve(__dirname, 'tracks');
const SELF_DEAFEN = true;
const REJOIN_DELAY_MS = 5000;
const OPUS_BITRATE = '96k';       // Opus encode to Discord (playback). Change to '64k' to save bandwidth.
const DL_AUDIO_QUALITY = '128K';  // ✅ Your choice: MP3 128 kbps

// ── DISCORD CLIENT & PLAYER ───────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let connection = null;
let playlistFiles = [];   // array of full file paths
let playIndex = 0;

// ── UTIL ──────────────────────────────────────────────────────────────────────
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
    '-b:a', OPUS_BITRATE,
    '-f', 'ogg',
    'pipe:1'
  ];
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });
  return child.stdout;
}

async function listMp3sOrdered() {
  const files = await fsp.readdir(TRACK_DIR);
  // Keep only .mp3 and sort naturally; our filename template includes playlist_index prefix.
  return files
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(f => path.join(TRACK_DIR, f));
}

// ── DOWNLOAD PLAYLIST WITH yt-dlp ─────────────────────────────────────────────
// We use yt-dlp to download the ENTIRE playlist as MP3 128k into ./tracks/
// ffmpeg-static is passed explicitly so conversion works on Railway.
async function downloadPlaylist() {
  console.log('⬇️  Downloading/Updating playlist via yt-dlp…');
  await ensureDir(TRACK_DIR);

  // Output template: 01-Title.mp3, 02-Title.mp3, ...
  const outputTpl = path.join(TRACK_DIR, '%(playlist_index)02d-%(title)s.%(ext)s');

  try {
    await ytDlp(SC_PLAYLIST_URL, {
      output: outputTpl,
      yesPlaylist: true,
      noPart: true,
      noCacheDir: true,
      // Extract & convert audio
      x: true,                      // --extract-audio
      audioFormat: 'mp3',           // --audio-format mp3
      audioQuality: DL_AUDIO_QUALITY, // --audio-quality 128K
      // Ensure yt-dlp uses our static ffmpeg
      ffmpegLocation: ffmpegPath,
      // Be gentle with retries
      retries: 3,
      fragmentRetries: 3,
      // Quiet-ish logs
      quiet: false,
      progress: false
    });
  } catch (err) {
    console.error('yt-dlp error:', err?.stderr || err?.message || err);
  }

  playlistFiles = await listMp3sOrdered();
  if (!playlistFiles.length) {
    throw new Error('No MP3 files found after download. Check the playlist URL and availability.');
  }
  console.log(`✅ Playlist ready: ${playlistFiles.length} files in ${TRACK_DIR}`);
}

// ── VOICE CONNECTION ──────────────────────────────────────────────────────────
async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) {
    throw new Error('VOICE_CHANNEL_ID is not a voice channel I can access.');
  }

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected — attempting recovery…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
        console.log('Reconnected without rejoin.');
      } catch {
        setTimeout(() => {
          try { connection?.destroy(); } catch {}
          connection = null;
          ensureConnection().catch(e => console.error('Rejoin failed:', e?.message || e));
        }, REJOIN_DELAY_MS);
      }
    });

    connection.subscribe(player);
  }
}

// ── PLAYBACK LOOP ─────────────────────────────────────────────────────────────
async function playCurrent() {
  if (!playlistFiles.length) {
    console.log('No local tracks found; retrying in 30s…');
    setTimeout(loopPlay, 30000);
    return;
  }

  const file = playlistFiles[playIndex % playlistFiles.length];
  console.log(`▶️  Now Playing [${playIndex + 1}/${playlistFiles.length}]: ${path.basename(file)}`);

  try {
    const oggOut = ffmpegFileToOggOpus(file);
    const resource = createAudioResource(oggOut, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    playIndex = (playIndex + 1) % playlistFiles.length; // skip failed
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  playIndex = (playIndex + 1) % playlistFiles.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  playIndex = (playIndex + 1) % playlistFiles.length;
  setTimeout(loopPlay, 2000);
});

// ── BOOT ──────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;

  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Download (or update) the playlist locally
  await downloadPlaylist();

  // Join voice and start loop
  await ensureConnection();
  loopPlay();
}

// graceful shutdown for Railway
process.on('SIGTERM', () => {
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
