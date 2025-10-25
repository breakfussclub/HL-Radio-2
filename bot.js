require('dotenv').config();
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

const ffmpeg = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL, SC_CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL || !SC_CLIENT_ID) {
  console.error('❌ Missing env: DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL, SC_CLIENT_ID');
  process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SELF_DEAFEN = true;
const OPUS_BITRATE = '96k';
const HTTP_HEADERS = [
  'User-Agent: Mozilla/5.0 (DiscordRadio/1.0)',
  'Accept: */*',
];

// ─── DISCORD CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

let connection = null;
let trackUrls = [];
let idx = 0;

// ─── SCRAPE TRACKS ───────────────────────────────────────────────────────────
async function scrapePlaylistTracks(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading playlist page`);
  const html = await res.text();

  const regex = /"permalink_url":"(https:\/\/soundcloud\.com\/[^"]+)"/g;
  const raw = [];
  for (const m of html.matchAll(regex)) {
    raw.push(m[1].replace(/\\u002F/g, '/'));
  }
  const tracks = raw.filter(u =>
    /^https:\/\/soundcloud\.com\/[^/]+\/[^/]+$/.test(u) && !u.includes('/sets/')
  );
  return [...new Set(tracks)];
}

// ─── API HELPERS ─────────────────────────────────────────────────────────────
async function scResolve(url) {
  const api = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${encodeURIComponent(SC_CLIENT_ID)}`;
  const r = await fetch(api, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Resolve failed: HTTP ${r.status}`);
  return await r.json();
}

async function scMedia(trackId) {
  const api = `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}?client_id=${encodeURIComponent(SC_CLIENT_ID)}`;
  const r = await fetch(api, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Media failed: HTTP ${r.status}`);
  return await r.json();
}

async function getStreamUrlForTrack(trackPageUrl) {
  const resolved = await scResolve(trackPageUrl);
  const id = resolved?.id || resolved?.track?.id;
  if (!id) throw new Error('No track id from resolve');

  const media = await scMedia(id);
  const trans = media?.transcodings || [];
  let pick = trans.find(t => t.format?.protocol === 'progressive')
          || trans.find(t => t.format?.protocol === 'hls');
  if (!pick) throw new Error('No usable transcoding');

  const sig = pick.url.includes('?') ? `${pick.url}&client_id=${SC_CLIENT_ID}` : `${pick.url}?client_id=${SC_CLIENT_ID}`;
  const sr = await fetch(sig, { redirect: 'follow' });
  if (!sr.ok) throw new Error(`Signature fetch failed: HTTP ${sr.status}`);
  const data = await sr.json();
  if (!data?.url) throw new Error('No stream URL in signature response');
  return { url: data.url, hls: pick.format?.protocol === 'hls' };
}

// ─── FFMPEG PIPE ─────────────────────────────────────────────────────────────
function ffmpegToOggOpus(inputUrl) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-headers', HTTP_HEADERS.join('\r\n'),
    '-i', inputUrl,
    '-vn',
    '-ac', '2',
    '-ar', '48000',
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,
    '-f', 'ogg',
    'pipe:1'
  ];

  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log('[ffmpeg]', line);
  });
  return child.stdout;
}

// ─── PLAYBACK LOOP ───────────────────────────────────────────────────────────
async function playCurrent() {
  const pageUrl = trackUrls[idx % trackUrls.length];
  console.log(`▶️  Playing: ${pageUrl}`);

  try {
    const { url: streamUrl } = await getStreamUrlForTrack(pageUrl);
    const ogg = ffmpegToOggOpus(streamUrl);

    let got = false;
    const watchdog = setTimeout(() => {
      if (!got) {
        console.warn('No audio from ffmpeg in 8s — skipping');
        try { ogg.destroy(); } catch {}
        idx = (idx + 1) % trackUrls.length;
        setTimeout(loopPlay, 1500);
      }
    }, 8000);
    ogg.once('data', () => { got = true; clearTimeout(watchdog); console.log('Audio started ✅'); });

    const resource = createAudioResource(ogg, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    idx = (idx + 1) % trackUrls.length;
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
  idx = (idx + 1) % trackUrls.length;
  setTimeout(loopPlay, 1500);
});

player.on('error', err => {
  console.error('AudioPlayer error:', err?.message || err);
  idx = (idx + 1) % trackUrls.length;
  setTimeout(loopPlay, 2000);
});

// ─── VOICE ───────────────────────────────────────────────────────────────────
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

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await sodium.ready;
  await client.login(DISCORD_TOKEN);
  console.log(`✅ Logged in as ${client.user.tag}`);

  trackUrls = await scrapePlaylistTracks(SC_PLAYLIST_URL);
  console.log(`✅ Playlist loaded (${trackUrls.length} tracks)`);

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
