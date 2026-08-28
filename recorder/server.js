// ── Global crash protection — never let an unhandled error kill the process ──
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (process kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (process kept alive):', reason);
});

const zlib = require('zlib');
const express = require('express');
const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const https = require('https');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const RECORDINGS_DIR = '/recordings';
const LOGOS_DIR = '/recordings/logos';
const STATIONS_FILE = '/recordings/stations.json';
const SETTINGS_FILE = '/recordings/settings.json';
const ADVERTISERS_FILE = '/recordings/advertisers.json';
const FINGERPRINTS_FILE = '/recordings/ad_fingerprints.json';
const MUSIC_FINGERPRINTS_FILE = '/recordings/music_fingerprints.json';

const audioDsp = require('./audio_dsp');
const transcriber = require('./transcriber');

// Load .env if present (zero-dependency)
try {
  const envPaths = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env')
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [k, ...v] = trimmed.split('=');
          const key = k.trim();
          if (key && !process.env[key]) process.env[key] = v.join('=').trim();
        }
      }
    }
  }
} catch (_) {}

let monitors = {};

// Ensure dirs exist
[RECORDINGS_DIR, LOGOS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Path validation helpers (prevent path traversal) ──────────────────────────

function safeRecordingPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(RECORDINGS_DIR, clean);
}

function safeLogoPath(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(LOGOS_DIR, clean);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(_) { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadStationsData() { return loadJSON(STATIONS_FILE, []); }
function saveStationsData(d) { saveJSON(STATIONS_FILE, d); }

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, req.params.station.replace(/[^a-zA-Z0-9_-]/g, '_') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ── Timestamp ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── HTTP fetch helpers ────────────────────────────────────────────────────────

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  url = url.trim();

  // Strip markdown link corruption patterns:
  // "...&eventType=track](https://np.tritondigital..." -> truncate at ](
  // "...?callback=jsonpcallback](https://..." -> truncate at ](
  const mdLinkIdx = url.indexOf('](');
  if (mdLinkIdx > 0) {
    url = url.substring(0, mdLinkIdx);
  }

  // Strip any trailing markdown or bracket artifacts
  url = url.replace(/[\[\]<>"]/g, '');

  // Remove &eventType=track from Triton URLs (causes empty response during ads)
  url = url.replace(/&eventType=track/g, '');

  // Fix duplicate mountName params: keep only the LAST one
  if ((url.match(/mountName=/gi) || []).length > 1) {
    const lastMount = url.match(/mountName=([A-Z0-9]+)(?:[^&]*)?$/i);
    if (lastMount) {
      const base = url.split('?')[0];
      const params = new URLSearchParams(url.split('?')[1] || '');
      params.set('mountName', lastMount[1]);
      url = base + '?' + params.toString();
    }
  }

  return url;
}

function httpGet(url, opts = {}) {
  url = sanitizeUrl(url);
  const maxRedirects = opts.maxRedirects !== undefined ? opts.maxRedirects : 5;
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Barracuda/2.0', 'Accept': 'application/json, */*', ...opts.headers }, timeout: opts.timeout || 8000 }, res => {
      // Follow HTTP redirects (cdnstream/Futuri edges redirect to load-balanced nodes)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume(); // drain
        let next = res.headers.location;
        try { next = new URL(next, url).href; } catch(_) {}
        return resolve(httpGet(next, { ...opts, maxRedirects: maxRedirects - 1 }));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        let rawBuf = Buffer.concat(chunks);
        // Decompress if gzip/deflate encoded
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip')      rawBuf = zlib.gunzipSync(rawBuf);
          else if (enc === 'deflate') rawBuf = zlib.inflateSync(rawBuf);
          else if (enc === 'br')   rawBuf = zlib.brotliDecompressSync(rawBuf);
        } catch(e) { /* not actually compressed, use raw */ }
        const body = opts.binary ? rawBuf : rawBuf.toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}


// ── Bell Media station registry ───────────────────────────────────────────────
// Keyed by callsign (no hyphen, uppercase) → station info
// Metadata via Triton Digital: np.tritondigital.com/public/nowplaying?mountName=CALLSIGN
const BELL_STATIONS = {
  'CKXFM':  { city: 'Brandon, MB',       brand: 'Bounce 96.1',          network: 'Bounce' },
  'CKXAFM': { city: 'Brandon, MB',       brand: 'Pure Country 101',      network: 'Pure Country' },
  'CIBKFM': { city: 'Calgary, AB',       brand: '98.5 Virgin Radio',     network: 'Virgin Radio' },
  'CJAYFM': { city: 'Calgary, AB',       brand: 'CJAY 92',              network: 'Bell' },
  'CFBRFM': { city: 'Edmonton, AB',      brand: '100.3 The Bear',        network: 'Bell' },
  'CFMGFM': { city: 'Edmonton, AB',      brand: '104.9 Virgin Radio',    network: 'Virgin Radio' },
  'CKHJ':   { city: 'Fredericton, NB',   brand: 'Pure Country 103.5',    network: 'Pure Country' },
  'CFXYFM': { city: 'Fredericton, NB',   brand: 'Bounce 105.3',         network: 'Bounce' },
  'CIBXFM': { city: 'Fredericton, NB',   brand: 'Move 106.9',           network: 'Move Radio' },
  'CIMFFM': { city: 'Gatineau, QC',      brand: '94.9 Rouge',           network: 'Rouge FM' },
  'CKTFFM': { city: 'Gatineau, QC',      brand: 'Énergie 104.1',        network: 'Énergie' },
  'CJCHFM': { city: 'Halifax, NS',       brand: '101.3 Virgin Radio',    network: 'Virgin Radio' },
  'CIOOFM': { city: 'Halifax, NS',       brand: 'Move 100',             network: 'Move Radio' },
  'CKKWFM': { city: 'Kitchener, ON',     brand: 'Bounce 99.5',          network: 'Bounce' },
  'CFCAFM': { city: 'Kitchener, ON',     brand: '105.3 Virgin Radio',    network: 'Virgin Radio' },
  'CIQMFM': { city: 'London, ON',        brand: '97.5 Virgin Radio',     network: 'Virgin Radio' },
  'CJBXFM': { city: 'London, ON',        brand: 'Pure Country 93',      network: 'Pure Country' },
  'CIMOFM': { city: 'Magog, QC',         brand: 'Énergie 106.1',        network: 'Énergie' },
  'CICZFM': { city: 'Midland, ON',       brand: 'Bounce 104.1',         network: 'Bounce' },
  'CKGM':   { city: 'Montreal, QC',      brand: 'TSN 690',              network: 'TSN Radio' },
  'CJAD':   { city: 'Montreal, QC',      brand: 'CJAD 800',             network: 'Bell' },
  'CHOMFM': { city: 'Montreal, QC',      brand: 'CHOM 97.7',            network: 'Bell' },
  'CJFMFM': { city: 'Montreal, QC',      brand: '95.9 Virgin Radio',     network: 'Virgin Radio' },
  'CKMFFM': { city: 'Montreal, QC',      brand: 'Énergie 94.3',         network: 'Énergie' },
  'CITEFM': { city: 'Montreal, QC',      brand: '107.3 Rouge',          network: 'Rouge FM' },
  'CICXFM': { city: 'Orillia, ON',       brand: 'Pure Country 106',     network: 'Pure Country' },
  'CFRA':   { city: 'Ottawa, ON',        brand: '580 CFRA',             network: 'Bell' },
  'CFGO':   { city: 'Ottawa, ON',        brand: 'TSN 1200',             network: 'TSN Radio' },
  'CKKLFM': { city: 'Ottawa, ON',        brand: 'Pure Country 94',      network: 'Pure Country' },
  'CJMJFM': { city: 'Ottawa, ON',        brand: 'Move 100.3',           network: 'Move Radio' },
  'CHVRFM': { city: 'Pembroke, ON',      brand: 'Pure Country 96.7',    network: 'Pure Country' },
  'CHIKFM': { city: 'Quebec City, QC',   brand: 'Énergie 98.9',         network: 'Énergie' },
  'CITFFM': { city: 'Quebec City, QC',   brand: '107.5 Rouge',          network: 'Rouge FM' },
  'CHBDFM': { city: 'Regina, SK',        brand: 'Pure Country 92.7',    network: 'Pure Country' },
  'CJMMFM': { city: 'Rouyn-Noranda, QC', brand: 'Énergie 99.1',        network: 'Énergie' },
  'CFIXFM': { city: 'Saguenay, QC',      brand: '96.9 Rouge',           network: 'Rouge FM' },
  'CJABFM': { city: 'Saguenay, QC',      brand: 'Énergie 94.5',        network: 'Énergie' },
  'CITEFM1':{ city: 'Sherbrooke, QC',    brand: '102.7 Rouge',          network: 'Rouge FM' },
  'CICSFM': { city: 'Sudbury, ON',       brand: 'Pure Country 91.7',    network: 'Pure Country' },
  'CFRB':   { city: 'Toronto, ON',       brand: 'Newstalk 1010',        network: 'Bell' },
  'CHUM':   { city: 'Toronto, ON',       brand: 'TSN 1050',             network: 'TSN Radio' },
  'CHUMFM': { city: 'Toronto, ON',       brand: 'CHUM 104.5',           network: 'Bell' },
  'CKFMFM': { city: 'Toronto, ON',       brand: '99.9 Virgin Radio',    network: 'Virgin Radio' },
  'CHEYFM': { city: 'Trois-Rivières, QC',brand: '94.7 Rouge',           network: 'Rouge FM' },
  'CIGBFM': { city: 'Trois-Rivières, QC',brand: 'Énergie 102.3',       network: 'Énergie' },
  'CJMVFM': { city: "Val-d'Or, QC",     brand: 'Énergie 102.7',       network: 'Énergie' },
  'CFBTFM': { city: 'Vancouver, BC',     brand: '94.5 Virgin Radio',    network: 'Virgin Radio' },
  'CHQMFM': { city: 'Vancouver, BC',     brand: 'Move 103.5',           network: 'Move Radio' },
  'CFAX':   { city: 'Victoria, BC',      brand: 'CFAX 1070',            network: 'Bell' },
  'CHBEFM': { city: 'Victoria, BC',      brand: '107.3 Virgin Radio',   network: 'Virgin Radio' },
  'CKLW':   { city: 'Windsor, ON',       brand: 'AM 800 CKLW',          network: 'Bell' },
  'CIDRFM': { city: 'Windsor, ON',       brand: '93.9 Virgin Radio',    network: 'Virgin Radio' },
  'CIMXFM': { city: 'Windsor, ON',       brand: '89X',                  network: 'Bell' },
  'CFWMFM': { city: 'Winnipeg, MB',      brand: 'Bounce 99.9',          network: 'Bounce' },
  'CKMMFM': { city: 'Winnipeg, MB',      brand: '103.1 Virgin Radio',   network: 'Virgin Radio' },
};

function normCallsign(cs) {
  return cs.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function lookupBellStation(callsign) {
  const norm = normCallsign(callsign);
  return BELL_STATIONS[norm] || null;
}

function tritonMetaUrl(callsign) {
  const norm = normCallsign(callsign);
  return `https://np.tritondigital.com/public/nowplaying?mountName=${norm}&numberToFetch=1`;
}

function bellStreamUrl(callsign) {
  const norm = normCallsign(callsign);
  return `https://playerservices.streamtheworld.com/api/livestream-redirect/${norm}_ADP.m3u8`;
}


// ── Corus Entertainment station registry ──────────────────────────────────────
// Stream: https://corus.leanstream.co/CALLSIGN?args=web_01
// Metadata: https://globalnewselection.s3.amazonaws.com/fm-playlist/results/CALLSIGN_np.js?callback=jsonpcallback
const CORUS_STATIONS = {
  'CHAYFM':  { city: 'Barrie, ON',       brand: 'Fresh Radio 93.1',        network: 'Corus' },
  'CIQBFM':  { city: 'Barrie, ON',       brand: 'Big 101',                 network: 'Corus' },
  'CFNYFM':  { city: 'Brampton, ON',     brand: '102.1 The Edge',          network: 'Corus' },
  'CJXYFM':  { city: 'Burlington, ON',   brand: 'Y108',                    network: 'Corus' },
  'CFGQFM':  { city: 'Calgary, AB',      brand: '107.3 The Edge',          network: 'Corus' },
  'CHQR':    { city: 'Calgary, AB',      brand: 'QR Calgary',              network: 'Corus' },
  'CKRYFM':  { city: 'Calgary, AB',      brand: 'Country 105',             network: 'Corus' },
  'CKCBFM':  { city: 'Collingwood, ON',  brand: 'The Peak 95.1',           network: 'Corus' },
  'CFLGFM':  { city: 'Cornwall, ON',     brand: 'Fresh Radio 104.5',       network: 'Corus' },
  'CJSSFM':  { city: 'Cornwall, ON',     brand: 'Boom 101.9',              network: 'Corus' },
  'CHED':    { city: 'Edmonton, AB',     brand: '880 CHED',                network: 'Corus' },
  'CKNGFM':  { city: 'Edmonton, AB',     brand: 'Chuck @ 92.5',            network: 'Corus' },
  'CISNFM':  { city: 'Edmonton, AB',     brand: '103.9 CISN Country',      network: 'Corus' },
  'CIMJFM':  { city: 'Guelph, ON',       brand: 'Magic 106.1',             network: 'Corus' },
  'CJOY':    { city: 'Guelph, ON',       brand: '1460 CJOY',               network: 'Corus' },
  'CINGFM':  { city: 'Hamilton, ON',     brand: 'Energy 95.3',             network: 'Corus' },
  'CFMKFM':  { city: 'Kingston, ON',     brand: 'Big 96.3',                network: 'Corus' },
  'CKWSFM':  { city: 'Kingston, ON',     brand: 'Fresh Radio 104.3',       network: 'Corus' },
  'CJDVFM':  { city: 'Kitchener, ON',    brand: '107.5 Dave Rocks',        network: 'Corus' },
  'CKBTFM':  { city: 'Kitchener, ON',    brand: 'The Beat 91.5',           network: 'Corus' },
  'CFPL':    { city: 'London, ON',       brand: '980 CFPL',                network: 'Corus' },
  'CFPLFM':  { city: 'London, ON',       brand: 'FM 96',                   network: 'Corus' },
  'CJOTFM':  { city: 'Ottawa, ON',       brand: 'Boom 99.7',               network: 'Corus' },
  'CKQBFM':  { city: 'Ottawa, ON',       brand: 'Jump 106.9',              network: 'Corus' },
  'CKRUFM':  { city: 'Peterborough, ON', brand: 'Fresh Radio 100.5',       network: 'Corus' },
  'CKWFFM':  { city: 'Peterborough, ON', brand: 'The Wolf 101.5',          network: 'Corus' },
  'CFHKFM':  { city: 'St. Thomas, ON',   brand: 'Fresh Radio 103.1',       network: 'Corus' },
  'CFIQ':    { city: 'Toronto, ON',      brand: '640 Toronto',             network: 'Corus' },
  'CILQFM':  { city: 'Toronto, ON',      brand: 'Q107',                    network: 'Corus' },
  'CFMIFM':  { city: 'Vancouver, BC',    brand: 'Rock 101',                network: 'Corus' },
  'CFOXFM':  { city: 'Vancouver, BC',    brand: 'The World Famous CFOX',   network: 'Corus' },
  'CKNW':    { city: 'Vancouver, BC',    brand: '730 CKNW',                network: 'Corus' },
  'CJKRFM':  { city: 'Winnipeg, MB',     brand: 'Power 97',                network: 'Corus' },
  'CJOB':    { city: 'Winnipeg, MB',     brand: '680 CJOB',                network: 'Corus' },
  'CFPGFM':  { city: 'Winnipeg, MB',     brand: 'Country 99',              network: 'Corus' },
  'CKDKFM':  { city: 'Woodstock, ON',    brand: 'Country 104',             network: 'Corus' },
};

function lookupCorusStation(callsign) {
  const norm = normCallsign(callsign);
  return CORUS_STATIONS[norm] || null;
}

function corusStreamUrl(callsign) {
  const norm = normCallsign(callsign);
  return `https://corus.leanstream.co/${norm}?args=web_01`;
}

function corusMetaUrl(callsign) {
  const norm = normCallsign(callsign);
  return `https://globalnewselection.s3.amazonaws.com/fm-playlist/results/${norm}_np.js?callback=jsonpcallback`;
}

// ── Rogers nowplaying ─────────────────────────────────────────────────────────

async function fetchRogersMetadata(callsign) {
  try {
    const res = await httpGet('https://radio.rogersdigitalmedia.com/service/now_playing');
    const stations = JSON.parse(res.body);
    const cs = callsign.toUpperCase().replace(/FM$|AM$/, ''); // strip suffix for matching
    const station = Array.isArray(stations)
      ? stations.find(s => {
          const cl = (s.call_letters || '').toUpperCase().replace(/FM$|AM$/, '');
          return cl === cs || cl === callsign.toUpperCase();
        })
      : null;
    if (!station) { console.log('[rogers] callsign not found:', callsign); return { title: null, station: callsign, raw: '' }; }
    const np = station.now_playing || {};
    // Rogers now_playing has: title, artist, album, image:{full:{src}, thumbnail:{src}}
    const artist = np.artist || '';
    const title  = np.title  || '';
    const combined = artist && title ? `${artist} - ${title}` : (title || artist || null);
    let albumart = null;
    if (np.image) {
      albumart = (np.image.full && np.image.full.src) || (np.image.thumbnail && np.image.thumbnail.src) || null;
    }
    return { title: combined, artist, songTitle: title, albumart, station: callsign, isJson: true };
  } catch(e) { console.error('[rogers]', e.message); return { title: null, station: callsign, raw: '' }; }
}

// ── JSON now-playing fetch ────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const bust = `${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const req = lib.get(url + bust, { headers: { 'User-Agent': 'Barracuda/2.0', 'Accept': 'application/json' }, timeout: 6000 }, res => {
      let body = '';
      res.on('data', d => body += d.toString());
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(_) { reject(new Error('not json')); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── ICY stream metadata ───────────────────────────────────────────────────────

function fetchIcyMetadata(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'Barracuda/2.0' }, timeout: 8000 }, res => {
      const metaInt = parseInt(res.headers['icy-metaint'] || '0');
      const stationName = res.headers['icy-name'] || '';
      if (!metaInt) { req.destroy(); return resolve({ title: stationName || null, station: stationName, raw: '' }); }
      let bytesRead = 0, metaBuffer = Buffer.alloc(0), inMeta = false, metaLen = 0, metaBytesRead = 0;
      res.on('data', chunk => {
        let offset = 0;
        while (offset < chunk.length) {
          if (!inMeta) {
            const audioBytes = Math.min(metaInt - bytesRead, chunk.length - offset);
            bytesRead += audioBytes; offset += audioBytes;
            if (bytesRead >= metaInt) { bytesRead = 0; inMeta = true; if (offset < chunk.length) { metaLen = chunk[offset] * 16; offset++; metaBytesRead = 0; metaBuffer = Buffer.alloc(0); } }
          } else {
            if (metaLen === 0) { inMeta = false; continue; }
            const take = Math.min(metaLen - metaBytesRead, chunk.length - offset);
            metaBuffer = Buffer.concat([metaBuffer, chunk.slice(offset, offset + take)]);
            metaBytesRead += take; offset += take;
            if (metaBytesRead >= metaLen) {
              const metaStr = metaBuffer.toString('utf8').replace(/\0/g, '');
              const match = metaStr.match(/StreamTitle='([^']*)'/);
              req.destroy();
              return resolve({ title: match ? match[1].trim() : null, station: stationName, raw: metaStr });
            }
          }
        }
      });
      res.on('error', () => resolve({ title: null, station: stationName, raw: '' }));
      setTimeout(() => { req.destroy(); resolve({ title: null, station: stationName, raw: '' }); }, 6000);
    });
    req.on('error', () => resolve({ title: null, station: null, raw: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ title: null, station: null, raw: '' }); });
  });
}

