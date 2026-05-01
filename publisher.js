#!/usr/bin/env node
// publisher.js — Cloud version of Busy Adults Life Instagram publisher.
// Designed to run as a GitHub Actions cron job.
//
// Picks the NEXT unposted short from ./shorts/ (numeric prefix order: 1_, 2_, 3_, ...),
// generates a tailored caption + hashtags via Claude, uploads to tmpfiles.org,
// posts to Instagram as a Reel, and persists state.
//
// State file: .posted-shorts.json — committed back to repo by workflow.
// Dedup: Skips if last post was within 5h.
// Idempotent: Multiple runs in the same window do nothing extra.
//
// Env (GitHub Secrets in Actions, .env locally):
//   META_ACCESS_TOKEN  - Long-lived Meta user token (60 days)
//   IG_USER_ID         - Instagram Business Account ID (numeric)
//   ANTHROPIC_API_KEY  - For caption generation (optional — falls back to default text)
//
// Usage:
//   node publisher.js                  # post next unposted reel
//   node publisher.js --dry-run        # generate caption + upload but DON'T post
//   node publisher.js --force          # bypass 5h dedup guard
//   node publisher.js --status         # report status only

const fs   = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');

// dotenv is optional (only needed for local runs; GH Actions uses env directly)
try { require('dotenv').config({ override: true }); } catch {}

const TOKEN  = process.env.META_ACCESS_TOKEN;
const IG_ID  = process.env.IG_USER_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GRAPH  = 'https://graph.facebook.com/v22.0';
const TMPFILES_LIMIT_MB = 100;
const COMPRESS_THRESHOLD_MB = 80;
const DEDUP_HOURS = 5;

const SHORTS_DIR = path.join(__dirname, 'shorts');
const STATE_FILE = path.join(__dirname, '.posted-shorts.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');
const STATUS  = args.includes('--status');

if (!STATUS && (!TOKEN || !IG_ID)) {
  console.error('❌ Missing META_ACCESS_TOKEN or IG_USER_ID. Set as GitHub Secrets.');
  process.exit(1);
}

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (icon, msg) => console.log(`[${ts()}] ${icon} ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { posted: [], log: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function request(url, opts = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request(reqOpts, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), opts, redirectsLeft - 1));
      }
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs || 600_000, () => req.destroy(new Error(`Timeout ${url}`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const getJson  = async url => JSON.parse((await request(url)).body.toString());
const postForm = async (url, params) => {
  const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return JSON.parse((await request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).body.toString());
};

// ─── ffmpeg compression (only if file > 80MB) ───────────────────────────────
function compressForReels(srcPath) {
  const sizeMb = fs.statSync(srcPath).size / (1024 * 1024);
  if (sizeMb <= COMPRESS_THRESHOLD_MB) return srcPath;

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'badl_compress_'));
  const out = path.join(outDir, `compressed_${path.basename(srcPath)}`);
  log('  ', `Compressing ${Math.round(sizeMb)}MB → 1080p H.264 CRF 23...`);
  execSync(`ffmpeg -y -hide_banner -loglevel error -i "${srcPath}" -vf scale=1080:-2 -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "${out}"`, { stdio: 'inherit' });
  log('  ', `Compressed to ${Math.round(fs.statSync(out).size/1024/1024)}MB`);
  return out;
}

// ─── tmpfiles.org upload ─────────────────────────────────────────────────────
async function uploadToTmpfiles(localPath) {
  const compressed = compressForReels(localPath);
  const sizeMb = fs.statSync(compressed).size / (1024 * 1024);
  if (sizeMb > TMPFILES_LIMIT_MB) throw new Error(`File ${sizeMb.toFixed(1)}MB > ${TMPFILES_LIMIT_MB}MB limit`);

  const boundary = '----badl' + crypto.randomBytes(8).toString('hex');
  const filename = path.basename(compressed).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileBuf = fs.readFileSync(compressed);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: video/mp4\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, fileBuf, tail]);

  log('  ', `tmpfiles.org upload (${Math.round(fileBuf.length/1024/1024)} MB)...`);
  const res = await request('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    timeoutMs: 900_000,
  });
  let json;
  try { json = JSON.parse(res.body.toString()); }
  catch { throw new Error(`tmpfiles non-JSON (${res.status}): ${res.body.toString().slice(0,300)}`); }
  if (json.status !== 'success' || !json.data?.url) throw new Error(`tmpfiles upload failed: ${JSON.stringify(json).slice(0,400)}`);
  let directUrl = json.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
  if (directUrl.startsWith('http://')) directUrl = 'https://' + directUrl.slice(7);
  return directUrl;
}

// ─── Instagram Graph API ─────────────────────────────────────────────────────
async function createReelContainer(videoUrl, caption) {
  const res = await postForm(`${GRAPH}/${IG_ID}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: caption || '',
    share_to_feed: 'true',
    access_token: TOKEN,
  });
  if (res.error) throw new Error(`Container create failed: ${JSON.stringify(res.error)}`);
  return res.id;
}

