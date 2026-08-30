#!/usr/bin/env node
/**
 * Barracuda v2.1 Beta - Model Context Protocol (MCP) Server
 * Enables AI assistants (Antigravity, Claude Desktop, Cursor, Custom Agents)
 * to observe, inspect, diagnose, and control the Barracuda radio monitor & ad recording system.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const API_BASE = process.env.BARRACUDA_API_URL || 'http://127.0.0.1:3000';
const DEFAULT_RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/recordings';
const SETTINGS_FILE = path.join(DEFAULT_RECORDINGS_DIR, 'settings.json');
const STATIONS_FILE = path.join(DEFAULT_RECORDINGS_DIR, 'stations.json');
const ADVERTISERS_FILE = path.join(DEFAULT_RECORDINGS_DIR, 'advertisers.json');
const FINGERPRINTS_FILE = path.join(DEFAULT_RECORDINGS_DIR, 'ad_fingerprints.json');
const MUSIC_FINGERPRINTS_FILE = path.join(DEFAULT_RECORDINGS_DIR, 'music_fingerprints.json');

function getRecordingsDir() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (s.recordingsDir && typeof s.recordingsDir === 'string' && s.recordingsDir.trim()) {
        const d = s.recordingsDir.trim();
        if (!fs.existsSync(d)) try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
        return d;
      }
    }
  } catch (_) {}
  if (!fs.existsSync(DEFAULT_RECORDINGS_DIR)) try { fs.mkdirSync(DEFAULT_RECORDINGS_DIR, { recursive: true }); } catch (_) {}
  return DEFAULT_RECORDINGS_DIR;
}

// ── HTTP Helper to communicate with local Barracuda backend ──────────────────

function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Barracuda-MCP/2.1'
      },
      timeout: 15000
    };

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data);
        } catch (_) {
          resolve({ rawResponse: raw, statusCode: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `Backend API request failed: ${err.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Backend API request timed out' });
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// ── MCP Tool Definitions ─────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'barracuda_get_overview',
    description: 'Get a high-level operational overview of Barracuda v2.1 (active station monitors, recording breaks, total spots today, disk storage, and AI service status).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_list_monitors',
    description: 'List all radio station monitors, their live statuses (listening, recording, monitoring-ad), on-air song/commercial title, stream health, DSP triggers, and metadata feed info.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional filter by station name, callsign, or network (e.g. "Q104", "Rogers", "Bell")'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_manage_monitor',
    description: 'Control a station monitor: start, stop, restart, delete, or create a new radio stream monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'delete', 'create'],
          description: 'Action to perform on the monitor'
        },
        id: {
          type: 'string',
          description: 'Monitor ID (required for start, stop, restart, delete)'
        },
        url: {
          type: 'string',
          description: 'Audio stream URL or TuneIn profile URL (required for create/start)'
        },
        stationName: {
          type: 'string',
          description: 'Station name (e.g. "Q104", "Surge 105")'
        },
        network: {
          type: 'string',
          description: 'Broadcast network (e.g. "Stingray", "Rogers", "Bell", "Acadia", "Pattison")'
        },
        triggerMode: {
          type: 'string',
          enum: ['hybrid', 'cue', 'keyword', 'stall', 'silence', 'volume', 'fingerprint'],
          description: 'Ad detection trigger mode (default: hybrid)'
        },
        recordingEnabled: {
          type: 'boolean',
          description: 'Whether to record and segment commercial breaks'
        },
        transcribeEnabled: {
          type: 'boolean',
          description: 'Whether to automatically transcribe recorded spots using Whisper'
        }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_get_recent_commercials',
    description: 'Retrieve recently captured commercial breaks and discrete sliced commercial spots with durations, timestamps, and Whisper advertiser transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of recordings to return (default: 20)'
        },
        station: {
          type: 'string',
          description: 'Filter recordings by station name or slug (e.g. "JACK_92_9", "AVR")'
        },
        withTranscriptOnly: {
          type: 'boolean',
          description: 'Return only spots that have completed Whisper transcription'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_search_advertisers',
    description: 'Search the advertiser brand catalog across all radio stations to see detected sponsors, total airplays, station breakdowns, and spot transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Brand or sponsor name keyword (e.g. "McDonalds", "Subaru", "Tim Hortons")'
        },
        station: {
          type: 'string',
          description: 'Optional station filter'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_get_station_playlist',
    description: 'Get real-time music metadata log and now-playing history for any monitored station (timestamped list of songs identified on air).',
    inputSchema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: 'Station name or slug (e.g. "Q104", "FX101_9", "Move_100")'
        },
        limit: {
          type: 'integer',
          description: 'Number of recent song entries to return (default: 30)'
        }
      },
      required: ['station'],
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_sample_and_identify',
    description: 'Capture a 10–15 second live audio snippet from any radio stream URL and run acoustic fingerprinting (Shazam 150M+ engine, local ad database, and AcoustID) to see what is actively playing.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Stream URL or TuneIn profile URL'
        },
        filename: {
          type: 'string',
          description: 'Or local recorded audio filename in /recordings'
        },
        durationSeconds: {
          type: 'integer',
          description: 'Sample duration in seconds (5–15, default: 12)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_get_system_logs',
    description: 'Fetch recent live system logs, DSP audio segmentation events, silence markers, and ad transition diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'integer',
          description: 'Number of log lines to return (default: 50)'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_retranscribe_recording',
    description: 'Queue an existing commercial spot audio file for re-transcription and advertiser extraction using Whisper and Groq/OpenAI.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Audio filename in recordings (e.g. "JACK_92_9-2026-08-28T20-21-49-spot1.mp3")'
        }
      },
      required: ['filename'],
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_get_storage_info',
    description: 'Inspect recordings storage usage, total recorded MP3/AAC audio files, metadata JSON logs, and storage path.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_sdr_status',
    description: 'Get live RTL-SDR hardware detection status, current tuning frequency, modulation (FM/HD Radio), MER signal-to-noise ratio, and live RDS / HD Radio metadata.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'barracuda_sdr_tune',
    description: 'Tune the connected RTL-SDR USB receiver to a specified frequency (e.g. 105.1 MHz) in Analog FM+RDS or Digital HD Radio mode.',
    inputSchema: {
      type: 'object',
      properties: {
        freq: {
          type: 'number',
          description: 'Frequency in MHz (e.g. 105.1, 94.7, 88.5)'
        },
        mode: {
          type: 'string',
          enum: ['fm', 'hd'],
          description: 'Modulation: "fm" for Analog FM + RDS, "hd" for NRSC-5 Digital HD Radio'
        },
        program: {
          type: 'integer',
          description: 'Subchannel program index for HD Radio (0 for HD1, 1 for HD2, etc.)'
        },
        gain: {
          type: 'number',
          description: 'RF Tuner gain in dB (0 to 49.6) or leave null for AGC auto-gain'
        },
        ppm: {
          type: 'integer',
          description: 'PPM oscillator frequency correction offset'
        }
      },
      required: ['freq'],
      additionalProperties: false
    }
  }
];

// ── MCP Resources ────────────────────────────────────────────────────────────

const MCP_RESOURCES = [
  {
    uri: 'barracuda://status',
    name: 'Barracuda Status',
    description: 'Real-time operational status of all monitors, recordings, and audio engines',
    mimeType: 'application/json'
  },
  {
    uri: 'barracuda://monitors',
    name: 'Active Station Monitors',
    description: 'List of all active monitors and current on-air metadata',
    mimeType: 'application/json'
  },
  {
    uri: 'barracuda://advertisers',
    name: 'Advertiser Brand Database',
    description: 'Aggregated advertiser database and total play counts across stations',
    mimeType: 'application/json'
  }
];

// ── Tool Execution Handlers ──────────────────────────────────────────────────

async function executeTool(name, args = {}) {
  switch (name) {
    case 'barracuda_get_overview': {
      const [status, storage, aiSettings, fpStats] = await Promise.all([
        apiRequest('GET', '/api/status'),
        apiRequest('GET', '/api/storage/info'),
        apiRequest('GET', '/api/settings/ai'),
        apiRequest('GET', '/api/fingerprints/stats')
      ]);

      const monitors = Array.isArray(status) ? status : Object.values(status?.monitors || status || {});
      const activeMonitors = monitors.length;
      const recordingNow = monitors.filter(m => m.status === 'recording' || m.status === 'monitoring-ad').length;
      
      return {
        version: '3.0.0',
        timestamp: new Date().toISOString(),
        summary: {
          activeMonitors,
          recordingBreaksNow: recordingNow,
          totalStorageUsed: storage?.totalFormatted || 'N/A',
          totalRecordingsCount: storage?.totalFiles || 0,
          adFingerprintCatalogCount: fpStats?.adCount || 0,
          musicFingerprintCatalogCount: fpStats?.musicCount || 0
        },
        aiConfiguration: {
          whisperModel: aiSettings?.whisperModel || 'tiny',
          whisperLanguage: aiSettings?.whisperLanguage || 'en',
          hasGroqKey: !!aiSettings?.hasGroqKey,
          hasOpenaiKey: !!aiSettings?.hasOpenaiKey,
          hasAnthropicKey: !!aiSettings?.hasAnthropicKey,
          hasAcoustidKey: !!aiSettings?.hasAcoustidKey
        },
        monitors: monitors.map(m => ({
          id: m.id,
          stationName: m.options?.stationName || m.station || m.id,
          status: m.status,
          currentTitle: m.currentTitle || '(no title)',
          artist: m.currentArtist || null,
          song: m.currentSongTitle || null,
          network: m.options?.network || 'Other',
          triggerMode: m.options?.triggerMode || 'hybrid',
          recordingEnabled: !!m.options?.recordingEnabled
        }))
      };
    }

    case 'barracuda_list_monitors': {
      const status = await apiRequest('GET', '/api/status');
      let list = Array.isArray(status) ? status : Object.values(status?.monitors || status || {});
      if (args.filter) {
        const q = args.filter.toLowerCase();
        list = list.filter(m => {
          const name = (m.options?.stationName || m.station || m.id || '').toLowerCase();
          const call = (m.options?.callsign || '').toLowerCase();
          const net = (m.options?.network || '').toLowerCase();
          return name.includes(q) || call.includes(q) || net.includes(q);
        });
      }
      return {
        count: list.length,
        monitors: list
      };
    }

    case 'barracuda_manage_monitor': {
      const { action, id, url, stationName, network, triggerMode, recordingEnabled, transcribeEnabled } = args;
      if (action === 'start' || action === 'create') {
        if (!url && !id) return { error: 'url or id is required to start/create a monitor' };
        const payload = {
          url,
          stationName: stationName || 'Station',
          network: network || '',
          triggerMode: triggerMode || 'hybrid',
          recordingEnabled: recordingEnabled !== false,
          transcribeEnabled: transcribeEnabled !== false
        };
        const res = await apiRequest('POST', '/api/monitor', payload);
        return { message: 'Monitor started', result: res };
      }

      if (action === 'stop' || action === 'delete') {
        if (!id) return { error: 'id is required to stop/delete a monitor' };
        const res = await apiRequest('DELETE', `/api/monitor/${encodeURIComponent(id)}`);
        return { message: `Monitor ${id} stopped`, result: res };
      }

      if (action === 'restart') {
        if (!id) return { error: 'id is required to restart a monitor' };
        const status = await apiRequest('GET', '/api/status');
        const list = Array.isArray(status) ? status : Object.values(status?.monitors || status || {});
        const target = list.find(m => String(m.id) === String(id));
        if (!target) return { error: `Monitor ${id} not found` };
        await apiRequest('DELETE', `/api/monitor/${encodeURIComponent(id)}`);
        const res = await apiRequest('POST', '/api/monitor', {
          url: target.url,
          ...target.options
        });
        return { message: `Monitor ${id} restarted`, result: res };
      }

      return { error: `Unknown action: ${action}` };
    }

    case 'barracuda_get_recent_commercials': {
      const limit = parseInt(args.limit) || 20;
      const station = args.station ? args.station.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '_') : null;
      const recs = await apiRequest('GET', '/api/recordings');
      let files = Array.isArray(recs) ? recs : [];

      if (station) {
        files = files.filter(f => f.name.toLowerCase().startsWith(station));
      }

      const results = [];
      for (const f of files.slice(0, limit * 2)) {
        if (results.length >= limit) break;
        const meta = await apiRequest('GET', `/api/recordings/meta/${encodeURIComponent(f.name)}`);
        if (args.withTranscriptOnly && (!meta.transcript || !meta.transcript.trim())) {
          continue;
        }
        results.push({
          filename: f.name,
          size: f.size,
          sizeFormatted: (f.size / (1024 * 1024)).toFixed(2) + ' MB',
          modified: f.modified,
          station: f.name.split('-')[0].replace(/_/g, ' '),
          status: meta.status || 'pending',
          durationSeconds: meta.duration || null,
          brands: meta.brands || [],
          transcript: meta.transcript || null,
          spotsCount: meta.spots ? meta.spots.length : 0,
          spots: meta.spots || []
        });
      }

      return {
        count: results.length,
        recordings: results
      };
    }

    case 'barracuda_search_advertisers': {
      const q = (args.query || '').toLowerCase().trim();
      const st = args.station || null;
      const db = await apiRequest('GET', '/api/advertisers');
      const allBrands = [];

      for (const [stationName, brands] of Object.entries(db || {})) {
        if (st && !stationName.toLowerCase().includes(st.toLowerCase())) continue;
        for (const [brandName, info] of Object.entries(brands || {})) {
          if (!q || brandName.toLowerCase().includes(q) || (info.category || '').toLowerCase().includes(q)) {
            allBrands.push({
              brand: brandName,
              station: stationName,
              playCount: info.count || 1,
              firstSeen: info.firstSeen,
              lastSeen: info.lastSeen,
              sampleSpots: (info.spots || []).slice(0, 5)
            });
          }
        }
      }

      allBrands.sort((a, b) => b.playCount - a.playCount);
      return {
        query: args.query || null,
        count: allBrands.length,
        advertisers: allBrands.slice(0, 50)
      };
    }

    case 'barracuda_get_station_playlist': {
      const st = args.station.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      const limit = parseInt(args.limit) || 30;
      const log = await apiRequest('GET', `/api/metalog/${encodeURIComponent(st)}`);
      const entries = Array.isArray(log) ? log : [];
      return {
        station: args.station,
        totalLogged: entries.length,
        recentSongs: entries.slice(0, limit)
      };
    }

    case 'barracuda_sample_and_identify': {
      const res = await apiRequest('POST', '/api/tools/identify-audio', {
        url: args.url,
        filename: args.filename,
        durationSeconds: args.durationSeconds || 12
      });
      return res;
    }

    case 'barracuda_get_system_logs': {
      const linesCount = parseInt(args.lines) || 50;
      const res = await apiRequest('GET', `/api/logs?lines=${linesCount}`);
      return res;
    }

    case 'barracuda_retranscribe_recording': {
      if (!args.filename) return { error: 'filename is required' };
      const res = await apiRequest('POST', `/api/recordings/retranscribe/${encodeURIComponent(args.filename)}`);
      return res;
    }

    case 'barracuda_get_storage_info': {
      const res = await apiRequest('GET', '/api/storage/info');
      return res;
    }

    case 'barracuda_sdr_status': {
      const [status, devices, pool] = await Promise.all([
        apiRequest('GET', '/api/sdr/status'),
        apiRequest('GET', '/api/sdr/devices'),
        apiRequest('GET', '/api/sdr/pool/status')
      ]);
      return { status, devices, pool };
    }

    case 'barracuda_sdr_tune': {
      if (!args.freq) return { error: 'freq is required' };
      const res = await apiRequest('POST', '/api/sdr/tune', args);
      return res;
    }

    default:
      return { error: `Tool ${name} not found` };
  }
}

// ── Resource Handlers ────────────────────────────────────────────────────────

async function readResource(uri) {
  if (uri === 'barracuda://status') {
    const data = await executeTool('barracuda_get_overview');
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (uri === 'barracuda://monitors') {
    const data = await executeTool('barracuda_list_monitors');
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (uri === 'barracuda://advertisers') {
    const data = await executeTool('barracuda_search_advertisers');
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  if (uri.startsWith('barracuda://playlist/')) {
    const station = uri.replace('barracuda://playlist/', '');
    const data = await executeTool('barracuda_get_station_playlist', { station });
    return { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) };
  }
  throw new Error(`Resource ${uri} not found`);
}

// ── JSON-RPC 2.0 Stdio Dispatcher ────────────────────────────────────────────

function sendResponse(id, result, error = null) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendNotification(method, params = {}) {
  const msg = { jsonrpc: '2.0', method, params };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(line) {
  if (!line || !line.trim()) return;
  let req;
  try {
    req = JSON.parse(line.trim());
  } catch (e) {
    sendResponse(null, null, { code: -32700, message: 'Parse error' });
    return;
  }

  const { id, method, params } = req;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: {
            name: 'barracuda-mcp-server',
            version: '3.0.0'
          }
        });
        break;
      }

      case 'notifications/initialized': {
        break;
      }

      case 'ping': {
        sendResponse(id, {});
        break;
      }

      case 'tools/list': {
        sendResponse(id, { tools: MCP_TOOLS });
        break;
      }

      case 'tools/call': {
        const { name, arguments: toolArgs } = params || {};
        const result = await executeTool(name, toolArgs || {});
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
          ],
          isError: !!result.error
        });
        break;
      }

      case 'resources/list': {
        sendResponse(id, { resources: MCP_RESOURCES });
        break;
      }

      case 'resources/read': {
        const { uri } = params || {};
        const res = await readResource(uri);
        sendResponse(id, {
          contents: [
            {
              uri: res.uri,
              mimeType: res.mimeType,
              text: res.text
            }
          ]
        });
        break;
      }

      default: {
        if (id !== undefined && id !== null) {
          sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
        }
        break;
      }
    }
  } catch (err) {
    if (id !== undefined && id !== null) {
      sendResponse(id, null, { code: -32000, message: err.message });
    }
  }
}

// ── Main Entry ───────────────────────────────────────────────────────────────

function startStdio() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', handleMessage);
  rl.on('close', () => process.exit(0));

  process.stderr.write('[MCP] Barracuda v2.1 Beta MCP Server running on stdio\n');
}

if (require.main === module) {
  startStdio();
}

module.exports = {
  MCP_TOOLS,
  MCP_RESOURCES,
  executeTool,
  readResource
};
