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

// ─── Env ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('Missing env. Set DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SELF_DEAFEN = true;
const BITRATE = '96k'; // could be '64k' to reduce bandwidth

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

// ─── Playback ─────────────────────────────────────────────────────────────────
async function playTrack() {
  const track = playlist[index % playlist.length];
  console.log(`▶️  Now Playing: ${track.title}`);

  try {
    const source = await play.stream(track.url, { discordPlayerCompatibility: false });
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

  const scInfo = await play.playlist_info(SC_PLAYLIST_URL, { incomplete: true });
  playlist = scInfo.all_tracks().map(t => ({ title: t.name, url: t.url }));
  console.log(`Playlist loaded (${playlist.length} tracks)`);

  await ensureConnection();
  loopPlay();
}

main().catch(err => console.error(err));
