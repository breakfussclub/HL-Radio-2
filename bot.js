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
const { chromium } = require('playwright-chromium');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL } = process.env;
if (!DISCORD_TOKEN || !VOICE_CHANNEL_ID || !SC_PLAYLIST_URL) {
  console.error('❌ Missing env: DISCORD_TOKEN, VOICE_CHANNEL_ID, SC_PLAYLIST_URL');
  process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SELF_DEAFEN = true;
const OPUS_BITRATE = '96k'; // Use '64k' to cut bandwidth ~35–45%
const HTTP_HEADERS = [
  'User-Agent: Mozilla/5.0 (DiscordRadio/1.0)',
  'Accept: */*',
];
const RESOLVE_TIMEOUT_MS = 15000; // time budget to sniff a playable URL on each track
const CACHE_TTL_MS = 30 * 60 * 1000; // cache stream URLs for 30 minutes

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

// ─── SCRAPE TRACKS (HTML → permalink URLs) ───────────────────────────────────
async function scrapePlaylistTracks(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading playlist page`);
  const html = await res.text();

  const regex = /"permalink_url":"(https:\/\/soundcloud\.com\/[^"]+)"/g;
  const raw = [];
  for (const m of html.matchAll(regex)) {
    raw.push(m[1].replace(/\\u002F/g, '/'));
  }
  // keep only track URLs (exclude /sets/)
  const tracks = raw.filter(u =>
    /^https:\/\/soundcloud\.com\/[^/]+\/[^/]+$/.test(u) && !u.includes('/sets/')
  );
  return [...new Set(tracks)];
}

// ─── PLAYWRIGHT (headless Chromium) ───────────────────────────────────────────
let browser, page;
async function ensureBrowser() {
  if (browser && page) return;
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-zygote',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--mute-audio'
    ]
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (DiscordRadio/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
    viewport: { width: 1200, height: 800 },
  });
  page = await context.newPage();

  // Save bandwidth: block images/fonts/ads
  await page.route('**/*', route => {
    const r = route.request();
    const type = r.resourceType();
    if (type === 'image' || type === 'font' || type === 'stylesheet') return route.abort();
    return route.continue();
  });
}

// Cache resolved stream URLs (m3u8/mp3) per track page
const urlCache = new Map(); // key: trackPageUrl, val: { url, ts }

async function resolvePlayableUrl(trackPageUrl) {
  const cache = urlCache.get(trackPageUrl);
  if (cache && (Date.now() - cache.ts) < CACHE_TTL_MS) return cache.url;

  await ensureBrowser();

  let foundUrl = null;
  const candidates = [];

  const onResponse = async (response) => {
    try {
      const u = response.url();
      if (!u) return;
      // Heuristics: sniff real audio playlist or progressive mp3
      if (/\.(m3u8)(\?.*)?$/i.test(u) || /\.mp3(\?.*)?$/i.test(u)) {
        candidates.push(u);
      } else {
        // Some CDNs hide behind query strings; check content-type
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('audio/mpeg')) {
          candidates.push(u);
        }
      }
    } catch {}
  };

  page.on('response', onResponse);

  // Navigate and wait a bit while the player initializes network requests
  await page.goto(trackPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Kick the player: click the big play button if present
  try {
    // Generic selector used in SC track pages
    const playBtn = page.locator('button[title="Play"]');
    if (await playBtn.count()) {
      await playBtn.first().click({ timeout: 3000 }).catch(() => {});
    }
  } catch {}

  await page.waitForTimeout(RESOLVE_TIMEOUT_MS);

  page.off('response', onResponse);

  // Pick best candidate: prefer .m3u8 then .mp3
  foundUrl = candidates.find(u => /\.m3u8/i.test(u)) || candidates.find(u => /\.mp3/i.test(u)) || null;

  if (!foundUrl) throw new Error('No playable URL sniffed from page');

  urlCache.set(trackPageUrl, { url: foundUrl, ts: Date.now() });
  return foundUrl;
}

// ─── FFMPEG PIPE: URL (HLS/MP3) → Opus (OGG) ─────────────────────────────────
function ffmpegToOggOpus(inputUrl) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    // robust network
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    // headers (some hosts care)
    '-headers', HTTP_HEADERS.join('\r\n'),
    // input
    '-i', inputUrl,
    '-vn',
    // Discord-friendly audio
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

// ─── PLAYBACK LOOP ────────────────────────────────────────────────────────────
async function playCurrent() {
  if (!trackUrls.length) {
    console.log('No tracks yet; retrying in 30s…');
    setTimeout(loopPlay, 30000);
    return;
  }

  const pageUrl = trackUrls[idx % trackUrls.length];
  console.log(`▶️  Resolving & Playing: ${pageUrl}`);

  try {
    const streamUrl = await resolvePlayableUrl(pageUrl);

    // Watchdog: ensure bytes start flowing
    const ogg = ffmpegToOggOpus(streamUrl);
    let got = false;
    const watchdog = setTimeout(() => {
      if (!got) {
        console.warn('No audio bytes from ffmpeg in 8s — skipping…');
        try { ogg.destroy(); } catch {}
        idx = (idx + 1) % trackUrls.length;
        setTimeout(loopPlay, 1500);
      }
    }, 8000);
    ogg.once('data', () => { got = true; clearTimeout(watchdog); console.log('Audio stream started.'); });

    const resource = createAudioResource(ogg, { inputType: StreamType.OggOpus });
    player.play(resource);
  } catch (err) {
    console.error('Playback error:', err?.message || err);
    idx = (idx + 1) % trackUrls.length; // skip failed
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

process.on('SIGTERM', async () => {
  try { await page?.close(); await browser?.close(); } catch {}
  try { connection?.destroy(); } catch {}
  process.exit(0);
});

main().catch(async (err) => {
  console.error('Fatal boot error:', err?.message || err);
  try { await page?.close(); await browser?.close(); } catch {}
  process.exit(1);
});