async function pollContainerStatus(containerId, maxWaitMs = 600_000, pollEveryMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const r = await getJson(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${TOKEN}`);
    if (r.status_code === 'FINISHED') return true;
    if (r.status_code === 'ERROR') throw new Error(`Container ERROR: ${r.status || JSON.stringify(r)}`);
    if (r.status_code === 'EXPIRED') throw new Error(`Container EXPIRED`);
    log('  ⏳', `status=${r.status_code} (${Math.round((Date.now()-start)/1000)}s)`);
    await sleep(pollEveryMs);
  }
  throw new Error(`Container poll timeout after ${maxWaitMs/1000}s`);
}

async function publishContainer(containerId) {
  const res = await postForm(`${GRAPH}/${IG_ID}/media_publish`, { creation_id: containerId, access_token: TOKEN });
  if (res.error) throw new Error(`Publish failed: ${JSON.stringify(res.error)}`);
  return res.id;
}

async function getPermalink(mediaId) {
  try { return (await getJson(`${GRAPH}/${mediaId}?fields=permalink&access_token=${TOKEN}`)).permalink; }
  catch { return null; }
}

// ─── Caption gen via Claude ──────────────────────────────────────────────────
async function genCaption(filename) {
  const topic = filename
    .replace(/^\d+_/, '')
    .replace(/\.mp4$/i, '')
    .replace(/_/g, ' ')
    .replace(/short-ep\d+-\d+-/i, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!ANTHROPIC_KEY) {
    return `${topic}\n\n#busylife #adulting #worklifebalance #realtalk #burnout #adulthood #relatable #adultlife`;
  }

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch { return `${topic}\n\n#busylife #adulting #worklifebalance #realtalk`; }

  const ai = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const prompt = `Write an Instagram Reel caption for the channel "Busy Adults Life" (sarcastic, witty, brutally honest content for tired adults trying to keep their lives together).

Reel topic / hook: "${topic}"

Format requirements:
- Hook line: 1 punchy sentence that mirrors the video's opening, makes the viewer feel SEEN (not preachy)
- Body: 2-3 short sentences that twist the knife / add the sarcastic insight (max 150 chars total in body)
- 1 question at the end to drive comments (relatable, not generic)
- 8-12 hashtags (mix: 3-4 broad #adulting #busylife #burnout, 4-6 niche topic-specific, 1-2 community ones like #realtalk #relatable)
- NO emojis at start. 1-2 emojis max in body, only if they add humor.
- Tone: stand-up comic friend, NOT motivational coach. Short, punchy, real.
- NO "swipe up" / "link in bio" / "tag someone" generic CTAs.

Return ONLY the caption text. No preamble, no explanation, no quotes around it.`;

  const r = await ai.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  return r.content[0].text.trim();
}