// ── iHeart stream ID resolver (cached) ───────────────────────────────────────
const _iheartIdCache = {};
async function resolveIHeartId(callsign, brand) {
  const key = (callsign || brand || '').toUpperCase();
  if (!key) return null;
  if (_iheartIdCache[key] !== undefined) return _iheartIdCache[key];
  try {
    // iHeart search API — find station by callsign or name
    const q = encodeURIComponent(callsign ? callsign.replace(/(FM|AM)$/i,'') : brand);
    const url = 'https://ca.api.iheart.com/api/v3/search/all?keywords=' + q + '&maxRows=10&bundle=false&keyword=true';
    const res = await httpGet(url, { timeout: 5000 });
    const data = JSON.parse(res.body);
    const stations = (data.results && data.results.stations) || [];
    console.log('[iheart-resolve] search "' + q + '" returned', stations.length, 'stations');
    if (stations.length) {
      // Prefer exact callsign match
      const csNorm = (callsign||'').replace(/[^A-Z0-9]/gi,'').toUpperCase().replace(/(FM|AM)$/,'');
      const match = stations.find(s => {
        const sCall = (s.callLetters || '').replace(/[^A-Z0-9]/gi,'').toUpperCase().replace(/(FM|AM)$/,'');
        return sCall === csNorm;
      }) || stations[0];
      const id = match.id || match.streamId || null;
      console.log('[iheart-resolve]', key, '->', id, '(' + (match.name||match.callLetters) + ')');
      _iheartIdCache[key] = id;
      return id;
    }
  } catch(e) { console.error('[iheart-resolve]', e.message); }
  _iheartIdCache[key] = null;
  return null;
}

async function fetchIHeartMeta(streamId) {
  if (!streamId) return { title: null };
  try {
    const url = 'https://ca.api.iheart.com/api/v3/live-meta/stream/' + streamId + '/currentTrackMeta';
    const res = await httpGet(url, { timeout: 5000 });
    if (!res.body || !res.body.trim()) return { title: null };
    const data = JSON.parse(res.body);
    const track = data.currentTrack || data.track || data;
    const artist = track.artistName || track.artist || '';
    const title  = track.title || track.trackTitle || '';
    const combined = artist && title ? artist + ' - ' + title : (title || artist || null);
    const albumart = track.imagePath ? 'https://i.iheart.com/v3/re/' + track.imagePath : null;
    if (combined) return { title: combined, artist, songTitle: title, albumart, isJson: true };
  } catch(e) { console.error('[iheart-meta]', e.message); }
  return { title: null };
}

// ── Main metadata dispatcher ─────────────────────────────────────────────────
async function fetchMetadata(url, metadataSource, callsign, network) {
  console.log('[fetchMetadata]', { source: metadataSource, network, callsign, url: (url||'').substring(0,60) });
  const net = (network || '').toLowerCase();

  // Rogers — match by callsign in the now_playing array
  if (net === 'rogers' && callsign) {
    return fetchRogersMetadata(callsign);
  }

  // Triton Digital (Bell) — XML format
  if (metadataSource === 'triton' || (url && url.includes('tritondigital'))) {
    console.log('[fetchMetadata] -> triton');
    try {
      const res = await httpGet(url);
      const body = res.body;
      const typeMatch = body.match(/type="([^"]+)"/);
      const cueType = typeMatch ? typeMatch[1].toLowerCase() : 'track';
      const getProp = (name) => {
        const marker = 'name="' + name + '"';
        const mi = body.indexOf(marker);
        if (mi < 0) return '';
        const start = body.indexOf('>', mi) + 1;
        const end = body.indexOf('</property>', start);
        if (start < 1 || end < 0) return '';
        return body.substring(start, end).replace('<![CDATA[', '').replace(']]>', '').trim();
      };
      const title  = getProp('cue_title') || getProp('track_title') || '';
      const artist = getProp('track_artist_name') || getProp('artist_name') || '';
      const duration = parseInt(getProp('cue_time_duration') || '0');
      const combined = artist && title ? artist + ' - ' + title : (title || artist || null);
      const isAd = ['ad','break','spot','commercial'].includes(cueType);
      console.log('[triton]', cueType, '|', combined || '(none)');
      return { title: isAd ? null : combined, artist, songTitle: title, albumart: null,
               cueType, isAd, durationMs: duration, isJson: true };
    } catch(e) { console.error('[triton]', e.message); return { title: null }; }
  }

  // Corus JSONP
  if (metadataSource === 'corus-jsonp' || (url && url.includes('globalnewselection'))) {
    console.log('[fetchMetadata] -> corus-jsonp');
    try {
      const res = await httpGet(url);
      console.log('[corus-jsonp] body (first 150):', (res.body||'').substring(0,150));
      let raw = res.body.replace(/^\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/, '').replace(/\);?\s*$/, '').trim();
      const data = JSON.parse(raw);
      const obj = Array.isArray(data) ? data[0] : data;
      if (!obj) return { title: null };
      const artist = obj.artist_name || obj.ArtistName || obj.artist || '';
      const title  = obj.song_name   || obj.SongName   || obj.title  || '';
      const combined = artist && title ? artist + ' - ' + title : (title || artist || null);
      const albumart = obj.itunes_img || obj.image || null;
      console.log('[corus-jsonp]', combined || '(none)');
      if (combined) return { title: combined, artist, songTitle: title, albumart, isJson: true };
      return { title: null };
    } catch(e) { console.error('[corus-jsonp]', e.message); return { title: null }; }
  }

  // TuneIn nowPlaying
  if (url && url.includes('feed.tunein.com')) {
    try {
      const res = await httpGet(url);
      const data = JSON.parse(res.body);
      const sec = data.Secondary || {};
      const subtitle = (sec.Title || (data.Header||{}).Subtitle || '').trim();
      let artist = '', title = subtitle;
      const di = subtitle.indexOf(' - ');
      if (di > 0) {
        artist = subtitle.substring(0, di).trim();
        title = subtitle.substring(di + 3).trim();
        return { title: subtitle, artist, songTitle: title, albumart: sec.Image || null, isJson: true };
      }
      // No " - " separator means it is a station slogan (e.g. "Surge 105 is where Halifax rocks...")
      return { title: null, slogan: subtitle, isJson: true };
    } catch(e) { console.error('[tunein]', e.message); return { title: null }; }
  }

  // Vista / iHeart currentTrackMeta — ONLY when URL is actually an iHeart API endpoint
  if (url && url.includes('iheart.com') && url.includes('currentTrackMeta')) {
    console.log('[fetchMetadata] -> iheart');
    try {
      const res = await httpGet(url);
      if (!res.body || !res.body.trim()) { console.log('[iheart] empty response'); return { title: null }; }
      const data = JSON.parse(res.body);
      const track = data.currentTrack || data.track || data;
      const artist = track.artistName || track.artist || '';
      const title  = track.title || track.trackTitle || '';
      const combined = artist && title ? artist + ' - ' + title : (title || artist || null);
      const albumart = track.imagePath ? 'https://i.iheart.com/v3/re/' + track.imagePath : null;
      console.log('[iheart]', combined || '(none)');
      if (combined) return { title: combined, artist, songTitle: title, albumart, isJson: true };
      return { title: null };
    } catch(e) { console.error('[iheart]', e.message); return { title: null }; }
  }
  // Vista with metadataSource 'iheart' but a streamb.live HLS URL → resolve iHeart ID
  if (metadataSource === 'iheart' && url && url.includes('.m3u')) {
    console.log('[fetchMetadata] -> iheart source, resolving ID by callsign');
    const id = await resolveIHeartId(callsign, network);
    if (id) {
      const meta = await fetchIHeartMeta(id);
      if (meta.title) return meta;
    }
    return { title: null };
  }

  // Pattison — on iHeartRadio, resolve iHeart ID and use live-meta API
  if (net === 'pattison') {
    console.log('[fetchMetadata] -> pattison/iheart');
    const id = await resolveIHeartId(callsign, network);
    if (id) {
      const meta = await fetchIHeartMeta(id);
      if (meta.title) return meta;
    }
    // Fallback to HLS ID3 if iHeart fails
    const hlsMeta = await fetchHlsMetadata(url);
    return hlsMeta.title ? hlsMeta : { title: null };
  }

  // HLS/M3U8 (generic)
  if (metadataSource === 'hls' || (url && url.includes('.m3u8'))) {
    console.log('[fetchMetadata] -> hls');
    const hlsMeta = await fetchHlsMetadata(url);
    if (hlsMeta.title) return hlsMeta;
    if (metadataSource === 'hls') return { title: null };
  }

  // Generic JSON (Stingray / Maritime Leanplayer)
  console.log('[fetchMetadata] -> generic JSON');
  try {
    const data = await fetchJson(url);
    if (data && (data.title || data.artist || data.song || data.track || data.now_playing)) {
      const np = data.now_playing || data;
      const artist = np.artist || np.artistName || data.artist || '';
      const title = np.title || np.song || np.track || np.songTitle || data.title || '';
      const combined = artist && title ? artist + ' - ' + title : (title || artist || null);
      return { title: combined, artist, songTitle: title, station: data.station || data.name || null,
               albumart: np.albumart || np.artwork || data.albumart || null, isJson: true };
    }
  } catch(_) {}

  // ICY stream fallback
  return fetchIcyMetadata(url);
}

// ── HLS/M3U8 metadata ────────────────────────────────────────────────────────

