const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function captureStreamSample(streamUrl, duration, samplePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', streamUrl,
      '-t', String(duration),
      '-vn',
      '-acodec', 'libmp3lame',
      '-ar', '44100',
      '-ac', '2',
      '-q:a', '2',
      samplePath
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error('FFmpeg sample timeout'));
    }, (duration + 12) * 1000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (fs.existsSync(samplePath) && fs.statSync(samplePath).size > 500) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run FFmpeg silencedetect on an audio file to locate inter-commercial gaps.
 * @param {string} audioPath - Path to the audio file
 * @param {object} opts - { noiseThreshold: '-35dB', minSilenceDuration: 0.25, minSpotDuration: 6 }
 * @returns {object} { duration: number, silences: Array, segments: Array }
 */
function detectSilenceBoundaries(audioPath, opts = {}) {
  const noise = opts.noiseThreshold || '-35dB';
  const duration = opts.minSilenceDuration || 0.25;
  const minSpot = opts.minSpotDuration || 6;

  if (!fs.existsSync(audioPath)) {
    return { duration: 0, silences: [], segments: [] };
  }

  try {
    const res = spawnSync('ffmpeg', [
      '-i', audioPath,
      '-af', `silencedetect=noise=${noise}:d=${duration}`,
      '-f', 'null',
      '-'
    ], { encoding: 'utf8', timeout: 30000 });

    const stderr = res.stderr || '';
    const silences = [];
    let currentStart = null;

    const lines = stderr.split('\n');
    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([\d.]+)/);
      if (startMatch) {
        currentStart = parseFloat(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
      if (endMatch && currentStart !== null) {
        const end = parseFloat(endMatch[1]);
        const dur = parseFloat(endMatch[2]);
        silences.push({ start: currentStart, end, duration: dur });
        currentStart = null;
      }
    }

    let totalDuration = 0;
    const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (durMatch) {
      totalDuration = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
    }

    if (totalDuration === 0 && silences.length > 0) {
      totalDuration = silences[silences.length - 1].end + 5;
    }

    const segments = [];
    let segStart = 0;

    for (const s of silences) {
      const segEnd = s.start;
      const segDur = segEnd - segStart;
      if (segDur >= minSpot) {
        segments.push({
          start: Math.max(0, Math.round(segStart * 100) / 100),
          end: Math.round(segEnd * 100) / 100,
          duration: Math.round(segDur * 100) / 100
        });
      }
      segStart = s.end;
    }

    if (totalDuration - segStart >= minSpot) {
      segments.push({
        start: Math.max(0, Math.round(segStart * 100) / 100),
        end: Math.round(totalDuration * 100) / 100,
        duration: Math.round((totalDuration - segStart) * 100) / 100
      });
    }

    return { duration: totalDuration, silences, segments };
  } catch (e) {
    console.error('[audio_dsp] detectSilenceBoundaries error:', e.message);
    return { duration: 0, silences: [], segments: [] };
  }
}

/**
 * Slice a parent commercial break into individual spot MP3s based on segments.
 * @param {string} audioPath - Source parent MP3 file
 * @param {string} outputDir - Directory to store sliced spots
 * @param {Array} segments - Array of { start, end, duration }
 * @returns {Array} List of created spot objects
 */
function segmentCommercialBreak(audioPath, outputDir, segments) {
  if (!segments || segments.length <= 1 || !fs.existsSync(audioPath)) {
    return [];
  }

  const baseName = path.basename(audioPath, path.extname(audioPath));
  const spotFiles = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const spotFilename = `${baseName}-spot${i + 1}.mp3`;
    const spotPath = path.join(outputDir, spotFilename);

    try {
      spawnSync('ffmpeg', [
        '-y',
        '-ss', String(seg.start),
        '-to', String(seg.end),
        '-i', audioPath,
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '2',
        spotPath
      ], { timeout: 30000 });

      if (fs.existsSync(spotPath) && fs.statSync(spotPath).size > 1024) {
        spotFiles.push({
          filename: spotFilename,
          path: spotPath,
          index: i + 1,
          start: seg.start,
          end: seg.end,
          duration: seg.duration
        });
      }
    } catch (e) {
      console.error(`[audio_dsp] Error creating spot ${spotFilename}:`, e.message);
    }
  }

  return spotFiles;
}

