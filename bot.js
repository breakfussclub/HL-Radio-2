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
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ─── Env ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SELF_DEAFEN = true;
const BITRATE = '96k';

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let playlist = [];
let index = 0;
let connection = null;

// ─── Step 1: Extract Track URLs from SoundCloud HTML ─────────────────────────
async function scrapePlaylistTracks(url) {
  const page = await (await fetch(url)).text();
  const regex = /"permalink_url":"(https:\/\/soundcloud\.com\/[^"]+)"/g;
  const matches = [...page.matchAll(regex)].map(m => m[1].replace(/\\u002F/g, '/'));
  const unique = [...new Set(matches)];
  return unique;
}

// ─── FFmpeg Helper ────────────────────────────────────────────────────────────
function ffmpegOggOpus(input) {
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
  input.on('error', e => console.error('Input stream error:', e?.message || e));
  input.pipe(child.stdin);
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });
  return child.stdout;
}

// ─── Playback Loop ────────────────────────────────────────────────────────────
async function playTrack() {
  const url = playlist[index % playlist.length];
  console.log(`▶️  Now Playing: ${url}`);

  try {
    const source = await play.stream(url, { discordPlayerCompatibility: false });
    const oggOut = ffmpegOggOpus(source.stream);
    const resource = createAudioResource(oggOut, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    index++;
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playTrack().catch(err => {
    console.error('Loop error:', err?.message || err);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  index++;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  index++;
  setTimeout(loopPlay, 2000);
});

// ─── Voice Connection ─────────────────────────────────────────────────────────
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  playlist = await scrapePlaylistTracks(SC_PLAYLIST_URL);
  console.log(`Playlist loaded (${playlist.length} tracks)`);
  if (!playlist.length) throw new Error('Playlist has 0 tracks after scrape.');

  await ensureConnection();
  loopPlay();
}

main().catch(err => console.error(err));