async function fetchHlsMetadata(url) {
  try {
    // cdnstream/Futuri edge hosts (das-edge60-sa48-...) are session-bound and
    // time out under repeated polling. Log the host so we can see what's happening.
    if (url.includes('cdnstream.com')) {
      console.log('[hls] cdnstream host:', url.split('/')[2]);
    }
    // Follow up to 4 levels of m3u8 playlists to reach EXTINF title or audio segment
    let currentUrl = url;
    let segUrl = null;
    let followedSession = false;

    for (let level = 0; level < 4; level++) {
      const res = await httpGet(currentUrl, { timeout: 9000 });
      const lines = res.body.split('\n').map(l => l.trim()).filter(Boolean);
      console.log('[hls] L' + level + ' playlist (' + currentUrl.split('?')[0].split('/').pop() + '):', JSON.stringify(lines.slice(0, 12)));

      // StreamTitle / EXT-X-TITLE (single current value)
      for (const line of lines) {
        const st = line.match(/StreamTitle='([^']+)'/);
        if (st && st[1].trim()) return { title: st[1].trim(), station: null };
        const xt = line.match(/^#EXT-X-TITLE:(.+)/);
        if (xt && xt[1].trim()) return { title: xt[1].trim(), station: null };
      }
      // Futuri/cdnstream: title in EXTINF. A media playlist lists several segments
      // in time order; the LAST EXTINF is the most current. Collect them all and
      // use the last one so buffered-ahead ad markers don't override the live song.
      // Also detect ad segments: empty EXTINF title and/or segment URL under /ads/.
      const extinfTitles = [];
      let adSegmentCount = 0, totalSegments = 0;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const eiFull = line.match(/^#EXTINF:\s*[\d.]+\s*,(.*)$/);
        if (eiFull) {
          totalSegments++;
          const tt = eiFull[1].trim();
          // The segment URL is the next non-comment line
          const nextLine = lines[li+1] || '';
          const isAdUrl = nextLine.includes('/audio-store/ads/') || nextLine.includes('/ads/content/');
          if (isAdUrl) adSegmentCount++;
          if (tt && !tt.includes('.aac') && !tt.includes('.ts')) {
            extinfTitles.push(tt);
          }
        }
      }
      // If all segments are ad-store URLs (regardless of title text), it's a commercial
      if (totalSegments > 0 && adSegmentCount === totalSegments) {
        console.log('[hls-extinf] AD BREAK (all', totalSegments, 'segments are ad-store)');
        return { title: null, isAd: true, station: null };
      }
      if (extinfTitles.length) {
        // Ad detection is by ad-store URL only (handled above). The EXTINF text —
        // including "THIS STATION WILL CONTINUE AFTER THIS BREAK" — is a voice-track
        // / liner segment, NOT an ad, so we display it as the current title.
        const chosen = extinfTitles[extinfTitles.length - 1];  // most current segment
        let artist = '', title = chosen;
        const di = chosen.indexOf(' - ');
        if (di > 0) { artist = chosen.substring(0,di).trim(); title = chosen.substring(di+3).trim(); }
        console.log('[hls-extinf]', chosen, '(' + extinfTitles.length + ' segs)');
        return { title: chosen, artist, songTitle: title, station: null };
      }

      // Detect playlist type
      const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
      const hasSegments = lines.some(l => l.startsWith('#EXTINF'));
      // Get non-comment URI lines (actual playlist entries)
      const uriLines = lines.filter(l => l && !l.startsWith('#'));

      // Is this a master playlist (entries are .m3u8) or media playlist (entries are segments)?
      // Check the FILENAME (last path part before query), not the whole URL —
      // cdnstream uses "7737_128k.aac/playlist.m3u8" where .aac is in the path
      const fileExt = (u) => {
        const noQuery = u.split('?')[0];
        const lastPart = noQuery.split('/').pop() || '';
        const m = lastPart.match(/\.([a-z0-9]+)$/i);
        return m ? m[1].toLowerCase() : '';
      };

      // A real audio segment: filename ends in .aac/.ts/.m4s/.mp3, NOT .m3u8
      const segLine = uriLines.find(l => {
        const ext = fileExt(l);
        return ['aac','ts','m4s','mp3','aacp'].includes(ext);
      });
      if (segLine) {
        segUrl = segLine.startsWith('http') ? segLine : new URL(segLine, currentUrl).href;
        break;
      }

      // Follow the next .m3u8. cdnstream/Futuri masters point to themselves WITH a
      // session token — following that session URL returns a media playlist with
      // the #EXTINF song title, so we follow it (but only once per path to avoid loops).
      const nextM3u8 = uriLines.find(l => fileExt(l) === 'm3u8');
      if (nextM3u8) {
        const resolved = nextM3u8.startsWith('http') ? nextM3u8 : new URL(nextM3u8, currentUrl).href;
        const samePath = resolved.split('?')[0] === currentUrl.split('?')[0];
        const hasSession = resolved.includes('listeningSessionId') || resolved.includes('session');
        if (samePath) {
          if (hasSession && !followedSession) {
            // First time seeing a session URL on this path — follow it once
            followedSession = true;
            currentUrl = resolved;
            continue;
          }
          console.log('[hls] self-referencing master, no further metadata');
          return { title: null };
        }
        // Different path — follow normally
        currentUrl = resolved;
        continue;
      }

      // No .m3u8 and no recognized segment — take first URI line as segment (last resort)
      if (uriLines.length) {
        segUrl = uriLines[0].startsWith('http') ? uriLines[0] : new URL(uriLines[0], currentUrl).href;
      }
      break;
    }

    if (!segUrl) {
      console.log('[hls] no audio segment found after following playlists');
      return { title: null };
    }

    console.log('[hls] fetching audio segment:', segUrl.substring(0, 90));
    const segRes = await httpGet(segUrl, { timeout: 8000, binary: true });
    const buf = Buffer.isBuffer(segRes.body) ? segRes.body : Buffer.from(segRes.body, 'binary');
    console.log('[hls] segment size:', buf.length, 'bytes');

    // Scan entire segment for ID3
    let id3Idx = -1;
    for (let i = 0; i < buf.length - 10; i++) {
      if (buf[i] === 0x49 && buf[i+1] === 0x44 && buf[i+2] === 0x33 && buf[i+3] < 0xFF && buf[i+4] < 0xFF) {
        id3Idx = i; break;
      }
    }

    if (id3Idx < 0) {
      // Fallback: scan for TIT2/TPE1 patterns in raw bytes
      const raw = buf.toString('latin1');
      const stMatch = raw.match(/StreamTitle='([^']+)'/);
      if (stMatch) return { title: stMatch[1].trim(), station: null };
      console.log('[hls] no ID3 in segment (' + buf.length + ' bytes)');
      return { title: null };
    }

    const id3Ver = buf[id3Idx + 3];
    const id3Flags = buf[id3Idx + 5];
    const id3Size = ((buf[id3Idx+6]&0x7f)<<21)|((buf[id3Idx+7]&0x7f)<<14)|((buf[id3Idx+8]&0x7f)<<7)|(buf[id3Idx+9]&0x7f);
    const id3End  = Math.min(id3Idx + 10 + id3Size, buf.length);
    console.log('[hls] ID3 v2.' + id3Ver + ' at', id3Idx, 'size', id3Size);

    // Collect all frames into a map
    const frames = {};
    let pos = id3Idx + 10;
    let frameIds = [];
    while (pos < id3End - 10) {
      const fid = buf.slice(pos, pos+4).toString('ascii');
      // Stop if we hit padding (null bytes)
      if (!/^[A-Z0-9]{4}$/.test(fid)) break;
      let fsize;
      if (id3Ver >= 4) {
        fsize = ((buf[pos+4]&0x7f)<<21)|((buf[pos+5]&0x7f)<<14)|((buf[pos+6]&0x7f)<<7)|(buf[pos+7]&0x7f);
      } else {
        fsize = buf.readUInt32BE(pos+4);
      }
      frameIds.push(fid + '(' + fsize + ')');
      if (fsize > 0 && fsize < 2048) {
        const enc = buf[pos+10];
        const data = buf.slice(pos+11, pos+10+fsize);
        let str;
        try {
          str = enc === 1 ? data.toString('utf16le') : enc === 3 ? data.toString('utf8') : data.toString('latin1');
        } catch(_) { str = data.toString('latin1'); }
        frames[fid] = str.replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/[^\x20-\x7E\u00A0-\uFFFF]/g,'').trim();
      }
      if (fsize <= 0 || fsize > 100000) break;
      pos += 10 + fsize;
    }
    console.log('[hls] frames:', frameIds.join(',') || '(none)');

    const title  = frames['TIT2'] || frames['TT2'] || '';
    const artist = frames['TPE1'] || frames['TP1'] || '';
    // Some streams put "Artist - Title" in a single TXXX/COMM/WXXX/TALB frame
    let combined = artist && title ? artist + ' - ' + title : (title || artist);
    if (!combined) {
      // Priority: TXXX (Futuri/cdnstream often uses this), then any frame with ' - '
      const candidates = ['TXXX','COMM','TIT1','TALB','WXXX','TPE2','TOPE'];
      for (const fk of candidates) {
        if (frames[fk] && frames[fk].length > 3) {
          // TXXX may have "description\x00value" — take part after last null/desc
          let v = frames[fk];
          // strip common TXXX description prefixes
          v = v.replace(/^(StreamTitle|title|song|now_?playing)[:=\s]*/i, '').trim();
          if (v.includes(' - ') || v.length > 4) { combined = v; break; }
        }
      }
    }
    if (!combined) {
      for (const k of Object.keys(frames)) {
        if (frames[k] && frames[k].includes(' - ') && frames[k].length > 5) { combined = frames[k]; break; }
      }
    }
    if (combined) {
      console.log('[hls-id3]', combined);
      return { title: combined, artist, songTitle: title, station: null };
    }
    console.log('[hls] frames parsed but no usable title. Values:', JSON.stringify(frames).substring(0,200));
    return { title: null };

  } catch(e) {
    console.error('[hls]', e.message);
    return { title: null };
  }
}


// ── Ad detection ──────────────────────────────────────────────────────────────

const AD_KEYWORDS = [
  'advertisement', 'advert', 'commercial', 'sponsor', 'promo', 'break',
  'ad:', 'spot:', 'paid', 'presented by', 'station id',
  'stay tuned', 'back in a moment'
];

/**
 * Parse radio automation tags (ENCO / WideOrbit / Zetta / Maestro).
 * E.g., comment="COM8662-..." (Commercial), comment="ML2X366-..." (Music Log Track), comment="IF24001-..." (Liner)
 */
