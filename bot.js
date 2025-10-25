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

const ffmpegPath = require('ffmpeg-static');
// Try to load scdl-core in the most common ways:
let scdl;
try {
  // some builds export default, some commonjs
  const mod = require('scdl-core');
  scdl = mod.default || mod;
} catch (e) {
  console.error('❌ Unable to load scdl-core:', e?.message || e);
  process.exit(1);
}

const sodium = require('libsodium-wrappers');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('❌ Missing env values. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// Optional: if you have your own SC client_id, set it to improve reliability
const { SC_CLIENT_ID } = process.env;

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TRACK_DIR = path.join(__dirname, 'tracks');
const SELF_DEAFEN = true;
const OPUS_BITRATE = '96k';     // Discord transmit bitrate (Opus)
const MP3_QUALITY = '128k';     // Downloaded MP3 quality (target)

// ─── DISCORD ──────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let connection = null;
let playlistFiles = [];
let playIndex = 0;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function ensureDir(dir) {
  if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
}

function sanitize(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return files
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(f => path.join(TRACK_DIR, f));
}

// ─── PLAYLIST SCRAPE (HTML) — one pass (7–8 tracks) ──────────────────────────
async function scrapePlaylistTracks(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading playlist page`);
  const html = await res.text();

  // Extract track permalink URLs from the bootstrapped state (SoundCloud escapes / as \u002F)
  const regex = /"permalink_url":"(https:\/\/soundcloud\.com\/[^"]+)"/g;
  const urls = [];
  for (const m of html.matchAll(regex)) {
    const u = m[1].replace(/\\u002F/g, '/');
    urls.push(u);
  }

  // Keep only track URLs (exclude /sets/, /likes, etc.)
  const trackUrls = urls.filter(u =>
    /^https:\/\/soundcloud\.com\/[^/]+\/[^/]+$/.test(u) && !u.includes('/sets/')
  );

  // De-duplicate while preserving order
  const unique = [...new Set(trackUrls)];
  if (!unique.length) throw new Error('No track URLs found in playlist HTML');

  return unique;
}

// ─── DOWNLOAD ONE TRACK (with multiple fallbacks) ─────────────────────────────
async function downloadTrackToFile(trackUrl, indexForName) {
  // We'll try common scdl-core APIs in order. Many variants return a Readable stream.
  const targetBase = `${String(indexForName).padStart(2, '0')}`;
  let titleGuess = `track-${targetBase}`;
  let outFile;

  // Try to resolve metadata (to get a nice filename)
  try {
    if (typeof scdl.getInfo === 'function') {
      const info = await scdl.getInfo(trackUrl, { client_id: SC_CLIENT_ID });
      if (info?.title) titleGuess = sanitize(info.title);
    } else if (typeof scdl.info === 'function') {
      const info = await scdl.info(trackUrl, { client_id: SC_CLIENT_ID });
      if (info?.title) titleGuess = sanitize(info.title);
    }
  } catch {
    // If info fails, we’ll still download using generic name
  }

  outFile = path.join(TRACK_DIR, `${targetBase}-${titleGuess}.mp3`);
  if (fs.existsSync(outFile)) {
    console.log(`✔ Skipping (exists): ${path.basename(outFile)}`);
    return outFile;
  }

  // Try a few download shapes
  const tryShapes = [
    // scdl-core often exposes .download(url, {format:'mp3'|quality})
    async () => (typeof scdl.download === 'function'
      ? await scdl.download(trackUrl, { client_id: SC_CLIENT_ID, format: 'mp3', quality: MP3_QUALITY })
      : null),
    // Some variants: .downloadTrack / .downloadSong
    async () => (typeof scdl.downloadTrack === 'function'
      ? await scdl.downloadTrack(trackUrl, { client_id: SC_CLIENT_ID, quality: 'mp3' })
      : null),
    async () => (typeof scdl.downloadSong === 'function'
      ? await scdl.downloadSong(trackUrl, { client_id: SC_CLIENT_ID, quality: 'mp3' })
      : null)
  ];

  let stream = null;
  for (const fn of tryShapes) {
    try {
      const s = await fn();
      if (s && typeof s.pipe === 'function') { stream = s; break; }
    } catch (e) {
      // try next shape
    }
  }

  if (!stream) {
    console.warn(`⚠ Could not download via scdl-core methods: ${trackUrl}`);
    return null;
  }

  console.log(`⬇️  Downloading: ${path.basename(outFile)}`);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile);
    stream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    stream.pipe(ws);
  });

  return outFile;
}

// ─── DOWNLOAD PLAYLIST (A1 mode: only missing files) ─────────────────────────
async function downloadPlaylist() {
  console.log('⬇️  Resolving playlist (HTML scrape)…');
  await ensureDir(TRACK_DIR);
  const urls = await scrapePlaylistTracks(SC_PLAYLIST_URL);

  console.log(`Found ${urls.length} track URLs. Downloading missing MP3s…`);
  for (let i = 0; i < urls.length; i++) {
    const saved = await downloadTrackToFile(urls[i], i + 1).catch(e => {
      console.error('Download error:', e?.message || e);
      return null;
    });
    if (!saved) console.warn(`⚠ Skipped: ${urls[i]}`);
  }

  playlistFiles = await listMp3sOrdered();
  if (!playlistFiles.length) throw new Error('No MP3 files found after download.');
  console.log(`✅ Playlist ready: ${playlistFiles.length} files in ${TRACK_DIR}`);
}

// ─── VOICE CONNECTION ─────────────────────────────────────────────────────────
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
        }, 5000);
      }
    });

    connection.subscribe(player);
  }
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
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

// ─── BOOT ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  await downloadPlaylist();     // A1: only downloads missing tracks
  await ensureConnection();
  loopPlay();
}

process.on('SIGTERM', () => {
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
