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
const BITRATE = '96k';

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let playlist = [];
let index = 0;
let connection = null;

// ─── FFmpeg Helper ───────────────────────────────────────────────────────────
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
  input.pipe(child.stdin);
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });
  return child.stdout;
}

// ─── PLAYBACK LOOP ───────────────────────────────────────────────────────────
async function playTrack() {
  const track = playlist[index % playlist.length];
  console.log(`▶️  Now Playing: ${track.name}`);

  try {
    const source = await play.stream(track.url);
    const oggOut = ffmpegOggOpus(source.stream);
    const resource = createAudioResource(oggOut, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err);
    index++;
    setTimeout(loopPlay, 2000);
  }
}

function loopPlay() {
  playTrack().catch(err => {
    console.error('Loop error:', err);
    setTimeout(loopPlay, 5000);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  index++;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err);
  index++;
  setTimeout(loopPlay, 2000);
});

// ─── VOICE CONNECTION ────────────────────────────────────────────────────────
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

// ─── BOOT ────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  // AUTH STEP — THIS IS THE FIX
  const clientID = await play.getFreeClientID();
  play.setToken({ soundcloud: { client_id: clientID }});

  const pl = await play.playlist_info(SC_PLAYLIST_URL, { incomplete: true });
  playlist = pl.all_tracks();
  console.log(`✅ Playlist loaded: ${playlist.length} tracks`);

  await ensureConnection();
  loopPlay();
}

main().catch(err => console.error(err));