function parseAutomationCue(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.trim();
  const m = t.match(/comment=["']?([A-Za-z0-9_-]+)/i);
  if (m) {
    const tag = m[1].toUpperCase();
    if (tag.startsWith('COM') || tag.startsWith('AD') || tag.startsWith('PSA') || tag.startsWith('PROMO') || tag.startsWith('SPON')) {
      return { isAd: true, isMusic: false, type: 'commercial', tag };
    }
    if (tag.startsWith('ML') || tag.startsWith('MUS') || tag.startsWith('SONG') || tag.startsWith('TRK')) {
      return { isAd: false, isMusic: true, type: 'music', tag };
    }
    if (tag.startsWith('IF') || tag.startsWith('LIN') || tag.startsWith('SID') || tag.startsWith('JIN') || tag.startsWith('SWE')) {
      return { isAd: false, isMusic: false, type: 'liner', tag };
    }
  }
  return null;
}

function titleIsMusic(title, artist, songTitle) {
  if (artist && songTitle) return true;
  if (!title || typeof title !== 'string' || !title.trim()) return false;
  const auto = parseAutomationCue(title);
  if (auto) return auto.isMusic;
  const lower = title.toLowerCase().trim();
  if (AD_KEYWORDS.some(kw => lower.includes(kw))) return false;
  // Common music title formats: "Artist - Title", "Artist — Title", "Artist : Title"
  if (/^.+\s+[-—–:]\s+.+$/.test(title)) return true;
  return false;
}

function isAdDetected(state, title, meta) {
  const { triggerMode = 'hybrid', triggerKeywords, stallThreshold, network } = state.options;
  const now = Date.now();
  const net = (network || '').toLowerCase();
  const staleMs = now - (state.lastTitleChange || now);
  const stallMs = (stallThreshold || 60) * 1000;

  // ── 1. Acoustic Commercial Recognition (Known Ad in Database) ──
  if (state.fingerprintAdDetected === true) return true;

  // ── 2. In-band Digital Cues (Triton / HLS ad-store) ──────────────────────
  if (meta && meta.isAd === true) return true;
  if (meta && meta.cueType === 'track') return false;
  if (meta && meta.cueType && meta.cueType !== 'track') return true;

  // ── 3. Radio Automation System Tags (WideOrbit / ENCO / Pattison) ─────────
  const auto = parseAutomationCue(title);
  if (auto) {
    if (auto.isAd) return true;
    if (auto.isMusic) return false;
  }

  // ── 4. Specific Manual Override Modes ────────────────────────────────────
  if (triggerMode === 'cue') {
    return meta && meta.isAd === true;
  }

  if (triggerMode === 'keyword') {
    if (auto) {
      if (auto.isAd) return true;
      if (auto.isMusic) return false;
    }
    const keywords = (triggerKeywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const t = (title || '').toLowerCase();
    const isBlank = !title || !title.trim();
    if (keywords.length === 0) return isBlank;
    return keywords.some(k => {
      if (k === 'com' || k === 'ad') {
        return /\b(com|ad)\b|comment=["']?com/i.test(title);
      }
      return t.includes(k);
    });
  }

  if (triggerMode === 'stall') {
    if (!title || !title.trim()) return true;
    if (titleIsMusic(title, meta?.artist, meta?.songTitle) && staleMs < 360000) return false;
    return staleMs > stallMs;
  }

  if (triggerMode === 'silence') {
    return state.silenceAdDetected || false;
  }

  if (triggerMode === 'volume') {
    return state.volumeAdDetected || false;
  }

  if (triggerMode === 'fingerprint') {
    if (state.fingerprintAdDetected) return true;
    if (state.fingerprintMusicDetected) return false;
    return !title || !title.trim();
  }

  // ── 5. Hybrid Mode (Default across all stations) ─────────────────────────
  const rawMetaTitle = meta?.title ? meta.title.trim() : '';
  const isBlankMeta = !rawMetaTitle;
  const isMusic = titleIsMusic(title, meta?.artist, meta?.songTitle) || state.fingerprintMusicDetected;
  const lowerTitle = (title || '').toLowerCase();

  // A. Network-specific rules (Acadia relies purely on HLS ad cues; blank stream title is normal)
  if (net === 'acadia' || net === 'acadia broadcasting') {
    return meta && meta.isAd === true;
  }

  // B. Explicit Ad keywords in stream title
  if (AD_KEYWORDS.some(kw => lowerTitle.includes(kw))) return true;

  // C. Blank metadata from stream:
  // If the stream metadata title is blank/missing and NO music is actively playing
  if (isBlankMeta && !state.fingerprintMusicDetected) {
    return true;
  }

  // D. MUSIC PROTECTION: If a valid song is actively playing or verified by Shazam, DO NOT trigger ad!
  if (isMusic) {
    if (staleMs < 420000) {
      return false; // Confirmed song playing
    }
    return true; // Frozen on the same song title for > 7 minutes
  }

  // E. Fallback for static non-song titles past stall threshold
  return staleMs > stallMs;
}

// ── Metadata log ──────────────────────────────────────────────────────────────

function appendMetadataLog(logFile, entry, retentionHours) {
  try {
    let log = [];
    if (fs.existsSync(logFile)) { try { log = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch(_) {} }
    // Count plays
    const key = (entry.artist || '') + '|||' + (entry.songTitle || entry.title || '');
    const existing = log.find(e => ((e.artist || '') + '|||' + (e.songTitle || e.title || '')) === key);
    if (existing) { existing.playCount = (existing.playCount || 1) + 1; existing.lastPlayed = new Date().toISOString(); }
    else { log.unshift({ ...entry, time: new Date(entry.time).toISOString(), playCount: 1, lastPlayed: new Date().toISOString() }); }
    const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);
    log = log.filter(e => new Date(e.lastPlayed || e.time).getTime() > cutoff);
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    console.log(`[metalog] wrote ${log.length} entries to ${logFile}`);
  } catch(e) { console.error(`[metalog] error:`, e.message); }
}

// ── Advertiser tracking ───────────────────────────────────────────────────────

function updateAdvertisers(stationName, filename, brands) {
  try {
    let db = loadJSON(ADVERTISERS_FILE, {});
    const stName = stationName || 'station';
    if (!db[stName]) db[stName] = {};
    const dateKey = new Date().toISOString().slice(0, 10);
    if (!db[stName][dateKey]) db[stName][dateKey] = {};

    const fileKey = `_files_${filename}`;
    const previousBrands = db[stName][fileKey] || [];
    const newBrands = [...new Set((brands || []).map(b => (typeof b === 'string' ? b.trim() : '')).filter(Boolean))];

    // Decrement counts for removed brands
    previousBrands.forEach(oldBrand => {
      if (!newBrands.includes(oldBrand) && db[stName][dateKey][oldBrand]) {
        db[stName][dateKey][oldBrand]--;
        if (db[stName][dateKey][oldBrand] <= 0) {
          delete db[stName][dateKey][oldBrand];
        }
      }
    });

    // Increment counts for added brands
    newBrands.forEach(brand => {
      if (!previousBrands.includes(brand)) {
        if (!db[stName][dateKey][brand]) db[stName][dateKey][brand] = 0;
        db[stName][dateKey][brand]++;
      }
    });

    db[stName][fileKey] = newBrands;
    saveJSON(ADVERTISERS_FILE, db);
  } catch(e) { console.error('[advertisers] error:', e.message); }
}

// ── Transcribe + extract brands ───────────────────────────────────────────────

async function transcribeAndExtract(audioFile, stationName) {
  const audioPath = safeRecordingPath(audioFile);
  if (!audioPath || !fs.existsSync(audioPath)) return;
  const metaPath = safeRecordingPath(audioFile.replace(/\.(mp3|aac|ogg)$/i, '.json'));
  if (!metaPath) return;

  const settings = loadJSON(SETTINGS_FILE, {});
  const meta = { status: 'transcribing', transcript: null, brands: [], error: null };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  try {
    const transcript = await transcriber.transcribeAudio(audioPath, settings);
    meta.transcript = transcript;
    meta.status = 'extracting';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    if (!transcript) {
      meta.status = 'done';
      meta.brands = [];
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return;
    }

    const brands = await transcriber.extractAdvertisers(transcript, settings);
    meta.status = 'done';
    meta.brands = brands;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    if (stationName && brands.length) {
      updateAdvertisers(stationName, audioFile, brands);
    }
  } catch(e) {
    console.error(`[transcribe] Error processing ${audioFile}:`, e.message);
    meta.status = 'error';
    meta.error = e.message;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// ── Stream URL Playlist / OPML Resolver ───────────────────────────────────────

async function resolveDirectStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('opml.radiotime.com') || url.includes('.ashx') || url.includes('/pls') || url.includes('.pls') || url.includes('.asx') || url.includes('streamtheworld.com') || (url.includes('.m3u') && !url.includes('.m3u8'))) {
    try {
      const res = await httpGet(url, { timeout: 5000 });
      if (res && res.body) {
        // PLS File1=https://...
        const fileMatch = res.body.match(/File\d+=(https?:\/\/[^\r\n]+)/i);
        if (fileMatch) return fileMatch[1].trim();

        // M3U / general URL lines
        const lines = res.body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
        if (lines.length > 0) return lines[0];

        const m = res.body.match(/url=["'](https?:\/\/[^"']+)["']/i) || res.body.match(/href=["'](https?:\/\/[^"']+)["']/i) || res.body.match(/(https?:\/\/[^\r\n"'>\s]+)/i);
        if (m) return m[1];
      }
    } catch (_) {}
  }
  return url;
}

// ── Monitor ───────────────────────────────────────────────────────────────────

async function startMonitor(id, url, options = {}) {
  const {
    pollInterval = 10, stallThreshold = 60,
    metadataUrl = null, metadataSource = 'auto', // 'auto'|'stream'|'json'|'hls'
    stationName = '', callsign = '', network = '',
    triggerMode = 'hybrid', triggerKeywords = '',
    recordingEnabled = false, transcribeEnabled = false,
    metadataLogEnabled = true, metadataRetentionHours = 5,
  } = options;

  const directUrl = await resolveDirectStreamUrl(url);

  const state = {
    id, url, directUrl, status: 'listening',
    currentTitle: null, currentArtist: null, currentSongTitle: null, currentAlbumart: null,
    lastTitle: null, lastTitleChange: Date.now(),
    station: null, recordingFile: null, recordingStart: null,
    ffmpegRec: null, startTime: new Date(), interval: null,
    options: { pollInterval, stallThreshold, metadataUrl, metadataSource, stationName, callsign, network, triggerMode, triggerKeywords, recordingEnabled, transcribeEnabled, metadataLogEnabled, metadataRetentionHours },
    titleHistory: [],
    metadataLogFile: path.join(RECORDINGS_DIR, (stationName ? stationName.trim().replace(/[^a-zA-Z0-9_-]/g, '_') : 'station') + '-metadata.json'),
    volumeAdDetected: false, silenceAdDetected: false,
  };

  monitors[id] = state;

  async function poll() {
    if (!monitors[id]) return;
    try {
      const pollUrl = state.options.metadataUrl || url;
      const meta = await fetchMetadata(pollUrl, state.options.metadataSource, state.options.callsign, state.options.network);
      if (!monitors[id]) return;
      state.station = meta.station || state.station;

      const streamTitle = meta.title ? meta.title.trim() : '';
      const isSong = streamTitle && ((meta.artist && meta.songTitle) || streamTitle.includes(' - '));

      // If the stream sent a real song title with Artist - Song, update state from stream metadata
      if (isSong) {
        state.currentTitle = streamTitle;
        state.currentArtist = meta.artist || null;
        state.currentSongTitle = meta.songTitle || null;
        state.currentCueType = meta.cueType || null;
        state.currentDurationMs = meta.durationMs || null;
        if (meta.albumart) {
          state.currentAlbumart = meta.albumart;
        } else if (meta.artist && meta.songTitle && !state.currentAlbumart) {
          fetchMusicBrainzArt(meta.artist, meta.songTitle).then(art => {
            if (art && monitors[id]) monitors[id].currentAlbumart = art;
          }).catch(()=>{});
        }

        if (streamTitle !== state.lastTitle) {
          state.lastTitle = streamTitle;
          state.lastTitleChange = Date.now();
          const historyEntry = { title: streamTitle, artist: meta.artist || null, songTitle: meta.songTitle || null, albumart: state.currentAlbumart, time: new Date() };
          state.titleHistory.unshift(historyEntry);
          if (state.titleHistory.length > 20) state.titleHistory.pop();
          if (state.options.metadataLogEnabled && streamTitle) appendMetadataLog(state.metadataLogFile, historyEntry, state.options.metadataRetentionHours);
        }
      }

      // ── Acoustic Dual-Fingerprint Engine (Continuous across ALL stations) ──
      const now = Date.now();
      const timeSinceLastFpCheck = now - (state.lastFpCheck || 0);

      // Run acoustic fingerprinting continuously for EVERY station every 15 seconds
      const shouldRunAcoustic = !state.fpRunning && (timeSinceLastFpCheck > 15000);

      if (shouldRunAcoustic) {
        state.fpRunning = true;
        state.lastFpCheck = now;
        const aiSettings = loadJSON(SETTINGS_FILE, {});
        const acoustKey = aiSettings.acoustidApiKey || process.env.ACOUSTID_CLIENT_KEY || '';
        audioDsp.sampleAndIdentifyAudio(state.directUrl || state.url, {
          adDbFile: FINGERPRINTS_FILE,
          musicDbFile: MUSIC_FINGERPRINTS_FILE,
          currentArtist: state.currentArtist || meta.artist || null,
          currentSongTitle: state.currentSongTitle || meta.songTitle || null,
          station: state.options.stationName || state.station || '',
          clientKey: acoustKey,
          durationSeconds: 15
        }).then(res => {
          if (!monitors[id]) return;
          state.fpRunning = false;
          if (res.type === 'ad' && res.match) {
            state.fingerprintAdDetected = true;
            state.fingerprintMusicDetected = false;
            state.acousticMatchInfo = { type: 'ad', score: res.score, details: res.details };
          } else if (res.type === 'music' && res.match) {
            state.fingerprintMusicDetected = true;
            state.fingerprintAdDetected = false;
            const det = res.details || {};
            state.acousticMatchInfo = { type: 'music', score: res.score, source: res.source, details: det };
            if (det.artist && det.songTitle) {
              state.currentArtist = det.artist;
              state.currentSongTitle = det.songTitle;
              state.currentTitle = `${det.artist} - ${det.songTitle}`;
              if (det.albumart) state.currentAlbumart = det.albumart;
              else if (!state.currentAlbumart) {
                fetchMusicBrainzArt(det.artist, det.songTitle).then(art => {
                  if (art && monitors[id]) monitors[id].currentAlbumart = art;
                }).catch(()=>{});
              }

              if (state.currentTitle !== state.lastTitle) {
                state.lastTitle = state.currentTitle;
                state.lastTitleChange = Date.now();
                const hEntry = {
                  title: state.currentTitle,
                  artist: det.artist,
                  songTitle: det.songTitle,
                  albumart: state.currentAlbumart,
                  acousticMatch: true,
                  source: res.source,
                  time: new Date()
                };
                state.titleHistory.unshift(hEntry);
                if (state.titleHistory.length > 20) state.titleHistory.pop();
                if (state.options.metadataLogEnabled) appendMetadataLog(state.metadataLogFile, hEntry, state.options.metadataRetentionHours);
              }
            }
          } else {
            state.fingerprintAdDetected = false;
            state.fingerprintMusicDetected = false;
            state.acousticMatchInfo = null;
          }
        }).catch(() => {
          if (monitors[id]) state.fpRunning = false;
        });
      }

      const title = streamTitle || state.currentTitle || '';
      const adDetected = isAdDetected(state, title, meta);
      if (adDetected && state.status === 'listening') {
        console.log(`[monitor ${id}] 🔴 AD BREAK DETECTED (${state.options.stationName || state.station || id}) -> Starting commercial recording`);
        if (state.options.recordingEnabled) beginRecording(state);
        else state.status = 'monitoring-ad';
      } else if (!adDetected && (state.status === 'recording' || state.status === 'monitoring-ad')) {
        console.log(`[monitor ${id}] 🟢 AD BREAK ENDED (${state.options.stationName || state.station || id}) -> Processing commercial break`);
        if (state.status === 'recording') endRecording(state);
        else state.status = 'listening';
      }
    } catch(e) {
      console.error(`[poll ${id}] error:`, e.message);
    }
  }

  poll();
  state.interval = setInterval(poll, pollInterval * 1000);
}

function beginRecording(state) {
  const slug = state.options.stationName ? state.options.stationName.trim().replace(/[^a-zA-Z0-9_-]/g, '_') : 'commercial';
  const filename = `${slug}-${ts()}.mp3`;
  const outPath = path.join(RECORDINGS_DIR, filename);
  state.recordingFile = filename;
  state.recordingStart = new Date();
  state.status = 'recording';

  const streamUrl = state.directUrl || state.url;
  const ffmpegArgs = [
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', streamUrl,
    '-vn',
    '-acodec', 'libmp3lame',
    '-q:a', '2',
    outPath
  ];

  const rec = spawn('ffmpeg', ffmpegArgs);
  state.ffmpegRec = rec;
  rec.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('403 Forbidden') || msg.includes('Server returned') || msg.includes('Connection refused') || msg.includes('Invalid data')) {
      console.error(`[ffmpeg] ${filename} error:`, msg.trim());
    }
  });
  rec.on('close', (code) => {
    if (state.status === 'recording') {
      state.status = 'listening';
      state.recordingFile = null;
      state.recordingStart = null;
    }
  });
}

function processRecordedBreak(filename, stationName, transcribeEnabled) {
  const audioPath = safeRecordingPath(filename);
  if (!audioPath || !fs.existsSync(audioPath)) return;

  // 1. Detect silence boundaries and slice into discrete commercial spots if multi-spot
  const silences = audioDsp.detectSilenceBoundaries(audioPath);
  let spots = [];
  if (silences.segments && silences.segments.length > 1) {
    console.log(`[audio_dsp] Detected ${silences.segments.length} commercial spots in ${filename}`);
    spots = audioDsp.segmentCommercialBreak(audioPath, RECORDINGS_DIR, silences.segments);
  }

  // Save parent metadata with spots info
  const metaPath = safeRecordingPath(filename.replace(/\.(mp3|aac|ogg)$/i, '.json'));
  let meta = {};
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch(_) {}
  meta.spots = spots.map(s => s.filename);
  meta.spotCount = spots.length;
  meta.duration = silences.duration || 0;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // 2. Generate acoustic fingerprint for parent break
  const fp = audioDsp.generateFingerprint(audioPath);
  if (fp) {
    audioDsp.catalogAdFingerprint(FINGERPRINTS_FILE, {
      filename,
      station: stationName,
      duration: fp.duration,
      fingerprint: fp.fingerprint,
      raw: fp.raw,
      brands: meta.brands || [],
      transcript: meta.transcript || ''
    });
  }

  // 3. Process each spot (or the parent file if not split)
  const targets = spots.length > 0 ? spots.map(s => s.filename) : [filename];
  targets.forEach((targetFile, idx) => {
    setTimeout(() => {
      const targetPath = safeRecordingPath(targetFile);
      if (targetPath && fs.existsSync(targetPath)) {
        const spotFp = audioDsp.generateFingerprint(targetPath);
        if (spotFp) {
          audioDsp.catalogAdFingerprint(FINGERPRINTS_FILE, {
            filename: targetFile,
            station: stationName,
            duration: spotFp.duration,
            fingerprint: spotFp.fingerprint,
            raw: spotFp.raw
          });
        }
      }
      if (transcribeEnabled) {
        transcribeAndExtract(targetFile, stationName);
      }
    }, idx * 1000);
  });
}

function endRecording(state) {
  const fileToProcess = state.recordingFile;
  const stationName = state.options.stationName;
  const transcribeEnabled = state.options.transcribeEnabled;
  if (state.ffmpegRec) { state.ffmpegRec.kill('SIGTERM'); state.ffmpegRec = null; }
  state.status = 'listening'; state.recordingFile = null; state.recordingStart = null;
  if (fileToProcess) {
    setTimeout(() => processRecordedBreak(fileToProcess, stationName, transcribeEnabled), 2500);
  }
}

// ── TuneIn Search & Direct ID Resolver (v2.0) ─────────────────────────────────

async function searchTuneIn(query, limit = 15) {
  const q = (query || '').trim();
  if (!q) return [];

  // 1. Direct TuneIn ID lookup (e.g. s12183, s12345, 12183)
  const isDirectId = /^s?\d+$/i.test(q);
  if (isDirectId) {
    const guideId = q.toLowerCase().startsWith('s') ? q.toLowerCase() : 's' + q;
    try {
      const [describeRes, tuneRes, npRes] = await Promise.all([
        httpGet(`https://opml.radiotime.com/Describe.ashx?id=${guideId}&render=json`, { timeout: 5000 }).catch(() => null),
        httpGet(`https://opml.radiotime.com/Tune.ashx?id=${guideId}&render=json&formats=mp3,aac`, { timeout: 5000 }).catch(() => null),
        httpGet(`https://feed.tunein.com/profiles/${guideId}/nowPlaying`, { timeout: 4000 }).catch(() => null)
      ]);

      let stationName = '', stationLogo = '', description = '', genre = '';
      if (describeRes && describeRes.body) {
        try {
          const descData = JSON.parse(describeRes.body);
          const bodyArr = Array.isArray(descData.body) ? descData.body : [descData.body || {}];
          const head = descData.head || {};
          const first = bodyArr[0] || {};
          stationName = head.title || first.text || first.subtext || guideId;
          stationLogo = first.image || head.image || '';
          description = first.description || first.subtext || '';
          genre = first.genre || '';
        } catch (_) {}
      }

      let streamUrl = `https://opml.radiotime.com/Tune.ashx?id=${guideId}&formats=mp3,aac`;
      if (tuneRes && tuneRes.body) {
        try {
          const tuneData = JSON.parse(tuneRes.body);
          const tuneBody = Array.isArray(tuneData.body) ? tuneData.body : [tuneData.body || {}];
          if (tuneBody[0]?.url) streamUrl = tuneBody[0].url;
        } catch (_) {
          const lines = tuneRes.body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
          if (lines.length > 0) streamUrl = lines[0];
        }
      }

      if (streamUrl.includes('opml.radiotime.com')) {
        try {
          const pl = await httpGet(streamUrl, { timeout: 4000 });
          const plLines = pl.body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
          if (plLines.length > 0) streamUrl = plLines[0];
        } catch (_) {}
      }

      let nowPlaying = '', albumart = '';
      if (npRes && npRes.body) {
        try {
          const npData = JSON.parse(npRes.body);
          const sec = npData.Secondary || {};
          nowPlaying = sec.Title || npData.Header?.Subtitle || '';
          albumart = sec.Image || '';
        } catch (_) {}
      }

      return [{
        name: stationName || `TuneIn ${guideId}`,
        callsign: (stationName && /^[A-Z]{4}(-\w+)?$/i.test(stationName)) ? stationName : '',
        streamUrl,
        directUrl: streamUrl,
        audioUrl: streamUrl,
        favicon: stationLogo,
        tuneinId: guideId,
        metadataUrl: `https://feed.tunein.com/profiles/${guideId}/nowPlaying`,
        metadataType: 'tunein',
        description,
        genre,
        nowPlaying,
        albumart,
        source: 'tunein'
      }];
    } catch (e) {
      console.error('[tunein-id-lookup] Error:', e.message);
    }
  }

  // 2. Keyword Search across TuneIn Global Directory
  try {
    const result = await httpGet(
      `https://opml.radiotime.com/Search.ashx?query=${encodeURIComponent(q)}&formats=mp3,aac&render=json&filter=s`,
      { timeout: 6000 }
    );
    const data = JSON.parse(result.body);
    const items = (data.body || []).filter(i => i.type === 'audio' && i.guide_id);
    const stationItems = items.slice(0, parseInt(limit));

    const resolved = await Promise.all(stationItems.map(async s => {
      const guideId = s.guide_id || '';
      let streamUrl = s.URL || s.url || `https://opml.radiotime.com/Tune.ashx?id=${guideId}&formats=mp3,aac`;
      let nowPlaying = '', albumart = '', stationLogo = s.image || '';
      const metadataUrl = guideId ? `https://feed.tunein.com/profiles/${guideId}/nowPlaying` : '';

      await Promise.all([
        (async () => {
          if (streamUrl && streamUrl.includes('opml.radiotime.com')) {
            try {
              const playlistRes = await httpGet(streamUrl, { timeout: 4000 });
              const lines = playlistRes.body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
              if (lines.length > 0) streamUrl = lines[0];
            } catch (_) {}
          }
        })(),
        (async () => {
          if (!guideId) return;
          try {
            const npRes = await httpGet(metadataUrl, { timeout: 4000 });
            const npData = JSON.parse(npRes.body);
            const secondary = npData.Secondary || {};
            const primary = npData.Primary || {};
            nowPlaying = secondary.Title || npData.Header?.Subtitle || '';
            albumart = secondary.Image || '';
            if (!stationLogo) stationLogo = primary.Image || '';
          } catch (_) {}
        })()
      ]);

      return {
        name: s.text || s.subtext || `Station ${guideId}`,
        callsign: (s.text && /^[A-Z]{4}(-\w+)?$/i.test(s.text)) ? s.text : '',
        streamUrl,
        directUrl: streamUrl,
        audioUrl: streamUrl,
        favicon: stationLogo,
        tuneinId: guideId,
        codec: s.formats || 'mp3',
        bitrate: s.bitrate || '',
        metadataUrl,
        metadataType: 'tunein',
        nowPlaying,
        albumart,
        description: s.subtext || '',
        source: 'tunein'
      };
    }));

    return resolved;
  } catch (e) {
    console.error('[tunein-search] Error:', e.message);
    return [];
  }
}

app.get('/api/tools/search-stations', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const results = await searchTuneIn(q, limit);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-resolve stream + metadata for a station ─────────────────────────────
// Tries to find the best audio URL and metadata URL from any source

async function resolveStationUrls(streamUrl, callsign, network) {
  const result = {
    audioUrl: streamUrl || null,
    metadataUrl: null,
    metadataType: null,   // 'json' | 'icy' | 'hls'
    nowPlaying: null,
    icyName: null,
    icyMetaint: null,
    contentType: null,
    isHls: false,
    isPlaylist: false,
    resolved: false,
  };

  if (!streamUrl) return result;

  // 1. Rogers: always use the Rogers API
  if (network && network.toLowerCase() === 'rogers' && callsign) {
    result.metadataUrl = `https://radio.rogersdigitalmedia.com/service/now_playing`;
    result.metadataType = 'json';
    try {
      const meta = await fetchRogersMetadata(callsign);
      if (meta.title) result.nowPlaying = meta.title;
    } catch(_) {}
    result.resolved = true;
  }

  // 2. Probe the stream URL itself
  try {
    const lib = streamUrl.startsWith('https') ? https : http;
    await new Promise((resolve) => {
      const req2 = lib.get(streamUrl, {
        headers: { 'Icy-MetaData': '1', 'User-Agent': 'Barracuda/2.0' },
        timeout: 6000,
      }, resp => {
        result.icyName = resp.headers['icy-name'] || null;
        result.icyMetaint = resp.headers['icy-metaint'] || null;
        result.contentType = resp.headers['content-type'] || null;
        result.isHls = !!(result.contentType && (result.contentType.includes('mpegurl') || result.contentType.includes('m3u')));
        result.isPlaylist = streamUrl.endsWith('.m3u') || streamUrl.endsWith('.m3u8') || streamUrl.endsWith('.pls') ||
          !!(result.contentType && (result.contentType.includes('m3u') || result.contentType.includes('scpls')));

        if (result.isPlaylist) {
          let body = '';
          resp.on('data', d => body += d.toString());
          resp.on('end', () => {
            const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
            const streamLine = lines.find(l => l.startsWith('http') && !l.startsWith('#'));
            if (streamLine) result.audioUrl = streamLine;
            req2.destroy(); resolve();
          });
        } else {
          if (result.icyMetaint) {
            result.metadataType = result.metadataType || 'icy';
          }
          if (result.isHls) result.metadataType = 'hls';
          req2.destroy(); resolve();
        }
      });
      req2.on('error', resolve);
      req2.on('timeout', () => { req2.destroy(); resolve(); });
    });
  } catch(_) {}

  // 3. Build candidate metadata URLs in priority order (JSON first)
  const u = result.audioUrl || streamUrl;
  const candidateMetaUrls = [];

  // ── Corus / Leanstream auto-detection ───────────────────────────────────────
  if (callsign) {
    const corusInfo = lookupCorusStation(callsign);
    if (corusInfo) {
      const metaUrl = corusMetaUrl(callsign);
      const streamUrl2 = corusStreamUrl(callsign);
      result.metadataUrl = metaUrl;
      result.metadataType = 'corus-jsonp';
      result.audioUrl = result.audioUrl || streamUrl2;
      result.suggestedStreamUrl = streamUrl2;
      result.network = 'Corus';
      result.brand = corusInfo.brand;
      // Try to validate by fetching JSONP and stripping callback
      try {
        const jsonpRes = await httpGet(metaUrl);
        const raw = jsonpRes.body.replace(/^[^(]+\(/, '').replace(/\);?\s*$/, '');
        const data = JSON.parse(raw);
        const title = data.title || data.song || (data.items && data.items[0] && data.items[0].title) || '';
        const artist = data.artist || (data.items && data.items[0] && data.items[0].artist) || '';
        if (title || artist) {
          result.nowPlaying = artist && title ? `${artist} - ${title}` : (title || artist);
          result.resolved = true;
        }
      } catch(_) {}
      console.log('[resolve] Corus/Leanstream match:', corusInfo.brand, '->', metaUrl);
      return result;
    }
  }

  // ── Bell Media / Triton Digital auto-detection ──────────────────────────────
  // Check Bell registry first — if callsign matches, use Triton nowplaying API
  if (callsign) {
    const bellInfo = lookupBellStation(callsign);
    if (bellInfo) {
      const tritonUrl = tritonMetaUrl(callsign);
      // Validate it returns data
      try {
        const tritonRes = await httpGet(tritonUrl);
        const tritonData = JSON.parse(tritonRes.body);
        const items = tritonData.nowplaying || tritonData.items || [];
        if (items.length > 0 && items[0].type === 'track') {
          const track = items[0].nowplayingId ? items[0] : items[0];
          const title = track.name || '';
          const artist = track.artistName || '';
          result.metadataUrl = tritonUrl;
          result.metadataType = 'triton';
          result.nowPlaying = artist && title ? `${artist} - ${title}` : (title || null);
          result.resolved = true;
          result.network = 'Bell';
          result.brand = bellInfo.brand;
          console.log('[resolve] Bell/Triton match:', bellInfo.brand, '->', tritonUrl);
          return result;
        }
      } catch(_) {}
      // Even if validation fails, suggest the Triton URL
      result.metadataUrl = tritonUrl;
      result.metadataType = 'triton';
      result.audioUrl = result.audioUrl || bellStreamUrl(callsign);
      result.suggestedStreamUrl = bellStreamUrl(callsign);
      result.network = 'Bell';
      result.brand = bellInfo.brand;
      result.resolved = true;
      return result;
    }
  }

  // Leanstream patterns — extract callsign from URL
  const leanstreamCallsign = u.match(/\/([A-Z]{3,6}(?:FM|AM)?)-MP3/i)?.[1]?.toUpperCase() || callsign?.toUpperCase() || '';

  if (u.includes('-MP3')) {
    // Leanstream -NP3 endpoint (try first)
    candidateMetaUrls.push({ url: u.replace(/-MP3(-\d+)?(\?.*)?$/, '-NP3').split('?')[0], type: 'json', label: 'Leanstream NP3' });
  }

  // Stingray / Newcap Leanplayer nowplaying (player.q104.ca fallback pattern)
  // Callsigns in checklines are suffixed with AM/FM (e.g. CFRQFM, VOCMAM)
  // The nowplaying URL uses the base callsign without the suffix (e.g. CFRQ, VOCM)
  // Stations sharing a base callsign (VOCMAM/VOCMFM, CFCWAM/CFCWFM) are
  // distinguished by their full suffixed callsign in the stream URL
  if (leanstreamCallsign && (u.includes('leanstream') || u.includes('stingray') || network === 'Stingray')) {
    // Use full suffixed callsign in URL — player.q104.ca/CFRQFM/nowplaying
    candidateMetaUrls.push({ url: `https://player.q104.ca/${leanstreamCallsign}/nowplaying`, type: 'json', label: 'Leanplayer q104 nowplaying' });
  }

  // Icecast status-json
  const baseUrl = u.split('/').slice(0, 3).join('/');
  candidateMetaUrls.push({ url: baseUrl + '/status-json.xsl', type: 'json', label: 'Icecast status' });
  // Shoutcast stats
  candidateMetaUrls.push({ url: baseUrl + '/stats?json=1', type: 'json', label: 'Shoutcast stats' });
  // Stream path variants
  if (u.includes('/stream')) {
    candidateMetaUrls.push({ url: u.split('/stream')[0] + '/status-json.xsl', type: 'json', label: 'Icecast base' });
  }

  // TuneIn — extract guide_id from stream URL if it's an OPML redirect,
  // or look up by callsign/name
  let tuneInGuideId = null;
  // Check if stream URL contains a TuneIn guide_id directly
  const tuneInIdFromUrl = (streamUrl || '').match(/[?&]id=(s\d+)/i);
  if (tuneInIdFromUrl) {
    tuneInGuideId = tuneInIdFromUrl[1];
  } else if (callsign) {
    try { tuneInGuideId = await fetchTuneInId(callsign, ''); } catch(_) {}
  }
  if (tuneInGuideId) {
    candidateMetaUrls.push({
      url:   tuneInMetaUrl(tuneInGuideId),
      type:  'tunein',
      label: 'TuneIn nowPlaying (' + tuneInGuideId + ')'
    });
  }

  // 4. Try ALL candidates and collect every one that returns a live title
  result.allSources = []; // array of { url, type, label, nowPlaying, artist, songTitle, albumart }
  await Promise.all(candidateMetaUrls.map(async candidate => {
    try {
      const meta = await fetchMetadata(candidate.url, candidate.url, callsign, candidate.type);
      if (meta && meta.title && meta.title.trim()) {
        result.allSources.push({
          url: candidate.url,
          type: candidate.type,
          label: candidate.label,
          nowPlaying: meta.title,
          artist: meta.artist || '',
          songTitle: meta.songTitle || '',
          albumart: meta.albumart || null,
        });
        console.log('[resolve] valid source:', candidate.label, '->', meta.title);
      }
    } catch(_) {}
  }));

  // Use best source as default (prefer JSON over ICY, first found wins)
  const preferred = result.allSources[0];
  if (preferred) {
    result.metadataUrl  = preferred.url;
    result.metadataType = preferred.type;
    result.nowPlaying   = preferred.nowPlaying;
    result.resolved     = true;
  }

  // 5. Fall back to ICY inline metadata if no JSON endpoint found
  if (!result.nowPlaying && result.icyMetaint) {
    try {
      const icyMeta = await fetchIcyMetadata(streamUrl);
      if (icyMeta.title) {
        result.nowPlaying   = icyMeta.title;
        result.metadataType = 'icy';
        result.resolved     = true;
        result.allSources.push({ url: streamUrl, type: 'icy', label: 'ICY stream metadata', nowPlaying: icyMeta.title });
        console.log('[resolve] ICY metadata:', icyMeta.title);
      }
    } catch(_) {}
  }

  return result;
}

// Bulk resolve metadata+audio for search results
app.post('/api/tools/resolve-station', async (req, res) => {
  const { streamUrl, callsign, network } = req.body;
  if (!streamUrl) return res.status(400).json({ error: 'streamUrl required' });
  try {
    const resolved = await resolveStationUrls(streamUrl, callsign, network);
    res.json(resolved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resolve and return ALL valid metadata sources for a station
app.post('/api/tools/resolve-station-all', async (req, res) => {
  const { streamUrl, callsign, name, network } = req.body;
  if (!streamUrl && !callsign) return res.status(400).json({ error: 'streamUrl or callsign required' });
  try {
    const resolved = await resolveStationUrls(streamUrl || '', callsign || '', network || '');
    res.json({
      audioUrl:   resolved.audioUrl   || streamUrl,
      allSources: resolved.allSources || [],
      icyName:    resolved.icyName,
      icyMetaint: resolved.icyMetaint,
      isHls:      resolved.isHls,
    });
  } catch(e) { res.status(500).json({ error: e.message, allSources: [] }); }
});

// ── Probe a stream URL for metadata + audio path ──────────────────────────────
app.post('/api/tools/probe-stream', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = {
      url, icyName: null, icyMetaint: null, contentType: null,
      isHls: false, isPlaylist: false, audioUrl: null, metadataUrl: null,
      suggestedStreamUrl: null, suggestedMetadataUrl: null,
    };

    const lib = url.startsWith('https') ? https : http;

    await new Promise((resolve) => {
      const req2 = lib.get(url, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'Barracuda/2.0' }, timeout: 8000 }, resp => {
        result.icyName = resp.headers['icy-name'] || null;
        result.icyMetaint = resp.headers['icy-metaint'] || null;
        result.contentType = resp.headers['content-type'] || null;
        result.isHls = !!(result.contentType && (result.contentType.includes('mpegurl') || result.contentType.includes('m3u')));

        // Check if it's a playlist (M3U/PLS)
        const isM3u = result.contentType && result.contentType.includes('m3u');
        const isPls = result.contentType && result.contentType.includes('scpls');
        result.isPlaylist = isM3u || isPls || url.endsWith('.m3u') || url.endsWith('.m3u8') || url.endsWith('.pls');

        if (result.isPlaylist) {
          let body = '';
          resp.on('data', d => body += d.toString());
          resp.on('end', () => {
            // Extract first stream URL from M3U
            const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
            const streamLine = lines.find(l => l.startsWith('http') && !l.startsWith('#'));
            if (streamLine) {
              result.audioUrl = streamLine;
              result.suggestedStreamUrl = streamLine;
            }
            // Try NP3 metadata endpoint from leanstream pattern
            if (streamLine && streamLine.includes('leanstream')) {
              const npUrl = streamLine.replace(/-MP3/, '-NP3');
              result.suggestedMetadataUrl = npUrl;
            }
            req2.destroy();
            resolve();
          });
        } else {
          // Direct stream - suggest metadata url variants
          result.audioUrl = url;
          result.suggestedStreamUrl = url;
          // Common metadata URL patterns
          if (url.includes('-MP3')) result.suggestedMetadataUrl = url.replace('-MP3', '-NP3');
          else if (url.includes('/stream')) result.suggestedMetadataUrl = url.replace('/stream', '/status-json.xsl');
          req2.destroy();
          resolve();
        }
      });
      req2.on('error', resolve);
      req2.on('timeout', () => { req2.destroy(); resolve(); });
    });

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lookup callsign in Corus registry
app.get('/api/tools/lookup-callsign-corus/:callsign', (req, res) => {
  const corusInfo = lookupCorusStation(req.params.callsign);
  if (corusInfo) {
    return res.json({
      found: true,
      network: 'Corus',
      brand: corusInfo.brand,
      city: corusInfo.city,
      streamUrl: corusStreamUrl(req.params.callsign),
      metadataUrl: corusMetaUrl(req.params.callsign),
      metadataType: 'corus-jsonp',
    });
  }
  res.json({ found: false });
});

// Lookup callsign in Bell registry
app.get('/api/tools/lookup-callsign/:callsign', (req, res) => {
  const bellInfo = lookupBellStation(req.params.callsign);
  if (bellInfo) {
    return res.json({
      found: true, network: 'Bell', brand: bellInfo.brand, city: bellInfo.city,
      streamUrl: bellStreamUrl(req.params.callsign),
      metadataUrl: tritonMetaUrl(req.params.callsign), metadataType: 'triton',
    });
  }
  const corusInfo = lookupCorusStation(req.params.callsign);
  if (corusInfo) {
    return res.json({
      found: true, network: 'Corus', brand: corusInfo.brand, city: corusInfo.city,
      streamUrl: corusStreamUrl(req.params.callsign),
      metadataUrl: corusMetaUrl(req.params.callsign), metadataType: 'corus-jsonp',
    });
  }
  res.json({ found: false });
});


// ── MusicBrainz album art lookup ─────────────────────────────────────────────
async function fetchMusicBrainzArt(artist, title) {
  if (!artist || !title) return null;
  try {
    const q = encodeURIComponent('"' + title + '" AND artist:"' + artist + '"');
    const res = await httpGet('https://musicbrainz.org/ws/2/recording/?query=' + q + '&limit=1&fmt=json', {
      headers: { 'User-Agent': 'Barracuda/2.0 (radio-monitor)' }
    });
    const data = JSON.parse(res.body);
    const recordings = data.recordings || [];
    if (!recordings.length) return null;
    const releases = recordings[0].releases || [];
    if (!releases.length) return null;
    const releaseId = releases[0].id;
    // Check if cover art exists
    const caRes = await httpGet('https://coverartarchive.org/release/' + releaseId, {
      headers: { 'User-Agent': 'Barracuda/2.0' }
    });
    const caData = JSON.parse(caRes.body);
    const images = caData.images || [];
    const front = images.find(i => i.front) || images[0];
    if (front) return front.thumbnails && (front.thumbnails.small || front.thumbnails['250'] || front.image);
    return null;
  } catch(_) { return null; }
}

// ── Logo lookup ───────────────────────────────────────────────────────────────
// Tries Radio Browser (favicon) then TuneIn (image) in order
// Returns { logoUrl } or { logoUrl: null }

async function fetchLogoForStation(callsign, name) {
  // Radio Browser only — fast, no crashes, good Canadian coverage
  const queries = [callsign, name].filter(Boolean).filter((v,i,a) => a.indexOf(v) === i);
  for (const q of queries) {
    try {
      const url = `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&limit=5&hidebroken=true&order=votes`;
      const res = await httpGet(url, { timeout: 4000 });
      const stations = JSON.parse(res.body);
      const qNorm = q.replace(/[^A-Z0-9]/gi,'').toUpperCase();
      const match = stations.find(s => {
        const sNorm = s.name.replace(/[^A-Z0-9]/gi,'').toUpperCase();
        return sNorm === qNorm || sNorm.startsWith(qNorm) || qNorm.startsWith(sNorm);
      }) || stations[0];
      if (match && match.favicon && match.favicon.startsWith('http')) {
        console.log('[logo] Radio Browser:', q, '->', match.favicon);
        return { logoUrl: match.favicon, source: 'radiobrowser' };
      }
    } catch(_) {}
  }
  return { logoUrl: null };
}

// ── Resolve a fresh cdnstream/Futuri session URL ────────────────────────────
// The bare playlist.m3u8 returns a master pointing to a session-bearing child.
// Fetching it establishes a session; we return the child URL for playback.
app.get('/api/tools/resolve-stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const timeout = setTimeout(() => { if (!res.headersSent) res.json({ url, resolved: false }); }, 8000);
  try {
    let currentUrl = url;
    // Follow up to 2 levels to reach a session-bearing media playlist
    for (let i = 0; i < 2; i++) {
      const r = await httpGet(currentUrl, { timeout: 6000 });
      const lines = r.body.split('\n').map(l => l.trim()).filter(Boolean);
      const child = lines.find(l => l && !l.startsWith('#') && l.includes('.m3u8'));
      if (child) {
        currentUrl = child.startsWith('http') ? child : new URL(child, currentUrl).href;
        // If this child has a session token, it's the playable URL
        if (currentUrl.includes('listeningSessionId') || currentUrl.includes('session')) {
          clearTimeout(timeout);
          return res.json({ url: currentUrl, resolved: true });
        }
      } else {
        break;
      }
    }
    clearTimeout(timeout);
    res.json({ url: currentUrl, resolved: currentUrl !== url });
  } catch(e) {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ url, resolved: false, error: e.message });
  }
});

// ── MusicBrainz song lookup ──────────────────────────────────────────────────
app.get('/api/tools/musicbrainz', async (req, res) => {
  const { artist, title, query } = req.query;
  if (!artist && !title && !query) return res.status(400).json({ error: 'artist+title or query required' });
  const timeout = setTimeout(() => { if (!res.headersSent) res.json({ found: false, error: 'timeout' }); }, 10000);
  try {
    // Build Lucene query for the recording search
    let q;
    if (query) {
      q = 'recording:"' + query.replace(/"/g, '') + '"';
    } else {
      const parts = [];
      if (title)  parts.push('recording:"' + title.replace(/"/g, '') + '"');
      if (artist) parts.push('artist:"' + artist.replace(/"/g, '') + '"');
      q = parts.join(' AND ');
    }
    const url = 'https://musicbrainz.org/ws/2/recording/?query=' + encodeURIComponent(q) + '&limit=5&fmt=json';
    const r = await httpGet(url, { headers: { 'User-Agent': 'Barracuda/2.0 (radio-monitor)' }, timeout: 8000 });
    const data = JSON.parse(r.body);
    const recordings = data.recordings || [];
    if (!recordings.length) { clearTimeout(timeout); return res.json({ found: false }); }

    // Take best match (highest score)
    const rec = recordings[0];
    const mbArtist = (rec['artist-credit'] || []).map(a => a.name).join(', ') || (artist || '');
    const mbTitle  = rec.title || (title || '');
    const releases = rec.releases || [];
    const release  = releases[0] || {};
    const album    = release.title || '';
    const releaseId = release.id || null;
    const year     = (rec['first-release-date'] || release.date || '').substring(0, 4);

    // Cover art: try several releases + release-groups until we find artwork.
    // CAA often has art on a different release than the first listed.
    async function coverArtFor(type, id) {
      try {
        const caUrl = 'https://coverartarchive.org/' + type + '/' + id;
        const caRes = await httpGet(caUrl, { headers: { 'User-Agent': 'Barracuda/2.0 (radio-monitor)' }, timeout: 6000 });
        if (caRes.status === 404) return null;
        const caData = JSON.parse(caRes.body);
        const imgs = caData.images || [];
        const front = imgs.find(i => i.front) || imgs[0];
        if (front) {
          const th = front.thumbnails || {};
          return th['500'] || th.large || th['250'] || th.small || front.image || null;
        }
      } catch(_) {}
      return null;
    }

    let albumart = null;
    // Try up to 4 releases of this recording
    for (const rel of releases.slice(0, 4)) {
      if (rel.id) { albumart = await coverArtFor('release', rel.id); if (albumart) break; }
      // Also try the release-group (covers reissues)
      const rgId = rel['release-group'] && rel['release-group'].id;
      if (rgId) { albumart = await coverArtFor('release-group', rgId); if (albumart) break; }
    }

    clearTimeout(timeout);
    res.json({
      found: true,
      artist: mbArtist,
      title: mbTitle,
      album,
      year,
      albumart,
      mbid: rec.id,
      releaseId,
      score: rec.score,
      // Provide a few alternates for the user (with releaseId for on-demand art)
      alternates: recordings.slice(0, 5).map(rc => {
        const rel0 = (rc.releases || [])[0] || {};
        return {
          artist: (rc['artist-credit'] || []).map(a => a.name).join(', '),
          title: rc.title,
          album: rel0.title || '',
          year: (rc['first-release-date'] || '').substring(0,4),
          releaseId: rel0.id || null,
          mbid: rc.id,
        };
      }),
    });
  } catch(e) {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ found: false, error: e.message });
  }
});

// Fetch cover art for a specific MusicBrainz release or release-group
app.get('/api/tools/coverart', async (req, res) => {
  const { releaseId, releaseGroupId } = req.query;
  if (!releaseId && !releaseGroupId) return res.json({ albumart: null });
  const timeout = setTimeout(() => { if (!res.headersSent) res.json({ albumart: null }); }, 7000);
  async function fetchArt(type, id) {
    try {
      const r = await httpGet('https://coverartarchive.org/' + type + '/' + id, { headers: { 'User-Agent': 'Barracuda/2.0 (radio-monitor)' }, timeout: 6000 });
      if (r.status === 404) return null;
      const d = JSON.parse(r.body);
      const imgs = d.images || [];
      const front = imgs.find(i => i.front) || imgs[0];
      if (front) { const th = front.thumbnails || {}; return th['500'] || th.large || th['250'] || th.small || front.image || null; }
    } catch(_) {}
    return null;
  }
  let albumart = null;
  if (releaseId) albumart = await fetchArt('release', releaseId);
  if (!albumart && releaseGroupId) albumart = await fetchArt('release-group', releaseGroupId);
  clearTimeout(timeout);
  if (!res.headersSent) res.json({ albumart });
});

app.get('/api/tools/fetch-logo', async (req, res) => {
  const { callsign, name } = req.query;
  if (!callsign && !name) return res.status(400).json({ error: 'callsign or name required' });
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ logoUrl: null, error: 'timeout' });
  }, 10000);
  try {
    const result = await Promise.race([
      fetchLogoForStation(callsign || '', name || callsign || ''),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 9000))
    ]);
    clearTimeout(timeout);
    if (!res.headersSent) res.json(result);
  } catch(e) {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ logoUrl: null, error: e.message });
  }
});

// Bulk logo fetch for a list of stations
app.post('/api/tools/fetch-logos-bulk', async (req, res) => {
  const { stations } = req.body; // [{ callsign, name }]
  if (!Array.isArray(stations)) return res.status(400).json({ error: 'stations array required' });
  const results = {};
  // Process in batches of 5 to avoid hammering the APIs
  for (let i = 0; i < stations.length; i += 5) {
    const batch = stations.slice(i, i + 5);
    await Promise.all(batch.map(async s => {
      const r = await fetchLogoForStation(s.callsign || '', s.name || s.callsign || '');
      results[s.callsign || s.name] = r.logoUrl;
    }));
    if (i + 5 < stations.length) await new Promise(r => setTimeout(r, 200)); // small delay between batches
  }
  res.json(results);
});


// ── TuneIn now-playing ────────────────────────────────────────────────────────
// Metadata URL: https://feed.tunein.com/profiles/sXXXX/nowPlaying
// Returns: Secondary.Title (song), Secondary.Image (album art),
//          Primary.Image (station logo), Ttl (seconds until next poll)

async function fetchTuneInId(callsign, name) {
  // Build query list — try callsign first, then name, then callsign without FM/AM suffix
  const csClean = (callsign || '').replace(/[^A-Z0-9]/gi, '');
  const csSuffix = csClean.replace(/(FM|AM)$/i, '');
  const queries = [...new Set([callsign, name, csSuffix].filter(Boolean))];

  for (const q of queries) {
    try {
      const url = `https://opml.radiotime.com/Search.ashx?query=${encodeURIComponent(q)}&render=json&filter=s&formats=mp3,aac`;
      const res = await httpGet(url);
      const data = JSON.parse(res.body);
      const items = (data.body || []).filter(i => i.type === 'audio' && i.guide_id);
      if (items.length > 0) {
        // Prefer exact callsign match if available
        const exact = items.find(i => {
          const t = (i.text || '').toUpperCase();
          return t.includes(csClean) || t.includes(q.toUpperCase());
        }) || items[0];
        console.log(`[tunein] found ${exact.guide_id} for "${q}" → ${exact.text}`);
        return exact.guide_id;
      }
    } catch(_) {}
  }
  return null;
}

function tuneInMetaUrl(guideId) {
  return `https://feed.tunein.com/profiles/${guideId}/nowPlaying`;
}

async function fetchTuneInNowPlaying(guideId) {
  try {
    const url = tuneInMetaUrl(guideId);
    const res = await httpGet(url);
    const data = JSON.parse(res.body);
    // Secondary has the current track, Primary has station info
    const secondary = data.Secondary || {};
    const primary   = data.Primary   || {};
    const header    = data.Header    || {};
    // Title from Secondary is "Artist - Song" combined, or split
    const subtitle  = secondary.Title || header.Subtitle || '';
    // Try to split "Artist - Song" if combined
    let artist = '', title = subtitle;
    const dashIdx = subtitle.indexOf(' - ');
    if (dashIdx > 0) {
      artist = subtitle.substring(0, dashIdx).trim();
      title  = subtitle.substring(dashIdx + 3).trim();
    }
    const albumart   = secondary.Image  || null;
    const stationLogo = primary.Image   || null;
    const ttl        = data.Ttl         || 30; // seconds until next change
    return {
      title: subtitle || null,
      artist,
      songTitle: title,
      albumart,
      stationLogo,
      ttl,
      guideId,
      isJson: true,
    };
  } catch(e) {
    console.error('[tunein-np]', e.message);
    return { title: null };
  }
}

// Look up TuneIn ID and return metadata URL + logo
app.get('/api/tools/tunein-lookup', async (req, res) => {
  const { callsign, name } = req.query;
  if (!callsign && !name) return res.status(400).json({ error: 'callsign or name required' });
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ found: false, error: 'timeout' });
  }, 8000);
  try {
    const guideId = await Promise.race([
      fetchTuneInId(callsign || '', name || callsign || ''),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
    ]);
    if (!guideId) { clearTimeout(timeout); return res.json({ found: false }); }
    // Only fetch nowPlaying for metadata URL — no logo fetch
    const np = await Promise.race([
      fetchTuneInNowPlaying(guideId),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    clearTimeout(timeout);
    if (!res.headersSent) res.json({
      found: true, guideId,
      metadataUrl: tuneInMetaUrl(guideId),
      metadataType: 'tunein',
      nowPlaying: np.title,
      stationLogo: null,  // logo lookup removed — use Radio Browser
    });
  } catch(e) {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ found: false, error: e.message });
  }
});