function parseFpcalcOutput(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  const str = stdout.trim();
  if (str.startsWith('{')) {
    try {
      const data = JSON.parse(str);
      return {
        duration: parseFloat(data.duration) || 0,
        fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : '',
        raw: Array.isArray(data.fingerprint) ? data.fingerprint : (Array.isArray(data.raw) ? data.raw : [])
      };
    } catch (_) {}
  }
  const durMatch = str.match(/DURATION=(\d+(\.\d+)?)/i);
  const fpMatch = str.match(/FINGERPRINT=([A-Za-z0-9_-]+)/i);
  const rawMatch = str.match(/FINGERPRINT=([0-9,-]+)/i);
  return {
    duration: durMatch ? parseFloat(durMatch[1]) : 0,
    fingerprint: fpMatch ? fpMatch[1] : '',
    raw: rawMatch ? rawMatch[1].split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : []
  };
}

/**
 * Generate Chromaprint acoustic fingerprint using fpcalc binary.
 * @param {string} audioPath
 * @returns {object|null} { duration, fingerprint, raw }
 */
function generateFingerprint(audioPath) {
  if (!fs.existsSync(audioPath)) return null;

  try {
    // 1. Standard base64 fingerprint (for AcoustID 100M+ cloud lookup)
    let resStd = spawnSync('fpcalc', ['-json', audioPath], { encoding: 'utf8', timeout: 20000 });
    let parsedStd = (resStd && resStd.stdout) ? parseFpcalcOutput(resStd.stdout) : null;
    if (!parsedStd || !parsedStd.fingerprint) {
      resStd = spawnSync('fpcalc', [audioPath], { encoding: 'utf8', timeout: 20000 });
      parsedStd = (resStd && resStd.stdout) ? parseFpcalcOutput(resStd.stdout) : null;
    }

    if (!parsedStd || !parsedStd.fingerprint) {
      console.warn('[audio_dsp] fpcalc stdout failed on:', audioPath);
      return null;
    }

    // 2. Raw integer array (for local bitwise XOR correlation)
    let rawArr = [];
    try {
      let resRaw = spawnSync('fpcalc', ['-raw', '-json', audioPath], { encoding: 'utf8', timeout: 20000 });
      let parsedRaw = (resRaw && resRaw.stdout) ? parseFpcalcOutput(resRaw.stdout) : null;
      if (!parsedRaw || !parsedRaw.raw.length) {
        resRaw = spawnSync('fpcalc', ['-raw', audioPath], { encoding: 'utf8', timeout: 20000 });
        parsedRaw = (resRaw && resRaw.stdout) ? parseFpcalcOutput(resRaw.stdout) : null;
      }
      if (parsedRaw && parsedRaw.raw && parsedRaw.raw.length) {
        rawArr = parsedRaw.raw;
      }
    } catch (_) {}

    return {
      duration: parsedStd.duration,
      fingerprint: parsedStd.fingerprint,
      raw: rawArr
    };
  } catch (e) {
    console.error('[audio_dsp] generateFingerprint error:', e.message);
    return null;
  }
}

/**
 * Calculate bitwise similarity between two Chromaprint raw integer arrays.
 * Compares 32-bit integer sub-fingerprints across sliding windows.
 * @param {Array<number>} raw1
 * @param {Array<number>} raw2
 * @returns {number} Score from 0.0 to 1.0
 */
function compareRawFingerprints(raw1, raw2) {
  if (!Array.isArray(raw1) || !Array.isArray(raw2) || raw1.length === 0 || raw2.length === 0) {
    return 0;
  }

  const [shorter, longer] = raw1.length <= raw2.length ? [raw1, raw2] : [raw2, raw1];
  if (shorter.length < 5) return 0;

  let maxSimilarity = 0;
  const maxOffset = longer.length - shorter.length;

  for (let offset = 0; offset <= maxOffset; offset += 2) {
    let matchingBits = 0;
    const totalBits = shorter.length * 32;

    for (let i = 0; i < shorter.length; i++) {
      const a = (shorter[i] >>> 0);
      const b = (longer[i + offset] >>> 0);
      const diff = (a ^ b) >>> 0;
      let count = 0;
      let temp = diff;
      while (temp > 0) {
        temp = (temp & (temp - 1)) >>> 0;
        count++;
      }
      matchingBits += (32 - count);
    }

    const sim = matchingBits / totalBits;
    if (sim > maxSimilarity) maxSimilarity = sim;
    if (maxSimilarity > 0.95) break;
  }

  return Math.round(maxSimilarity * 1000) / 1000;
}