// ─── Listing ─────────────────────────────────────────────────────────────────
function listShorts() {
  if (!fs.existsSync(SHORTS_DIR)) return [];
  return fs.readdirSync(SHORTS_DIR)
    .filter(f => f.toLowerCase().endsWith('.mp4'))
    .filter(f => /^\d+_/.test(f))
    .sort((a, b) => parseInt(a.match(/^(\d+)_/)[1]) - parseInt(b.match(/^(\d+)_/)[1]));
}
function nextUnposted(state) {
  for (const f of listShorts()) if (!state.posted.includes(f)) return f;
  return null;
}
function alreadyPostedRecently(state) {
  if (!state.log?.length) return null;
  const last = state.log[state.log.length - 1];
  const ageMs = Date.now() - new Date(last.timestamp).getTime();
  return ageMs < DEDUP_HOURS * 60 * 60 * 1000 ? last : null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const state = loadState();
  const all = listShorts();

  if (STATUS) {
    console.log(`Total: ${all.length} | Posted: ${state.posted.length} | Remaining: ${all.length - state.posted.length}`);
    const next = nextUnposted(state);
    console.log(`Next: ${next || '(all done)'}`);
    if (state.log?.length) {
      const last = state.log[state.log.length - 1];
      console.log(`Last: ${last.file} at ${last.timestamp} → ${last.permalink || last.mediaId}`);
    }
    return;
  }

  log('🚀', `cloud publisher start (dry=${DRY_RUN}, force=${FORCE})`);
  log('📋', `State: ${state.posted.length}/${all.length} posted`);

  const recent = alreadyPostedRecently(state);
  if (recent && !FORCE) {
    log('🟡', `Last post within ${DEDUP_HOURS}h: ${recent.file} at ${recent.timestamp}. Skipping.`);
    return;
  }

  const nextFile = nextUnposted(state);
  if (!nextFile) { log('🎉', 'All shorts posted! Add more MP4s to ./shorts/ to continue.'); return; }
  log('📦', `Next file: ${nextFile}`);

  const localPath = path.join(SHORTS_DIR, nextFile);
  if (!fs.existsSync(localPath)) { log('❌', `File not found: ${localPath}`); process.exit(1); }
  log('  ', `Size: ${Math.round(fs.statSync(localPath).size/1024/1024)} MB`);

  log('✍️ ', 'Generating caption via Claude...');
  const caption = await genCaption(nextFile);
  console.log('\n────── CAPTION ──────');
  console.log(caption);
  console.log('─────────────────────\n');

  log('⬆️ ', 'Uploading to tmpfiles.org...');
  const publicUrl = await uploadToTmpfiles(localPath);
  log('🔗', `Public URL: ${publicUrl.slice(0, 80)}...`);

  if (DRY_RUN) { log('🟡', 'Dry-run — caption + upload validated. Not posting.'); return; }

  log('📤', 'Creating IG Reel container...');
  const containerId = await createReelContainer(publicUrl, caption);
  log('🆔', `Container: ${containerId}`);

  log('⏳', 'Polling status (Reels typically 30-90s)...');
  await pollContainerStatus(containerId);
  log('✅', 'Container FINISHED');

  log('🚀', 'Publishing...');
  const mediaId = await publishContainer(containerId);
  log('🎉', `Published! Media ID: ${mediaId}`);

  await sleep(2000);
  const permalink = await getPermalink(mediaId);
  if (permalink) log('🔗', `URL: ${permalink}`);

  state.posted.push(nextFile);
  state.log = state.log || [];
  state.log.push({ file: nextFile, timestamp: new Date().toISOString(), mediaId, permalink, caption });
  saveState(state);
  log('💾', `State updated. ${state.posted.length}/${all.length} posted total.`);
})().catch(e => {
  log('❌', e.stack || e.message);
  process.exit(1);
});