// ── Debug metadata fetch ─────────────────────────────────────────────────────
// Debug active monitor state
app.get('/api/debug/monitor-state', (req, res) => {
  const states = Object.values(monitors).map(m => ({
    id: m.id,
    station: m.options.stationName,
    network: m.options.network,
    metadataSource: m.options.metadataSource,
    metadataUrl: m.options.metadataUrl,
    callsign: m.options.callsign,
  }));
  res.json(states);
});

app.get('/api/debug/fetch-meta', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const cleanUrl = sanitizeUrl(url);
    const result = await httpGet(cleanUrl);
    res.json({
      requestedUrl: url,
      cleanUrl,
      status: result.status,
      contentType: result.headers['content-type'],
      bodyLength: result.body.length,
      bodyPreview: result.body.substring(0, 500),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Force-rebuild all Bell metadata URLs from callsign
app.post('/api/stations/rebuild-bell', (req, res) => {
  try {
    const stations = loadStationsData();
    let fixed = 0;
    stations.forEach(s => {
      const net = (s.network || s.group || '').toLowerCase();
      if (net === 'bell') {
        const cs = normCallsign(s.callsign || s.name);
        if (cs) {
          const newUrl = `https://np.tritondigital.com/public/nowplaying?mountName=${cs}&numberToFetch=1`;
          const oldUrl = s.metadataUrl || '';
          s.metadataUrl = newUrl;
          s.metadataSource = 'triton';
          if (oldUrl !== newUrl) fixed++;
          console.log('[rebuild-bell]', s.name, ':', oldUrl, '->', newUrl);
        }
      }
    });
    saveStationsData(stations);
    res.json({ fixed, total: stations.filter(s => ['bell'].includes((s.network||s.group||'').toLowerCase())).length, stations });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Monitor API ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const active = Object.values(monitors).map(m => ({
    id: m.id, url: m.url, status: m.status,
    currentTitle: m.currentTitle, currentArtist: m.currentArtist,
    currentSongTitle: m.currentSongTitle, currentAlbumart: m.currentAlbumart,
    currentCueType: m.currentCueType || null, currentDurationMs: m.currentDurationMs || null,
    station: m.station, recordingFile: m.recordingFile, recordingStart: m.recordingStart,
    startTime: m.startTime, lastTitleChange: m.lastTitleChange,
    titleHistory: m.titleHistory.slice(0, 5), options: m.options,
    metadataSource: m.options.metadataUrl ? 'json' : 'stream',
    recordingEnabled: m.options.recordingEnabled, transcribeEnabled: m.options.transcribeEnabled,
    metadataLogEnabled: m.options.metadataLogEnabled, metadataRetentionHours: m.options.metadataRetentionHours,
    metadataLogFile: m.metadataLogFile,
    acousticMatchInfo: m.acousticMatchInfo || null,
  }));
  res.json({ active });
});

app.post('/api/monitor/start', (req, res) => {
  const { url, pollInterval, stallThreshold, metadataUrl, metadataSource: rawSource, stationName, callsign, network, triggerMode, triggerKeywords, recordingEnabled, transcribeEnabled, metadataLogEnabled, metadataRetentionHours } = req.body;
  // Server-side metadataSource override by network — ensures correct parser even
  // if frontend sends 'auto' for a known network
  let metadataSource = rawSource || 'auto';
  const netLower = (network || '').toLowerCase();
  if (netLower === 'bell' || (metadataUrl && metadataUrl.includes('tritondigital'))) {
    metadataSource = 'triton';
  } else if (netLower === 'corus' || (metadataUrl && metadataUrl.includes('globalnewselection'))) {
    metadataSource = 'corus-jsonp';
  } else if (netLower === 'rogers') {
    metadataSource = 'json';
  } else if (netLower === 'pattison') {
    metadataSource = 'hls';
  } else if (netLower === 'acadia' || netLower === 'acadia broadcasting' || (url && url.includes('cdnstream.com'))) {
    metadataSource = 'hls';
  } else if (metadataUrl && metadataUrl.includes('feed.tunein.com')) {
    metadataSource = 'tunein';
  }
  if (!url) return res.status(400).json({ error: 'URL required' });
  const id = Date.now().toString();
  startMonitor(id, url, { pollInterval, stallThreshold, metadataUrl: metadataUrl || null, metadataSource: metadataSource || 'auto', stationName: stationName || '', callsign: callsign || '', network: network || '', triggerMode: triggerMode || 'hybrid', triggerKeywords: triggerKeywords || '', recordingEnabled: recordingEnabled === true, transcribeEnabled: transcribeEnabled === true, metadataLogEnabled: metadataLogEnabled !== false, metadataRetentionHours: parseFloat(metadataRetentionHours) || 5 });
  res.json({ id, message: 'Monitoring started' });
});

app.post('/api/monitor/stop/:id', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  clearInterval(m.interval);
  if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM');
  delete monitors[req.params.id];
  res.json({ message: 'Stopped' });
});

app.post('/api/monitor/stopall', (req, res) => {
  Object.values(monitors).forEach(m => { clearInterval(m.interval); if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM'); });
  monitors = {};
  res.json({ message: 'All stopped' });
});

app.post('/api/monitor/:id/recording', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.options.recordingEnabled = req.body.enabled !== false;
  if (!m.options.recordingEnabled && m.status === 'recording') { endRecording(m); m.status = 'listening'; }
  res.json({ recordingEnabled: m.options.recordingEnabled });
});

app.post('/api/monitor/:id/transcribe', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.options.transcribeEnabled = req.body.enabled !== false;
  res.json({ transcribeEnabled: m.options.transcribeEnabled });
});

app.post('/api/monitor/:id/metalog', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.options.metadataLogEnabled = req.body.enabled !== false;
  if (req.body.retentionHours) m.options.metadataRetentionHours = parseFloat(req.body.retentionHours);
  res.json({ metadataLogEnabled: m.options.metadataLogEnabled, metadataRetentionHours: m.options.metadataRetentionHours });
});

// ── Recordings ────────────────────────────────────────────────────────────────

app.get('/api/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.aac') || f.endsWith('.ogg'))
      .map(f => { const stat = fs.statSync(path.join(RECORDINGS_DIR, f)); return { name: f, size: stat.size, modified: stat.mtime }; })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json(files);
  } catch(e) { res.json([]); }
});