// ── In-Memory Fingerprint Cache (Zero-Disk-I/O Fast Matching) ────────────────
const FP_CACHE = new Map();

function getCachedFingerprintDb(dbFile) {
  if (!fs.existsSync(dbFile)) return [];
  try {
    const stat = fs.statSync(dbFile);
    const cached = FP_CACHE.get(dbFile);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }
    const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const arr = Array.isArray(data) ? data : [];
    FP_CACHE.set(dbFile, { mtimeMs: stat.mtimeMs, data: arr });
    return arr;
  } catch (e) {
    return [];
  }
}

function saveFingerprintDb(dbFile, data) {
  try {
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
    const stat = fs.statSync(dbFile);
    FP_CACHE.set(dbFile, { mtimeMs: stat.mtimeMs, data });
  } catch (e) {
    console.error('[audio_dsp] saveFingerprintDb error:', e.message);
  }
}

// ── 1. Commercial / Ad Fingerprint Catalog ───────────────────────────────────

/**
 * Save or update an acoustic fingerprint in the local ad fingerprint catalog.
 * @param {string} dbFile - Path to ad_fingerprints.json
 * @param {object} entry - { filename, station, duration, fingerprint, raw, brands, transcript }
 */
function catalogAdFingerprint(dbFile, entry) {
  try {
    let db = [...getCachedFingerprintDb(dbFile)];

    let matchedIndex = -1;
    if (entry.raw && entry.raw.length) {
      for (let i = 0; i < db.length; i++) {
        const existing = db[i];
        if (existing.raw && existing.raw.length) {
          const sim = compareRawFingerprints(entry.raw, existing.raw);
          if (sim >= 0.85) {
            matchedIndex = i;
            break;
          }
        }
      }
    }

    const now = new Date().toISOString();
    if (matchedIndex >= 0) {
      const ex = db[matchedIndex];
      ex.playCount = (ex.playCount || 1) + 1;
      ex.lastSeen = now;
      if (entry.brands && entry.brands.length) {
        ex.brands = [...new Set([...(ex.brands || []), ...entry.brands])];
      }
      if (entry.transcript && !ex.transcript) {
        ex.transcript = entry.transcript;
      }
      if (!ex.stations) ex.stations = [];
      if (entry.station && !ex.stations.includes(entry.station)) ex.stations.push(entry.station);
      saveFingerprintDb(dbFile, db);
      return ex;
    } else {
      const newEntry = {
        id: 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        filename: entry.filename,
        station: entry.station || 'Unknown',
        stations: entry.station ? [entry.station] : [],
        duration: entry.duration || 0,
        fingerprint: entry.fingerprint || '',
        raw: entry.raw || [],
        brands: entry.brands || [],
        transcript: entry.transcript || '',
        firstSeen: now,
        lastSeen: now,
        playCount: 1
      };
      db.unshift(newEntry);
      if (db.length > 2500) db = db.slice(0, 2500);
      saveFingerprintDb(dbFile, db);
      return newEntry;
    }
  } catch (e) {
    console.error('[audio_dsp] catalogAdFingerprint error:', e.message);
    return null;
  }
}

/**
 * Search the ad fingerprint catalog for a match against query audio raw fingerprint.
 * @param {string} dbFile
 * @param {Array<number>} queryRaw
 * @param {number} threshold - Default 0.82
 * @returns {object} { match: boolean, score: number, entry: object|null }
 */
