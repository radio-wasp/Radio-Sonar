const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Known Brand Dictionary for Offline Extraction ───────────────────────────
const KNOWN_BRANDS = [
  // Fast Food & Dining
  'Tim Hortons', 'McDonald\'s', 'Subway', 'A&W', 'Wendy\'s', 'Burger King', 'Dairy Queen',
  'Starbucks', 'Boston Pizza', 'Swiss Chalet', 'Harvey\'s', 'KFC', 'Pizza Pizza', 'Domino\'s',
  'Little Caesars', 'Mary Brown\'s', 'Booster Juice', 'Pita Pit', 'Osmow\'s', 'Montana\'s',

  // Retail & Grocery
  'Canadian Tire', 'Home Depot', 'Walmart', 'Costco', 'IKEA', 'Lowe\'s', 'Rona', 'Home Hardware',
  'Best Buy', 'Mark\'s', 'Sport Chek', 'Winners', 'Marshalls', 'Homesense', 'Dollarama',
  'Loblaws', 'No Frills', 'Real Canadian Superstore', 'Shoppers Drug Mart', 'Rexall',
  'Sobeys', 'Safeway', 'Foodland', 'FreshCo', 'Metro', 'Food Basics', 'Giant Tiger',
  'Sleep Country', 'Leon\'s', 'The Brick', 'Structube', 'Indigo',

  // Telecom & Tech
  'Bell', 'Rogers', 'Telus', 'Fido', 'Koodo', 'Virgin Plus', 'Freedom Mobile', 'Chatr',
  'Apple', 'Samsung', 'Google', 'Amazon', 'Microsoft', 'Shaw', 'Cogeco', 'Videotron',

  // Banking, Insurance & Finance
  'RBC', 'Royal Bank of Canada', 'TD Canada Trust', 'TD Bank', 'Scotiabank', 'BMO', 'Bank of Montreal',
  'CIBC', 'National Bank', 'Desjardins', 'Tangerine', 'Simplii Financial', 'Manulife', 'Sun Life',
  'Intact Insurance', 'Belairdirect', 'Co-operators', 'Allstate', 'CAA', 'BCAA', 'AMA',

  // Automotive & Gas
  'Petro-Canada', 'Esso', 'Shell', 'Pioneer', 'Chevron', 'Mobil', 'Ultramar', 'Co-op Gas',
  'Ford', 'Chevrolet', 'GMC', 'Toyota', 'Honda', 'Hyundai', 'Kia', 'Subway', 'Nissan',
  'Subaru', 'Mazda', 'Volkswagen', 'Audi', 'BMW', 'Mercedes-Benz', 'Jeep', 'Ram', 'Dodge',
  'Kal Tire', 'OK Tire', 'Mr. Lube', 'Jiffy Lube', 'Midas', 'Fountain Tire', 'Speedy Auto Glass',

  // Travel, Entertainment & Services
  'Air Canada', 'WestJet', 'Porter Airlines', 'Sunwing', 'Expedia', 'Booking.com',
  'Cineplex', 'Casino Rama', 'OLG', 'Lotto Max', 'Lotto 6/49', 'BCLC', 'Loto-Québec',
  'Indeed', 'SkipTheDishes', 'DoorDash', 'Uber Eats', 'Instacart', '1-800-GOT-JUNK',
  'Mister Transmission', 'Reliance Home Comfort', 'Enercare'
];

/**
 * Offline rule-based brand and entity extractor (works with zero API keys).
 * @param {string} transcript - Text transcript of the commercial
 * @returns {Array<string>} List of detected brand names
 */