app.get('/api/recordings/download/:name', (req, res) => {
  const fp = safeRecordingPath(req.params.name);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp, path.basename(fp));
});

app.delete('/api/recordings/station/:station', (req, res) => {
  const station = req.params.station;
  const slug = station.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  let deleted = 0;
  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    for (const f of files) {
      if (f.startsWith(slug + '-') || (station && f.includes(station))) {
        const fp = path.join(RECORDINGS_DIR, f);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          deleted++;
        }
      }
    }
    res.json({ message: 'Deleted', deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/recordings/all', (req, res) => {
  let deleted = 0;
  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    for (const f of files) {
      if (/\.(mp3|aac|ogg|json)$/i.test(f) && !f.endsWith('-metadata.json') && f !== 'stations.json' && f !== 'settings.json' && f !== 'advertisers.json' && f !== 'ad_fingerprints.json') {
        const fp = path.join(RECORDINGS_DIR, f);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          deleted++;
        }
      }
    }
    res.json({ message: 'All recordings deleted', deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/recordings/:name', (req, res) => {
  const fp = safeRecordingPath(req.params.name);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  const metaFp = safeRecordingPath(req.params.name.replace(/\.(mp3|aac|ogg)$/i, '.json'));
  if (metaFp && fs.existsSync(metaFp)) fs.unlinkSync(metaFp);
  res.json({ message: 'Deleted' });
});

app.get('/api/recordings/meta/:name', (req, res) => {
  const mp = safeRecordingPath(req.params.name.replace(/\.(mp3|aac|ogg)$/i, '.json'));
  if (!mp || !fs.existsSync(mp)) return res.json({ status: 'pending', brands: [], transcript: null });
  try { res.json(JSON.parse(fs.readFileSync(mp, 'utf8'))); } catch(_) { res.json({ status: 'error', brands: [], transcript: null }); }
});

app.patch('/api/recordings/meta/:name', (req, res) => {
  const mp = safeRecordingPath(req.params.name.replace(/\.(mp3|aac|ogg)$/i, '.json'));
  if (!mp) return res.status(400).json({ error: 'Invalid filename' });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch(_) {}
  const updated = { ...existing, ...req.body };
  fs.writeFileSync(mp, JSON.stringify(updated, null, 2));
  // Re-update advertisers if brands changed
  if (req.body.brands) updateAdvertisers(req.body.station || path.basename(req.params.name).split('-')[0], path.basename(req.params.name), req.body.brands);
  res.json(updated);
});

app.post('/api/recordings/purge', (req, res) => {
  const days = parseFloat(req.body.days);
  const hours = !isNaN(days) ? days * 24 : (parseFloat(req.body.hours) || 24);
  const station = req.body.station ? req.body.station.trim() : null;
  const slug = station ? station.replace(/[^a-zA-Z0-9_-]/g, '_') : null;
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  let deleted = 0;
  try {
    fs.readdirSync(RECORDINGS_DIR).filter(f => /\.(mp3|aac|ogg)$/i.test(f)).forEach(f => {
      if (slug && !f.startsWith(slug + '-') && !f.includes(station)) return;
      const fp = path.join(RECORDINGS_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        deleted++;
        const mp = fp.replace(/\.(mp3|aac|ogg)$/i, '.json');
        if (fs.existsSync(mp)) fs.unlinkSync(mp);
      }
    });
  } catch(e) {}
  res.json({ deleted, entriesRemoved: deleted, hours });
});

// ── Logos ─────────────────────────────────────────────────────────────────────

app.post('/api/logos/:station', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename, url: '/api/logos/img/' + req.file.filename });
});