function findMatchingFingerprint(dbFile, queryRaw, threshold = 0.82) {
  if (!Array.isArray(queryRaw) || queryRaw.length === 0) {
    return { match: false, score: 0, entry: null };
  }

  try {
    const db = getCachedFingerprintDb(dbFile);
    if (!Array.isArray(db) || db.length === 0) return { match: false, score: 0, entry: null };

    let bestScore = 0;
    let bestEntry = null;

    for (const item of db) {
      if (item.raw && item.raw.length) {
        const score = compareRawFingerprints(queryRaw, item.raw);
        if (score > bestScore) {
          bestScore = score;
          bestEntry = item;
        }
      }
    }

    if (bestScore >= threshold && bestEntry) {
      return { match: true, score: bestScore, entry: bestEntry };
    }
  } catch (e) {
    console.error('[audio_dsp] findMatchingFingerprint error:', e.message);
  }

  return { match: false, score: 0, entry: null };
}

// ── 2. Music Fingerprint Catalog ─────────────────────────────────────────────

/**
 * Save or update a song fingerprint in the local music catalog.
 * @param {string} dbFile - Path to music_fingerprints.json
 * @param {object} entry - { artist, songTitle, album, year, duration, fingerprint, raw, mbid, station }
 */
function catalogMusicFingerprint(dbFile, entry) {
  if (!entry || !entry.artist || !entry.songTitle) return null;

  try {
    let db = [...getCachedFingerprintDb(dbFile)];

    const norm = (s) => (s || '').toLowerCase().trim();
    const songKey = `${norm(entry.artist)}|||${norm(entry.songTitle)}`;

    let matchedIndex = db.findIndex(m => `${norm(m.artist)}|||${norm(m.songTitle)}` === songKey);

    if (matchedIndex === -1 && entry.raw && entry.raw.length) {
      for (let i = 0; i < db.length; i++) {
        if (db[i].raw && db[i].raw.length) {
          const sim = compareRawFingerprints(entry.raw, db[i].raw);
          if (sim >= 0.85) {
            matchedIndex = i;
            break;
          }
        }
      }
    }

    const now = new Date().toISOString();
    if (matchedIndex >= 0) {
      const ex = db[matchedIndex];
      ex.playCount = (ex.playCount || 1) + 1;
      ex.lastSeen = now;
      if (entry.album && !ex.album) ex.album = entry.album;
      if (entry.year && !ex.year) ex.year = entry.year;
      if (entry.mbid && !ex.mbid) ex.mbid = entry.mbid;
      if (entry.station) {
        if (!ex.stations) ex.stations = [];
        if (!ex.stations.includes(entry.station)) ex.stations.push(entry.station);
      }
      saveFingerprintDb(dbFile, db);
      return ex;
    } else {
      const newEntry = {
        id: 'mfp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        artist: entry.artist,
        songTitle: entry.songTitle,
        album: entry.album || null,
        year: entry.year || null,
        mbid: entry.mbid || null,
        duration: entry.duration || 0,
        fingerprint: entry.fingerprint || '',
        raw: entry.raw || [],
        stations: entry.station ? [entry.station] : [],
        firstSeen: now,
        lastSeen: now,
        playCount: 1
      };
      db.unshift(newEntry);
      if (db.length > 5000) db = db.slice(0, 5000);
      saveFingerprintDb(dbFile, db);
      return newEntry;
    }
  } catch (e) {
    console.error('[audio_dsp] catalogMusicFingerprint error:', e.message);
    return null;
  }
}

/**
 * Search the local music catalog for a matching song fingerprint.
 * @param {string} dbFile
 * @param {Array<number>} queryRaw
 * @param {number} threshold - Default 0.82
 * @returns {object} { match: boolean, score: number, entry: object|null }
 */
function findMatchingMusicFingerprint(dbFile, queryRaw, threshold = 0.82) {
  if (!Array.isArray(queryRaw) || queryRaw.length === 0) {
    return { match: false, score: 0, entry: null };
  }

  try {
    const db = getCachedFingerprintDb(dbFile);
    if (!Array.isArray(db) || db.length === 0) return { match: false, score: 0, entry: null };

    let bestScore = 0;
    let bestEntry = null;

    for (const item of db) {
      if (item.raw && item.raw.length) {
        const score = compareRawFingerprints(queryRaw, item.raw);
        if (score > bestScore) {
          bestScore = score;
          bestEntry = item;
        }
      }
    }

    if (bestScore >= threshold && bestEntry) {
      return { match: true, score: bestScore, entry: bestEntry };
    }
  } catch (e) {
    console.error('[audio_dsp] findMatchingMusicFingerprint error:', e.message);
  }

  return { match: false, score: 0, entry: null };
}

