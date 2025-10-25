require('dotenv').config();
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
const play = require('play-dl');
const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('❌ Missing env values. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SELF_DEAFEN = true;
const BITRATE = '96k'; // use '64k' to cut bandwidth ~35–45%

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let tracks = [];  // array of track URLs
let index = 0;
let connection = null;

// ─── SCRAPE TRACK URLS FROM PLAYLIST HTML (no pagination needed) ─────────────
async function scrapePlaylistTracks(url) {
  // Node 18 has global fetch
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading playlist page`);
  const html = await res.text();

  // Extract permalink_url entries from the bootstrapped JSON on the page
  const regex = /"permalink_url":"(https:\/\/soundcloud\.com\/[^"]+)"/g;
  const urls = [];
  for (const m of html.matchAll(regex)) {
    // unescape \u002F
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

// ─── FFMPEG PIPELINE: any input → OGG/Opus → stdout ──────────────────────────
function ffmpegOggOpus(inputReadable) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', 'pipe:0',
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', BITRATE,
    '-f', 'ogg',
    'pipe:1'
  ];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  inputReadable.on('error', e => console.error('Input stream error:', e?.message || e));
  inputReadable.pipe(child.stdin);
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });
  return child.stdout;
}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
async function playCurrent() {
  const url = tracks[index % tracks.length];
  console.log(`▶️  Now Playing: ${url}`);

  try {
    // fetch SoundCloud client_id (auth) so tracks are streamable
    // we do this once at startup in main(), but repeat here if needed
    if (!play.is_expired()) {
      // token still valid
    } else {
      const clientID = await play.getFreeClientID();
      play.setToken({ soundcloud: { client_id: clientID }});
    }

    // Stream the track; play-dl handles SoundCloud formats
    const source = await play.stream(url); // returns { stream, type }
    const oggOut = ffmpegOggOpus(source.stream);
    const resource = createAudioResource(oggOut, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    index = (index + 1) % tracks.length; // Option A: skip failed track
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
  index = (index + 1) % tracks.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  index = (index + 1) % tracks.length; // skip on error
  setTimeout(loopPlay, 2000);
});

// ─── VOICE CONNECTION ────────────────────────────────────────────────────────
async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID must be a voice channel I can access.');

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

// ─── BOOT ────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Acquire client_id for SoundCloud
  const clientID = await play.getFreeClientID();
  play.setToken({ soundcloud: { client_id: clientID }});

  tracks = await scrapePlaylistTracks(SC_PLAYLIST_URL);
  console.log(`✅ Playlist loaded (${tracks.length} tracks)`);

  await ensureConnection();
  loopPlay();
}

main().catch(err => {
  console.error('Fatal boot error:', err?.message || err);
  process.exit(1);
});