function extractBrandsOffline(transcript) {
  if (!transcript || typeof transcript !== 'string') return [];
  const found = new Set();
  const lowerTranscript = transcript.toLowerCase();

  // 1. Direct dictionary lookup
  for (const brand of KNOWN_BRANDS) {
    const brandLower = brand.toLowerCase();
    // Word boundary check
    const regex = new RegExp(`\\b${brandLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(transcript)) {
      found.add(brand);
    }
  }

  // 2. Pattern Matching: "visit [Domain/Brand]", "sponsored by [Brand]", "at your local [Brand]"
  const patterns = [
    /(?:visit|shop at|browse|go to)\s+([a-zA-Z0-9-]+\.(?:ca|com|org|net))/gi,
    /(?:brought to you by|sponsored by|presented by)\s+([A-Z][A-Za-z0-9'&.\s]{2,30})(?=[,\.]|\s+and|\s+or|\s+at|$)/g,
    /(?:at your (?:local|nearest))\s+([A-Z][A-Za-z0-9'&.\s]{2,25})/g,
    /(?:call|contact)\s+([A-Z][A-Za-z0-9'&.\s]{2,25})\s+(?:today|now|at\s+1-800|at\s+\d)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(transcript)) !== null) {
      const candidate = match[1].trim().replace(/[.,;:]$/, '');
      if (candidate.length >= 3 && !['Today', 'Now', 'The', 'Our', 'Your'].includes(candidate)) {
        found.add(candidate);
      }
    }
  }

  return Array.from(found);
}

/**
 * Transcribe audio file using Groq Cloud, OpenAI Cloud, or Local Whisper CLI.
 * @param {string} audioPath - Path to MP3 file
 * @param {object} settings - { groqApiKey, openaiApiKey, whisperModel, whisperLanguage }
 * @returns {Promise<string>} Transcript text
 */
async function transcribeAudio(audioPath, settings = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const groqKey = settings.groqApiKey || process.env.GROQ_API_KEY;
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  const model = settings.whisperModel || process.env.WHISPER_MODEL || 'tiny';
  const language = settings.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en';

  // ── 1. Provider 1: Groq Cloud Whisper (Ultra-fast ~300ms) ────────────────
  if (groqKey) {
    try {
      console.log('[transcribe] Using Groq Cloud Whisper API...');
      const fileBuffer = fs.readFileSync(audioPath);
      const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
      const formData = new FormData();
      formData.append('file', blob, path.basename(audioPath));
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('language', language);
      formData.append('response_format', 'json');

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        return (data.text || '').trim();
      }
      console.warn(`[transcribe] Groq API returned ${res.status}, falling back...`);
    } catch (e) {
      console.warn('[transcribe] Groq API error:', e.message);
    }
  }

  // ── 2. Provider 2: OpenAI Cloud Whisper ──────────────────────────────────
  if (openaiKey) {
    try {
      console.log('[transcribe] Using OpenAI Cloud Whisper API...');
      const fileBuffer = fs.readFileSync(audioPath);
      const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
      const formData = new FormData();
      formData.append('file', blob, path.basename(audioPath));
      formData.append('model', 'whisper-1');
      formData.append('language', language);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData
      });

      if (res.ok) {
        const data = await res.json();
        return (data.text || '').trim();
      }
      console.warn(`[transcribe] OpenAI API returned ${res.status}, falling back...`);
    } catch (e) {
      console.warn('[transcribe] OpenAI API error:', e.message);
    }
  }

  // ── 3. Provider 3: Local Python Whisper CLI ──────────────────────────────
  console.log(`[transcribe] Running local Whisper CLI (model: ${model})...`);
  const tmpDir = `/tmp/whisper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    execFileSync('whisper', [
      audioPath,
      '--model', model,
      '--output_format', 'txt',
      '--output_dir', tmpDir,
      '--language', language
    ], { timeout: 180000 });

    const txtFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.txt'));
    const transcript = txtFiles.length ? fs.readFileSync(path.join(tmpDir, txtFiles[0]), 'utf8').trim() : '';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return transcript;
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    throw new Error(`Local Whisper execution failed: ${e.message}`);
  }
}

/**
 * Extract advertisers and company names from transcript text.
 * @param {string} transcript - Speech text
 * @param {object} settings - { groqApiKey, openaiApiKey, anthropicApiKey }
 * @returns {Promise<Array<string>>}
 */
async function extractAdvertisers(transcript, settings = {}) {
  if (!transcript || !transcript.trim()) return [];

  const groqKey = settings.groqApiKey || process.env.GROQ_API_KEY;
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  const anthropicKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

  const prompt = `This transcript contains one or more radio commercial spots that aired during a station break.
Carefully identify and extract EVERY commercial sponsor, business, brand name, store, company, service, or advertiser mentioned.
There may be MULTIPLE distinct advertisers in this single audio break.
Return ONLY a valid JSON array of strings containing all distinct advertiser names found, e.g. ["Tim Hortons", "Canadian Tire", "Subway"].
If no commercial advertisers or brand names are found, return [].
Do NOT return explanations or prose, ONLY the JSON array.

Transcript:
${transcript}`;

  let aiBrands = [];

  // 1. Groq (Llama 3.1 8B Instant - very fast)
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });
      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(content);
        const list = Array.isArray(parsed) ? parsed : Object.values(parsed)[0];
        if (Array.isArray(list)) aiBrands = list.filter(b => typeof b === 'string' && b.trim());
      }
    } catch (e) {
      console.warn('[extract] Groq extraction error:', e.message);
    }
  }

  // 2. OpenAI (GPT-4o-mini)
  if (!aiBrands.length && openaiKey) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1
        })
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content || '[]';
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed)) aiBrands = parsed.filter(b => typeof b === 'string' && b.trim());
      }
    } catch (e) {
      console.warn('[extract] OpenAI extraction error:', e.message);
    }
  }

  // 3. Anthropic (Claude 3.5 Haiku)
  if (!aiBrands.length && anthropicKey) {
    try {
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (res.ok) {
        const aiData = await res.json();
        const raw = aiData.content?.[0]?.text || '[]';
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed)) aiBrands = parsed.filter(b => typeof b === 'string' && b.trim());
      }
    } catch (e) {
      console.warn('[extract] Anthropic extraction error:', e.message);
    }
  }

  // Combine AI extractions with offline dictionary matching to ensure nothing is missed
  const offlineBrands = extractBrandsOffline(transcript);
  const combined = new Map();

  aiBrands.forEach(b => {
    const key = b.toLowerCase().trim();
    if (key && !combined.has(key)) combined.set(key, b.trim());
  });

  offlineBrands.forEach(b => {
    const key = b.toLowerCase().trim();
    if (key && !combined.has(key)) combined.set(key, b.trim());
  });

  return Array.from(combined.values());
}

module.exports = {
  transcribeAudio,
  extractAdvertisers,
  extractBrandsOffline,
  KNOWN_BRANDS
};