// ── 3. AcoustID Global Cloud Music Recognition ─────────────────────────────

/**
 * Query AcoustID API (100M+ music tracks) using a Chromaprint string.
 * @param {string} fingerprint - Chromaprint compressed string from fpcalc
 * @param {number} durationSeconds - Duration of the audio
 * @param {string} clientKey - Optional AcoustID client key (defaults to official public key)
 * @returns {Promise<object>} { match: boolean, score: number, artist: string, songTitle: string, album: string, year: string, mbid: string }
 */
async function lookupAcoustId(fingerprint, durationSeconds, clientKey) {
  if (!fingerprint || typeof fingerprint !== 'string' || fingerprint.length < 10) {
    return { match: false };
  }

  const key = clientKey || process.env.ACOUSTID_CLIENT_KEY;
  if (!key) {
    return { match: false, error: 'AcoustID API key not configured' };
  }

  const duration = Math.max(3, Math.round(durationSeconds || 10));

  try {
    const params = new URLSearchParams();
    params.append('client', key);
    params.append('meta', 'recordings releasegroups tracks');
    params.append('fingerprint', fingerprint);
    params.append('duration', String(duration));

    const res = await fetch('https://api.acoustid.org/v2/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(8000)
    });

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) {}

    console.log(`[audio_dsp] AcoustID query HTTP ${res.status}: status=${data.status} results=${data.results ? data.results.length : 0}`);

    if (!res.ok || data.status !== 'ok' || !data.results || !data.results.length) {
      if (data.error) console.warn('[audio_dsp] AcoustID error:', data.error.message);
      return { match: false };
    }

    for (const result of data.results) {
      console.log(`[audio_dsp] Candidate match: score=${result.score} recordings=${result.recordings ? result.recordings.length : 0}`);
      if (result.recordings && result.recordings.length) {
        for (const rec of result.recordings) {
          const artist = rec.artists ? rec.artists.map(a => a.name).join(', ') : (rec.artist || '');
          const songTitle = rec.title || '';
          const rg = rec.releasegroups ? rec.releasegroups[0] : {};
          const album = rg.title || null;
          const year = rg.date ? rg.date.split('-')[0] : null;
          const mbid = rec.id || null;

          if (artist && songTitle) {
            console.log(`[audio_dsp] AcoustID MATCH (score ${result.score}): ${artist} - ${songTitle}`);
            return {
              match: true,
              score: result.score,
              artist,
              songTitle,
              album,
              year,
              mbid,
              acoustid: result.id
            };
          }
        }
      }
    }
  } catch (e) {
    console.warn('[audio_dsp] AcoustID query error:', e.message);
  }

  return { match: false };
}

/**
 * Identify a song audio sample using Apple Shazam (150M+ tracks, 0 API key required).
 * Uses Python shazamio worker in /opt/whisper-env/bin/python3 (or python3).
 * @param {string} samplePath - Local path to MP3/WAV/AAC audio sample
 * @returns {Promise<object>} { match: boolean, artist: string, songTitle: string, albumart: string, genre: string }
 */
function lookupShazam(samplePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(samplePath)) return resolve({ match: false });

    const pyBin = fs.existsSync('/opt/whisper-env/bin/python3') ? '/opt/whisper-env/bin/python3' : 'python3';
    const scriptPath = path.join(__dirname, 'shazam_recognize.py');

    if (!fs.existsSync(scriptPath)) {
      return resolve({ match: false, error: 'shazam_recognize.py missing' });
    }

    const proc = spawn(pyBin, [scriptPath, samplePath]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve({ match: false, error: 'Shazam lookup timeout' });
    }, 12000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(stdout.trim());
        if (res && res.match && res.title && res.artist) {
          console.log(`[audio_dsp] 🎧 SHAZAM MATCH: ${res.artist} - ${res.title}`);
          return resolve({
            match: true,
            source: 'shazam',
            score: res.score || 0.99,
            artist: res.artist,
            songTitle: res.title,
            albumart: res.albumart || null,
            genre: res.genre || null,
            shazamId: res.shazamId || null
          });
        }
      } catch (_) {}
      resolve({ match: false });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ match: false, error: err.message });
    });
  });
}