// Logo from URL
app.post('/api/logos/:station/url', async (req, res) => {
  const { logoUrl } = req.body;
  if (!logoUrl) return res.status(400).json({ error: 'logoUrl required' });
  try {
    const result = await httpGet(logoUrl, { binary: true, timeout: 8000 });
    const buf = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'binary');
    // Detect extension from content-type first, then URL
    const ct = (result.headers['content-type'] || '').toLowerCase();
    let ext = 'png';
    if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('png')) ext = 'png';
    else if (ct.includes('gif')) ext = 'gif';
    else if (ct.includes('webp')) ext = 'webp';
    else if (ct.includes('svg')) ext = 'svg';
    else {
      const m = logoUrl.split('?')[0].match(/\.(png|jpg|jpeg|gif|webp|svg)$/i);
      if (m) ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    }
    const slug = path.basename(req.params.station).replace(/[^a-zA-Z0-9_-]/g, '_');
    // Remove any existing logo for this station (different ext) to avoid stale files
    try {
      fs.readdirSync(LOGOS_DIR).filter(f => f.replace(/\.[^.]+$/, '') === slug).forEach(f => fs.unlinkSync(path.join(LOGOS_DIR, f)));
    } catch(_) {}
    const filename = slug + '.' + ext;
    fs.writeFileSync(path.join(LOGOS_DIR, filename), buf);
    res.json({ filename, url: '/api/logos/img/' + filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logos/img/:filename', (req, res) => {
  const fp = safeLogoPath(req.params.filename);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(fp);
});

app.post('/api/logos/clear-all', (req, res) => {
  let removed = 0;
  try {
    if (fs.existsSync(LOGOS_DIR)) {
      fs.readdirSync(LOGOS_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f)).forEach(f => { fs.unlinkSync(path.join(LOGOS_DIR, f)); removed++; });
    }
    res.json({ message: 'Cleared', removed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logos', (req, res) => {
  try {
    const files = fs.existsSync(LOGOS_DIR) ? fs.readdirSync(LOGOS_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f)) : [];
    res.json(files.map(f => ({ station: f.replace(/\.[^.]+$/, ''), filename: f, url: '/api/logos/img/' + f })));
  } catch(e) { res.json([]); }
});

app.delete('/api/logos/:station', (req, res) => {
  const safeStation = path.basename(req.params.station).replace(/[^a-zA-Z0-9_-]/g, '_');
  const files = fs.existsSync(LOGOS_DIR) ? fs.readdirSync(LOGOS_DIR) : [];
  const match = files.find(f => f.startsWith(safeStation + '.') || f === safeStation);
  if (!match) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(path.join(LOGOS_DIR, match));
  res.json({ message: 'Deleted' });
});

// ── Stations ──────────────────────────────────────────────────────────────────

app.get('/api/stations', (req, res) => res.json(loadStationsData()));

// Repair corrupted metadata URLs in saved stations
app.post('/api/stations/repair-urls', (req, res) => {
  try {
    const stations = loadStationsData();
    let fixed = 0;
    stations.forEach(s => {
      if (s.metadataUrl) {
        const clean = sanitizeUrl(s.metadataUrl);
        // Fix Bell Triton URLs — rebuild from callsign
        // Rebuild Triton URLs from callsign — catches all corruption variants
        if (s.metadataUrl.includes('tritondigital')) {
          const cs = normCallsign(s.callsign || s.name);
          const expected = tritonMetaUrl(cs);
          if (s.metadataUrl !== expected) {
            s.metadataUrl = expected;
            fixed++;
          }
        } else if (clean !== s.metadataUrl) {
          s.metadataUrl = clean;
          fixed++;
        }
        // Rebuild Corus URLs from callsign — catches all corruption variants
        if (s.metadataUrl && s.metadataUrl.includes('globalnewselection')) {
          const cs = normCallsign(s.callsign || s.name);
          const expected = corusMetaUrl(cs);
          if (s.metadataUrl !== expected) {
            s.metadataUrl = expected;
            fixed++;
          }
        }
        // Strip eventType=track from Triton URLs
        if (s.metadataUrl && s.metadataUrl.includes('tritondigital') && s.metadataUrl.includes('eventType=track')) {
          s.metadataUrl = s.metadataUrl.replace('&eventType=track', '').replace('&numberToFetch=1&eventType=track', '&numberToFetch=1');
          fixed++;
        }
      }
    });
    saveStationsData(stations);
    res.json({ fixed, total: stations.length, stations });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stations', (req, res) => {
  const { name, callsign, streamUrl, metadataUrl, metadataSource, network, group, pollInterval, stallThreshold, triggerMode, triggerKeywords } = req.body;
  if (!name || !streamUrl) return res.status(400).json({ error: 'name and streamUrl required' });
  const stations = loadStationsData();
  const existing = stations.findIndex(s => s.name === name);
  const station = { name, callsign: callsign || '', streamUrl, metadataUrl: metadataUrl || '', metadataSource: metadataSource || 'auto', network: network || '', group: group || 'Other', pollInterval: pollInterval || 10, stallThreshold: stallThreshold || 60, triggerMode: triggerMode || 'hybrid', triggerKeywords: triggerKeywords || '' };
  if (existing >= 0) stations[existing] = station;
  else stations.push(station);
  saveStationsData(stations);
  res.json({ message: 'Saved', station });
});

app.delete('/api/stations/:name', (req, res) => {
  saveStationsData(loadStationsData().filter(s => s.name !== req.params.name));
  res.json({ message: 'Deleted' });
});

// ── Station groups ────────────────────────────────────────────────────────────

app.get('/api/groups', (req, res) => {
  const stations = loadStationsData();
  const groups = {};
  stations.forEach(s => {
    const g = s.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });
  res.json(groups);
});

// ── Music history (metadata log) ──────────────────────────────────────────────

app.get('/api/metalog/:station', (req, res) => {
  const slug = req.params.station.replace(/[^a-zA-Z0-9_-]/g, '_');
  const lf = path.join(RECORDINGS_DIR, slug + '-metadata.json');
  if (!fs.existsSync(lf)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(lf, 'utf8'))); } catch(_) { res.json([]); }
});

app.delete('/api/metalog/:station', (req, res) => {
  const slug = req.params.station.replace(/[^a-zA-Z0-9_-]/g, '_');
  const lf = path.join(RECORDINGS_DIR, slug + '-metadata.json');
  if (fs.existsSync(lf)) fs.unlinkSync(lf);
  res.json({ message: 'Cleared' });
});

// Apply MusicBrainz (or manual) metadata to a logged song entry, matched by time
app.patch('/api/metalog/:station/entry', (req, res) => {
  const slug = req.params.station.replace(/[^a-zA-Z0-9_-]/g, '_');
  const lf = path.join(RECORDINGS_DIR, slug + '-metadata.json');
  if (!fs.existsSync(lf)) return res.status(404).json({ error: 'No log for station' });
  const { time, artist, songTitle, album, year, albumart } = req.body;
  if (!time) return res.status(400).json({ error: 'time required to identify entry' });
  try {
    const entries = JSON.parse(fs.readFileSync(lf, 'utf8'));
    const entry = entries.find(e => String(e.time) === String(time));
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (artist    !== undefined) entry.artist    = artist;
    if (songTitle !== undefined) entry.songTitle = songTitle;
    if (album     !== undefined) entry.album     = album;
    if (year      !== undefined) entry.year      = year;
    if (albumart  !== undefined) entry.albumart  = albumart;
    entry.title = (artist && songTitle) ? (artist + ' - ' + songTitle) : (songTitle || entry.title);
    entry.mbApplied = true;
    fs.writeFileSync(lf, JSON.stringify(entries, null, 2));
    res.json({ message: 'Updated', entry });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Purge metalog entries older than N days (per-station or all stations)
app.post('/api/metalog/purge', (req, res) => {
  const days = parseFloat(req.body.days) || 30;
  const station = req.body.station; // optional — if omitted, purge all stations
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let filesProcessed = 0, entriesRemoved = 0;
  try {
    const files = fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('-metadata.json'));
    for (const f of files) {
      if (station) {
        const slug = station.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (f !== slug + '-metadata.json') continue;
      }
      const lf = path.join(RECORDINGS_DIR, f);
      let entries;
      try { entries = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch(_) { continue; }
      if (!Array.isArray(entries)) continue;
      const before = entries.length;
      const kept = entries.filter(e => {
        const t = typeof e.time === 'number' ? e.time : Date.parse(e.time);
        return isNaN(t) ? true : t >= cutoff;  // keep if unparseable, drop if older than cutoff
      });
      if (kept.length !== before) {
        fs.writeFileSync(lf, JSON.stringify(kept, null, 2));
        entriesRemoved += (before - kept.length);
      }
      filesProcessed++;
    }
    res.json({ message: 'Purged', filesProcessed, entriesRemoved, days });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Advertisers ───────────────────────────────────────────────────────────────

app.get('/api/advertisers', (req, res) => res.json(loadJSON(ADVERTISERS_FILE, {})));

app.get('/api/advertisers/:station', (req, res) => {
  const db = loadJSON(ADVERTISERS_FILE, {});
  res.json(db[req.params.station] || {});
});

// ── Settings / purge ──────────────────────────────────────────────────────────

app.get('/api/settings/purge', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch(_) { res.json({ autoPurgeEnabled: false, autoPurgeHours: 24 }); }
});

app.post('/api/settings/purge', (req, res) => {
  const settings = { autoPurgeEnabled: !!req.body.autoPurgeEnabled, autoPurgeHours: parseFloat(req.body.autoPurgeHours) || 24 };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  scheduleAutoPurge(settings);
  res.json(settings);
});

let autoPurgeTimer = null;
function scheduleAutoPurge(s) {
  if (autoPurgeTimer) clearInterval(autoPurgeTimer);
  if (!s.autoPurgeEnabled) return;
  autoPurgeTimer = setInterval(() => {
    const cutoff = Date.now() - (s.autoPurgeHours * 60 * 60 * 1000);
    try { fs.readdirSync(RECORDINGS_DIR).filter(f => /\.(mp3|aac|ogg)$/i.test(f)).forEach(f => { const fp = path.join(RECORDINGS_DIR, f); if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); }); } catch(e) {}
  }, s.autoPurgeHours * 60 * 60 * 1000);
}
try { scheduleAutoPurge(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch(_) {}

// ── 30-day history auto-purge ────────────────────────────────────────────────
// Runs daily, removes commercial/music metadata log entries older than 30 days.
function purgeOldHistory(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const files = fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('-metadata.json'));
    for (const f of files) {
      const lf = path.join(RECORDINGS_DIR, f);
      let entries;
      try { entries = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch(_) { continue; }
      if (!Array.isArray(entries)) continue;
      const before = entries.length;
      const kept = entries.filter(e => {
        const t = typeof e.time === 'number' ? e.time : Date.parse(e.time);
        return isNaN(t) ? true : t >= cutoff;
      });
      if (kept.length !== before) {
        fs.writeFileSync(lf, JSON.stringify(kept, null, 2));
        removed += (before - kept.length);
      }
    }
    if (removed) console.log('[auto-purge] removed', removed, 'history entries older than', days, 'days');
  } catch(e) { console.error('[auto-purge]', e.message); }
}
// ── Acoustic Fingerprints (Ads & Music) ───────────────────────────────────────

app.get('/api/fingerprints', (req, res) => {
  res.json(loadJSON(FINGERPRINTS_FILE, []));
});

app.get('/api/fingerprints/ads', (req, res) => {
  res.json(loadJSON(FINGERPRINTS_FILE, []));
});

app.get('/api/fingerprints/music', (req, res) => {
  res.json(loadJSON(MUSIC_FINGERPRINTS_FILE, []));
});

app.get('/api/fingerprints/stats', (req, res) => {
  const ads = loadJSON(FINGERPRINTS_FILE, []);
  const music = loadJSON(MUSIC_FINGERPRINTS_FILE, []);
  res.json({
    adCount: ads.length,
    musicCount: music.length,
    totalPlays: ads.reduce((s, a) => s + (a.playCount || 1), 0) + music.reduce((s, m) => s + (m.playCount || 1), 0)
  });
});

app.delete('/api/fingerprints/ads/:id', (req, res) => {
  let ads = loadJSON(FINGERPRINTS_FILE, []);
  ads = ads.filter(a => a.id !== req.params.id && a.filename !== req.params.id);
  saveJSON(FINGERPRINTS_FILE, ads);
  res.json({ success: true, count: ads.length });
});

app.delete('/api/fingerprints/music/:id', (req, res) => {
  let music = loadJSON(MUSIC_FINGERPRINTS_FILE, []);
  music = music.filter(m => m.id !== req.params.id);
  saveJSON(MUSIC_FINGERPRINTS_FILE, music);
  res.json({ success: true, count: music.length });
});

app.post('/api/tools/identify-audio', async (req, res) => {
  const { url, filename, durationSeconds = 10, clientKey } = req.body;
  let target = url;
  if (!target && filename) {
    target = safeRecordingPath(filename);
  }
  if (!target) return res.status(400).json({ error: 'Stream URL or filename is required' });

  const aiSettings = loadJSON(SETTINGS_FILE, {});
  const key = clientKey || aiSettings.acoustidApiKey || process.env.ACOUSTID_CLIENT_KEY || '';

  try {
    const result = await audioDsp.sampleAndIdentifyAudio(target, {
      adDbFile: FINGERPRINTS_FILE,
      musicDbFile: MUSIC_FINGERPRINTS_FILE,
      clientKey: key,
      durationSeconds: Math.min(15, Math.max(3, parseInt(durationSeconds) || 10))
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI & Transcription Settings ─────────────────────────────────────────────

app.get('/api/settings/ai', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  res.json({
    hasGroqKey: !!(settings.groqApiKey || process.env.GROQ_API_KEY),
    hasOpenaiKey: !!(settings.openaiApiKey || process.env.OPENAI_API_KEY),
    hasAnthropicKey: !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
    hasAcoustidKey: !!(settings.acoustidApiKey || process.env.ACOUSTID_CLIENT_KEY),
    whisperModel: settings.whisperModel || process.env.WHISPER_MODEL || 'tiny',
    whisperLanguage: settings.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
  });
});

app.post('/api/settings/ai', (req, res) => {
  const settings = loadJSON(SETTINGS_FILE, {});
  if (req.body.groqApiKey !== undefined) settings.groqApiKey = req.body.groqApiKey.trim();
  if (req.body.openaiApiKey !== undefined) settings.openaiApiKey = req.body.openaiApiKey.trim();
  if (req.body.anthropicApiKey !== undefined) settings.anthropicApiKey = req.body.anthropicApiKey.trim();
  if (req.body.acoustidApiKey !== undefined) settings.acoustidApiKey = req.body.acoustidApiKey.trim();
  if (req.body.whisperModel) settings.whisperModel = req.body.whisperModel.trim();
  if (req.body.whisperLanguage) settings.whisperLanguage = req.body.whisperLanguage.trim();
  saveJSON(SETTINGS_FILE, settings);
  res.json({ message: 'Settings saved' });
});

app.post('/api/recordings/retranscribe/:name', async (req, res) => {
  const audioPath = safeRecordingPath(req.params.name);
  if (!audioPath || !fs.existsSync(audioPath)) return res.status(404).json({ error: 'Not found' });
  const stationName = req.params.name.split('-')[0].replace(/_/g, ' ');
  transcribeAndExtract(req.params.name, stationName);
  res.json({ message: 'Transcription queued' });
});

app.listen(3000, () => console.log('Barracuda API on :3000'));
