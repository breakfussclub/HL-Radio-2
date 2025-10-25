require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
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
const scdl = require('soundcloud-downloader').default || require('soundcloud-downloader');
const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// ─── Env ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const REJOIN_DELAY_MS = 5000;
const SELF_DEAFEN = true;
const BITRATE = '96k'; // change to '64k' if you want ~30–50% less bandwidth

// ─── Discord Client / Voice Player ────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

// ─── State ────────────────────────────────────────────────────────────────────
let tracks = []; // array of track objects with { title, permalink_url, id }
let index = 0;
let connection = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function resolvePlaylist(url) {
  // Auto-acquire client ID internally; scdl handles rotating IDs
  const info = await scdl.getSetInfo(url);
  const items = (info?.tracks || []).map(t => ({
    title: t?.title || 'Untitled',
    permalink_url: t?.permalink_url || t?.permalink || t?.permalink_url,
    id: t?.id
  })).filter(t => typeof t.permalink_url === 'string');

  if (!items.length) throw new Error('No tracks found in the playlist.');
  return items;
}

function ffmpegFromReadable(readable) {
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
  readable.on('error', e => console.error('Input stream error:', e?.message || e));
  readable.pipe(child.stdin);

  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });

  return child.stdout;
}

async function playCurrent() {
  if (!tracks.length) {
    console.log('No tracks resolved yet — retrying in 30s…');
    setTimeout(loopPlay, 30_000);
    return;
  }

  const t = tracks[index % tracks.length];
  console.log(`▶️  Now Playing: ${t.title}`);

  try {
    // Prefer progressive/streaming URL; scdl handles HLS/protected cases.
    // downloadStream returns a readable audio stream of the track.
    const input = await scdl.downloadStream(t.permalink_url);

    // Watchdog: ensure bytes flow, or skip
    let gotData = false;
    const watchdog = setTimeout(() => {
      if (!gotData) {
        console.warn('No audio bytes after 8s — skipping track.');
        try { input.destroy(); } catch {}
        index = (index + 1) % Math.max(1, tracks.length);
        setTimeout(loopPlay, 1500);
      }
    }, 8000);

    input.once('data', () => {
      gotData = true;
      clearTimeout(watchdog);
      console.log('Audio stream started.');
    });

    const oggOut = ffmpegFromReadable(input);
    const resource = createAudioResource(oggOut, {
      inputType: StreamType.OggOpus
    });

    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    index = (index + 1) % Math.max(1, tracks.length);
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playCurrent().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5000);
  });
}

// ─── Voice Connection ─────────────────────────────────────────────────────────
async function ensureConnection() {
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
  if (!channel || channel.type !== 2) throw new Error('VOICE_CHANNEL_ID must be a voice channel.');

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: SELF_DEAFEN
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected — retrying…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        setTimeout(() => {
          try { connection?.destroy(); } catch {}
          connection = null;
          ensureConnection();
        }, REJOIN_DELAY_MS);
      }
    });

    connection.subscribe(player);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;

  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user?.tag}`);

  tracks = await resolvePlaylist(SC_PLAYLIST_URL);
  console.log(`Playlist resolved: ${tracks.length} tracks`);
  if (!tracks.length) throw new Error('Playlist has no tracks.');

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