// ── 4. Unified Live Stream Audio Identifier ─────────────────────────────────

async function resolveDirectStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  url = url.trim();

  // 1. TuneIn / RadioTime stream broker
  if (url.includes('opml.radiotime.com') || url.includes('tunein.com/tune.ashx') || /Tune\.ashx\?id=(s?\d+)/i.test(url)) {
    const idMatch = url.match(/id=(s?\d+)/i);
    const guideId = idMatch ? idMatch[1] : '';
    if (guideId) {
      try {
        const tuneUrl = `https://opml.radiotime.com/Tune.ashx?id=${guideId}&render=json&partnerId=RadioTime&formats=mp3,aac,ogg`;
        const res = await fetch(tuneUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data.body) ? data.body : [data.body || {}];
          for (const item of items) {
            if (item && item.url && !item.url.includes('opml.radiotime.com')) {
              return await resolveDirectStreamUrl(item.url);
            }
          }
        }
      } catch (_) {}
    }
  }

  // 2. Playlists: PLS, M3U, ASX, StreamTheWorld
  if (url.includes('/pls') || url.includes('.pls') || url.includes('.asx') || url.includes('streamtheworld.com') || (url.includes('.m3u') && !url.includes('.m3u8'))) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const body = await res.text();
        // PLS File1=https://...
        const fileMatch = body.match(/File\d+=(https?:\/\/[^\r\n\s]+)/i);
        if (fileMatch) return await resolveDirectStreamUrl(fileMatch[1].trim());

        // M3U / general URL lines
        const lines = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http') && !l.endsWith('.pls') && !l.endsWith('.m3u'));
        if (lines.length > 0) return await resolveDirectStreamUrl(lines[0]);

        const m = body.match(/url=["'](https?:\/\/[^"']+)["']/i) || body.match(/href=["'](https?:\/\/[^"']+)["']/i) || body.match(/(https?:\/\/[^\r\n"'>\s]+)/i);
        if (m && !m[1].includes('opml.radiotime.com')) return await resolveDirectStreamUrl(m[1]);
      }
    } catch (_) {}
  }

  return url;
}

/**
 * Capture a 10–15s sample of live stream audio (or read file) and run
 * multi-tier acoustic fingerprinting against Ads -> Music -> Shazam -> AcoustID.
 * @param {string} source - Stream URL (http/https) or local file path
 * @param {object} opts - { adDbFile, musicDbFile, durationSeconds: 5, clientKey }
 * @returns {Promise<object>} { type: 'ad'|'music'|'unknown', match: boolean, score: number, details: object }
 */
