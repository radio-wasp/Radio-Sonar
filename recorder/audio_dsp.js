const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

/**
 * Generate Chromaprint acoustic fingerprint using fpcalc binary.
 * @param {string} audioPath
 * @returns {object|null} { duration, fingerprint, raw }
 */
function generateFingerprint(audioPath) {
  if (!fs.existsSync(audioPath)) return null;

  try {
    const res = spawnSync('fpcalc', ['-raw', '-json', audioPath], { encoding: 'utf8', timeout: 20000 });
    if (res.error || res.status !== 0) {
      const resStd = spawnSync('fpcalc', ['-json', audioPath], { encoding: 'utf8', timeout: 20000 });
      if (!resStd.error && resStd.status === 0) {
        const data = JSON.parse(resStd.stdout);
        return {
          duration: data.duration || 0,
          fingerprint: data.fingerprint || '',
          raw: []
        };
      }
      return null;
    }
    const data = JSON.parse(res.stdout);
    return {
      duration: data.duration || 0,
      fingerprint: data.fingerprint || '',
      raw: data.raw || []
    };
  } catch (e) {
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

// ── 1. Commercial / Ad Fingerprint Catalog ───────────────────────────────────

/**
 * Save or update an acoustic fingerprint in the local ad fingerprint catalog.
 * @param {string} dbFile - Path to ad_fingerprints.json
 * @param {object} entry - { filename, station, duration, fingerprint, raw, brands, transcript }
 */
function catalogAdFingerprint(dbFile, entry) {
  try {
    let db = [];
    if (fs.existsSync(dbFile)) {
      try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (_) {}
    }
    if (!Array.isArray(db)) db = [];

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
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
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
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
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
  if (!fs.existsSync(dbFile) || !Array.isArray(queryRaw) || queryRaw.length === 0) {
    return { match: false, score: 0, entry: null };
  }

  try {
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if (!Array.isArray(db)) return { match: false, score: 0, entry: null };

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
    let db = [];
    if (fs.existsSync(dbFile)) {
      try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (_) {}
    }
    if (!Array.isArray(db)) db = [];

    const norm = (s) => (s || '').toLowerCase().trim();
    const songKey = `${norm(entry.artist)}|||${norm(entry.songTitle)}`;

    // Check by song title or raw fingerprint similarity
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
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
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
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
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
  if (!fs.existsSync(dbFile) || !Array.isArray(queryRaw) || queryRaw.length === 0) {
    return { match: false, score: 0, entry: null };
  }

  try {
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if (!Array.isArray(db)) return { match: false, score: 0, entry: null };

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
  if (!fingerprint) return { match: false };

  const key = clientKey || process.env.ACOUSTID_CLIENT_KEY || '8XaBELgH';
  const duration = Math.round(durationSeconds || 15);
  const url = `https://api.acoustid.org/v2/lookup?client=${key}&meta=recordings+releasegroups+compress&fingerprint=${encodeURIComponent(fingerprint)}&duration=${duration}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { match: false };

    const data = await res.json();
    if (data.status !== 'ok' || !data.results || !data.results.length) {
      return { match: false };
    }

    for (const result of data.results) {
      if (result.score >= 0.75 && result.recordings && result.recordings.length) {
        const rec = result.recordings[0];
        const artist = rec.artists ? rec.artists.map(a => a.name).join(', ') : (rec.artist || '');
        const songTitle = rec.title || '';
        const rg = rec.releasegroups ? rec.releasegroups[0] : {};
        const album = rg.title || null;
        const year = rg.date ? rg.date.split('-')[0] : null;
        const mbid = rec.id || null;

        if (artist && songTitle) {
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
  } catch (e) {
    console.warn('[audio_dsp] AcoustID lookup error:', e.message);
  }

  return { match: false };
}

// ── 4. Unified Live Stream Audio Identifier ─────────────────────────────────

/**
 * Capture an audio sample from a stream URL (or local file) and identify whether
 * it is a Commercial Ad or a Music Song using local catalogs and AcoustID.
 * @param {string} source - Stream URL (http/https) or local file path
 * @param {object} opts - { adDbFile, musicDbFile, durationSeconds: 5, clientKey }
 * @returns {Promise<object>} { type: 'ad'|'music'|'unknown', match: boolean, score: number, details: object }
 */
async function sampleAndIdentifyAudio(source, opts = {}) {
  const duration = opts.durationSeconds || 5;
  const adDbFile = opts.adDbFile;
  const musicDbFile = opts.musicDbFile;
  const clientKey = opts.clientKey;

  let samplePath = source;
  let isTemp = false;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    samplePath = `/tmp/sample_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
    isTemp = true;

    // Resolve TuneIn / RadioTime / PLS / M3U / ASX playlist wrapper if needed
    let streamUrl = source;
    if (streamUrl.includes('opml.radiotime.com') || streamUrl.includes('.ashx') || streamUrl.endsWith('.pls') || streamUrl.endsWith('.asx') || (streamUrl.endsWith('.m3u') && !streamUrl.includes('.m3u8'))) {
      try {
        const res = await fetch(streamUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          const body = await res.text();
          const lines = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));
          if (lines.length > 0) {
            streamUrl = lines[0];
          } else {
            const m = body.match(/url=["'](https?:\/\/[^"']+)["']/i) || body.match(/href=["'](https?:\/\/[^"']+)["']/i);
            if (m) streamUrl = m[1];
          }
        }
      } catch (_) {}
    }

    try {
      spawnSync('ffmpeg', [
        '-y',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', streamUrl,
        '-t', String(duration),
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '2',
        samplePath
      ], { timeout: 15000 });
    } catch (e) {
      if (isTemp && fs.existsSync(samplePath)) try { fs.unlinkSync(samplePath); } catch (_) {}
      return { type: 'unknown', match: false, error: 'Could not sample stream' };
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

    // 3. Query AcoustID Global Database (100M+ songs)
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