async function sampleAndIdentifyAudio(source, opts = {}) {
  const duration = Math.max(8, opts.durationSeconds || 15);
  const adDbFile = opts.adDbFile;
  const musicDbFile = opts.musicDbFile;
  const clientKey = opts.clientKey;

  let samplePath = source;
  let isTemp = false;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    samplePath = `/tmp/sample_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
    isTemp = true;

    // Resolve TuneIn / RadioTime / PLS / M3U / ASX playlist wrapper to direct audio feed
    const streamUrl = await resolveDirectStreamUrl(source);

    try {
      await captureStreamSample(streamUrl, duration, samplePath);
    } catch (e) {
      console.warn(`[audio_dsp] captureStreamSample error for ${streamUrl.slice(0, 45)}:`, e.message);
      if (isTemp && fs.existsSync(samplePath)) try { fs.unlinkSync(samplePath); } catch (_) {}
      return { type: 'unknown', match: false, error: e.message };
    }
  }

  if (!fs.existsSync(samplePath)) {
    return { type: 'unknown', match: false, error: 'Sample file not found' };
  }

  try {
    const fp = generateFingerprint(samplePath);
    if (!fp || !fp.fingerprint) {
      if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
      return { type: 'unknown', match: false, error: 'Could not generate fingerprint' };
    }

    console.log(`[audio_dsp] Sampled ${source.slice(0, 45)}... duration=${fp.duration}s fpLength=${fp.fingerprint.length} rawCount=${fp.raw.length}`);

    // 1. Check Ad Catalog (Positive Commercial Recognition)
    if (adDbFile && fp.raw && fp.raw.length) {
      const adMatch = findMatchingFingerprint(adDbFile, fp.raw, 0.82);
      if (adMatch.match) {
        if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
        return {
          type: 'ad',
          match: true,
          source: 'ad_catalog',
          score: adMatch.score,
          details: adMatch.entry
        };
      }
    }

    // 2. Check Local Music Catalog (Positive Song Recognition)
    if (musicDbFile && fp.raw && fp.raw.length) {
      const musicMatch = findMatchingMusicFingerprint(musicDbFile, fp.raw, 0.82);
      if (musicMatch.match) {
        if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
        return {
          type: 'music',
          match: true,
          source: 'local_catalog',
          score: musicMatch.score,
          details: musicMatch.entry
        };
      }
    }

    // 3. Apple Shazam Cloud Recognition (150M+ songs, 0 API key required)
    const shazamMatch = await lookupShazam(samplePath);
    if (shazamMatch.match) {
      // Auto-catalog this song into local music database
      if (musicDbFile) {
        catalogMusicFingerprint(musicDbFile, {
          artist: shazamMatch.artist,
          songTitle: shazamMatch.songTitle,
          albumart: shazamMatch.albumart,
          genre: shazamMatch.genre,
          source: 'shazam',
          duration: fp.duration,
          fingerprint: fp.fingerprint,
          raw: fp.raw
        });
      }

      if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
      return {
        type: 'music',
        match: true,
        source: 'shazam',
        score: 0.99,
        details: shazamMatch
      };
    }

    // 4. Query AcoustID Global Database (if API key configured)
    const acoustMatch = await lookupAcoustId(fp.fingerprint, fp.duration, clientKey);
    if (acoustMatch.match) {
      // Auto-catalog this song into local music database
      if (musicDbFile) {
        catalogMusicFingerprint(musicDbFile, {
          artist: acoustMatch.artist,
          songTitle: acoustMatch.songTitle,
          album: acoustMatch.album,
          year: acoustMatch.year,
          mbid: acoustMatch.mbid,
          duration: fp.duration,
          fingerprint: fp.fingerprint,
          raw: fp.raw
        });
      }

      if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
      return {
        type: 'music',
        match: true,
        source: 'acoustid',
        score: acoustMatch.score,
        details: acoustMatch
      };
    }

    // 4. If station metadata actively provides confirmed artist & songTitle, catalog this fingerprint
    if (opts.currentArtist && opts.currentSongTitle && musicDbFile) {
      const candidateTitle = `${opts.currentArtist} - ${opts.currentSongTitle}`;
      if (candidateTitle.length > 3 && !candidateTitle.toLowerCase().includes('advert') && !candidateTitle.toLowerCase().includes('sponsor')) {
        catalogMusicFingerprint(musicDbFile, {
          artist: opts.currentArtist,
          songTitle: opts.currentSongTitle,
          station: opts.station || '',
          duration: fp.duration,
          fingerprint: fp.fingerprint,
          raw: fp.raw
        });
        if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
        return {
          type: 'music',
          match: true,
          source: 'stream_cataloged',
          score: 0.90,
          details: { artist: opts.currentArtist, songTitle: opts.currentSongTitle }
        };
      }
    }

    if (isTemp) try { fs.unlinkSync(samplePath); } catch (_) {}
    return {
      type: 'unknown',
      match: false,
      duration: fp.duration
    };
  } catch (e) {
    if (isTemp && fs.existsSync(samplePath)) try { fs.unlinkSync(samplePath); } catch (_) {}
    return { type: 'unknown', match: false, error: e.message };
  }
}

module.exports = {
  detectSilenceBoundaries,
  segmentCommercialBreak,
  generateFingerprint,
  compareRawFingerprints,
  catalogAdFingerprint,
  findMatchingFingerprint,
  catalogMusicFingerprint,
  findMatchingMusicFingerprint,
  lookupAcoustId,
  sampleAndIdentifyAudio
};
