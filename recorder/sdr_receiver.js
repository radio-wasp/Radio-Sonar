'use strict';

/**
 * sdr_receiver.js — RTL-SDR Off-Air Demodulator & Multi-Device Pool Manager
 * Radio SONAR Version 3.1
 *
 * Supports:
 * 1. Multi-Dongle Device Pooling: Run N physical RTL-SDR USB sticks concurrently.
 * 2. Single-Stick Wideband FM Channelizer: Demodulate multiple FM carriers from a single
 *    2.4 MHz IQ spectrum slice via Python DSP (wideband_channelizer.py).
 * 3. Analog FM Stereo with real-time RDS/RBDS decoding (rtl_fm + redsea + ffmpeg).
 * 4. NRSC-5 Digital HD Radio decoding (HD1–HD4) with MER/BER telemetry (nrsc5 + ffmpeg).
 * 5. Dynamic device auto-discovery, allocation, and health diagnostics.
 */

const { spawn, exec } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

class SdrWorker extends EventEmitter {
  constructor(id, options = {}) {
    super();
    this.id = id; // e.g. monitorId or 'default'
    this.deviceIndex = options.deviceIndex !== undefined ? options.deviceIndex : 0;
    this.deviceSerial = options.deviceSerial || null;
    this.isWideband = options.isWideband || false;
    this.clusterKey = options.clusterKey || null;

    this.procs = [];
    this.fifoPath = null;
    this.running = false;
    this.currentMode = null; // 'fm' | 'hd'
    this.currentFreq = null;
    this.currentProgram = 0;
    this.currentGain = null;
    this.currentPpm = 0;
    this.activeStationName = null;
    this.streamClients = [];

    this.state = {
      id: this.id,
      running: false,
      deviceIndex: this.deviceIndex,
      isWideband: this.isWideband,
      mode: null,
      frequency: null,
      program: 0,
      gain: null,
      syncState: 'IDLE', // 'IDLE' | 'RECEIVING' | 'SYNCING' | 'LOCKED' | 'UNSYNCED'
      mer: null,
      merLower: null,
      merUpper: null,
      ber: null,
      freqOffset: null,
      signal: null,
      signalPercent: null,
      dbfs: null,
      ps: '',
      rt: '',
      rtPlus: '',
      artist: '',
      title: '',
      station: '',
      album: '',
      pi: null,
      lastUpdate: 0,
    };
  }

  resetState() {
    this.state = {
      id: this.id,
      running: false,
      deviceIndex: this.deviceIndex,
      isWideband: this.isWideband,
      mode: null,
      frequency: null,
      program: 0,
      gain: null,
      syncState: 'IDLE',
      mer: null,
      merLower: null,
      merUpper: null,
      ber: null,
      freqOffset: null,
      signal: null,
      signalPercent: null,
      dbfs: null,
      ps: '',
      rt: '',
      rtPlus: '',
      artist: '',
      title: '',
      station: '',
      album: '',
      pi: null,
      lastUpdate: Date.now(),
    };
  }

  updateState(patches) {
    Object.assign(this.state, patches, { lastUpdate: Date.now() });
    this.emit('metadata', { ...this.state });
  }

  getStatus() {
    return {
      ...this.state,
      activeStationName: this.activeStationName,
    };
  }

  addClient(res) {
    this.streamClients.push(res);
    res.on('close', () => {
      const idx = this.streamClients.indexOf(res);
      if (idx !== -1) this.streamClients.splice(idx, 1);
    });
  }

  broadcastAudio(chunk) {
    for (let i = this.streamClients.length - 1; i >= 0; i--) {
      const client = this.streamClients[i];
      if (client.writableEnded || client.destroyed) {
        this.streamClients.splice(i, 1);
      } else {
        client.write(chunk);
      }
    }
    this.emit('audio', chunk);
  }

  _calculateAudioRms(chunk) {
    if (!chunk || chunk.length < 64) return;
    let sumSquares = 0;
    let count = 0;
    const len = Math.min(chunk.length, 2048);
    for (let i = 0; i < len; i += 2) {
      const val = chunk.readInt16LE ? chunk.readInt16LE(i) : (chunk[i] - 128) * 256;
      sumSquares += val * val;
      count++;
    }
    if (count > 0) {
      const rms = Math.sqrt(sumSquares / count);
      const dbfs = Math.max(-90, Math.min(0, 20 * Math.log10((rms + 1e-4) / 32768.0)));
      // Map audio level -60 dBFS .. -8 dBFS to 20% .. 98%
      const pct = Math.max(15, Math.min(99, Math.round(((dbfs + 65) / 55) * 100)));
      const signalStr = `${pct}% (${dbfs.toFixed(1)} dBFS)`;

      const now = Date.now();
      if (!this.state.signalPercent || Math.abs(pct - (this.state.signalPercent || 0)) >= 3 || (now - (this.state.lastUpdate || 0) > 2500)) {
        this.updateState({
          signalPercent: pct,
          dbfs: parseFloat(dbfs.toFixed(1)),
          signal: signalStr,
          syncState: this.state.syncState === 'IDLE' ? 'RECEIVING' : this.state.syncState,
        });
      }
    }
  }

  /**
   * Tune dedicated Analog FM with real-time RDS on a physical dongle
   */
  tuneFm(freqMhz, options = {}) {
    this.stop();
    this.running = true;
    this.currentMode = 'fm';
    this.currentFreq = freqMhz;
    this.currentGain = options.gain !== undefined ? options.gain : null;
    this.currentPpm = options.ppm || 0;
    this.activeStationName = options.stationName || `FM ${freqMhz} MHz`;

    this.resetState();
    this.updateState({
      running: true,
      mode: 'fm',
      frequency: freqMhz,
      gain: this.currentGain,
      syncState: 'RECEIVING',
      station: this.activeStationName,
    });

    const devArg = this.deviceSerial ? ['-d', String(this.deviceSerial)] : ['-d', String(this.deviceIndex)];
    const gainArgs = this.currentGain !== null ? ['-g', String(Math.round(this.currentGain * 10))] : [];
    const ppmArgs = ['-p', String(this.currentPpm)];

    const rtlCmd = 'rtl_fm';
    const rtlArgs = [
      ...devArg,
      '-M', 'fm',
      '-l', '0',
      '-A', 'std',
      ...ppmArgs,
      '-s', '171k',
      ...gainArgs,
      '-F', '9',
      '-f', `${freqMhz}M`,
      '-',
    ];

    const redseaCmd = 'redsea';
    const redseaArgs = ['-r', '171k', '-u', '--feed-through'];

    const ffmpegCmd = 'ffmpeg';
    const ffmpegArgs = [
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', '171000',
      '-ac', '1',
      '-i', '-',
      '-af', 'aemphasis=type=75fm:mode=reproduction,lowpass=f=15000',
      '-ar', '48000',
      '-f', 'mp3',
      '-b:a', '128k',
      '-',
    ];

    console.log(`[sdr-worker:${this.id}] Tuning FM ${freqMhz} MHz on device ${this.deviceIndex} (gain: ${this.currentGain || 'auto'})`);

    try {
      const rtlProc = spawn(rtlCmd, rtlArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
      const redseaProc = spawn(redseaCmd, redseaArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      const ffmpegProc = spawn(ffmpegCmd, ffmpegArgs, { stdio: ['pipe', 'pipe', 'ignore'] });

      rtlProc.stdout.pipe(redseaProc.stdin);
      redseaProc.stdout.pipe(ffmpegProc.stdin);

      this.procs = [rtlProc, redseaProc, ffmpegProc];

      ffmpegProc.stdout.on('data', (chunk) => {
        if (this.running) {
          this._calculateAudioRms(chunk);
          this.broadcastAudio(chunk);
        }
      });

      let rdsBuf = '';
      redseaProc.stderr.on('data', (data) => {
        rdsBuf += data.toString('utf8');
        const lines = rdsBuf.split('\n');
        rdsBuf = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            this._handleRdsJson(obj);
          } catch (_) {}
        }
      });

      const handleExit = (procName, code) => {
        if (this.running) {
          console.warn(`[sdr-worker:${this.id}] Process ${procName} exited with code ${code}`);
        }
      };

      rtlProc.on('exit', (code) => handleExit('rtl_fm', code));
      redseaProc.on('exit', (code) => handleExit('redsea', code));
      ffmpegProc.on('exit', (code) => handleExit('ffmpeg', code));
    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Spawn error:`, err.message);
      this.updateState({ syncState: 'ERROR' });
    }
  }

  /**
   * Tune dedicated NRSC-5 Digital HD Radio on a physical dongle
   */
  tuneHd(freqMhz, program = 0, options = {}) {
    this.stop();
    this.running = true;
    this.currentMode = 'hd';
    this.currentFreq = freqMhz;
    this.currentProgram = program;
    this.currentGain = options.gain !== undefined ? options.gain : null;
    this.activeStationName = options.stationName || `HD${program + 1} ${freqMhz} MHz`;

    this.resetState();
    this.updateState({
      running: true,
      mode: 'hd',
      frequency: freqMhz,
      program,
      gain: this.currentGain,
      syncState: 'SYNCING',
      station: this.activeStationName,
    });

    const devArg = this.deviceSerial ? ['-d', String(this.deviceSerial)] : ['-d', String(this.deviceIndex)];
    const gainArgs = this.currentGain !== null ? ['-g', Number(this.currentGain).toFixed(1)] : [];
    const nrsc5Cmd = 'nrsc5';
    const nrsc5Args = [
      ...devArg,
      ...gainArgs,
      '-o', '-',
      '-t', 'raw',
      String(freqMhz),
      String(program),
    ];

    const ffmpegCmd = 'ffmpeg';
    const ffmpegArgs = [
      '-loglevel', 'error',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', '-',
      '-f', 'mp3',
      '-b:a', '128k',
      '-',
    ];

    console.log(`[sdr-worker:${this.id}] Tuning HD Radio ${freqMhz} MHz HD${program + 1} on device ${this.deviceIndex}`);

    try {
      const nrsc5Proc = spawn(nrsc5Cmd, nrsc5Args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpegProc = spawn(ffmpegCmd, ffmpegArgs, { stdio: ['pipe', 'pipe', 'ignore'] });

      nrsc5Proc.stdout.pipe(ffmpegProc.stdin);
      this.procs = [nrsc5Proc, ffmpegProc];

      ffmpegProc.stdout.on('data', (chunk) => {
        if (this.running) {
          this._calculateAudioRms(chunk);
          this.broadcastAudio(chunk);
        }
      });

      let hdBuf = '';
      nrsc5Proc.stderr.on('data', (data) => {
        hdBuf += data.toString('utf8');
        const lines = hdBuf.split('\n');
        hdBuf = lines.pop();

        for (const line of lines) {
          this._handleHdLine(line.trim());
        }
      });

      const handleExit = (procName, code) => {
        if (this.running) {
          console.warn(`[sdr-worker:${this.id}] Process ${procName} exited with code ${code}`);
        }
      };

      nrsc5Proc.on('exit', (code) => handleExit('nrsc5', code));
      ffmpegProc.on('exit', (code) => handleExit('ffmpeg', code));
    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Spawn error:`, err.message);
      this.updateState({ syncState: 'ERROR' });
    }
  }

  /**
   * Connect to Wideband Channelizer FIFO output
   */
  connectWidebandChannel(freqMhz, fifoPath, options = {}) {
    if (this.fifoStream) {
      try { this.fifoStream.destroy(); } catch (_) {}
      this.fifoStream = null;
    }
    for (const proc of this.procs) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
    }
    this.procs = [];
    this.running = true;
    this.isWideband = true;
    this.currentMode = 'fm';
    this.currentFreq = freqMhz;
    this.fifoPath = fifoPath;
    this.activeStationName = options.stationName || `FM ${freqMhz} MHz (Wideband)`;

    this.updateState({
      running: true,
      mode: 'fm',
      frequency: freqMhz,
      isWideband: true,
      syncState: 'RECEIVING',
      station: this.activeStationName,
    });

    console.log(`[sdr-worker:${this.id}] Attaching to Wideband FIFO ${fifoPath} for ${freqMhz} MHz`);

    try {
      // Decode RDS from 240k MPX and encode MP3
      const redseaProc = spawn('redsea', ['-r', '240k', '-u', '--feed-through'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const ffmpegProc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-f', 's16le', '-ar', '240000', '-ac', '1', '-i', '-',
        '-af', 'aemphasis=type=75fm:mode=reproduction,lowpass=f=15000',
        '-ar', '48000', '-f', 'mp3', '-b:a', '128k', '-'
      ], { stdio: ['pipe', 'pipe', 'ignore'] });

      // Open FIFO read stream
      const fifoStream = fs.createReadStream(fifoPath);
      this.fifoStream = fifoStream;

      fifoStream.pipe(redseaProc.stdin);
      redseaProc.stdout.pipe(ffmpegProc.stdin);

      this.procs = [redseaProc, ffmpegProc];

      ffmpegProc.stdout.on('data', (chunk) => {
        if (this.running) {
          this._calculateAudioRms(chunk);
          this.broadcastAudio(chunk);
        }
      });

      let rdsBuf = '';
      redseaProc.stderr.on('data', (data) => {
        rdsBuf += data.toString('utf8');
        const lines = rdsBuf.split('\n');
        rdsBuf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            this._handleRdsJson(obj);
          } catch (_) {}
        }
      });

      redseaProc.on('error', (err) => {
        console.warn(`[sdr-worker:${this.id}] redsea process error:`, err.message);
      });
      ffmpegProc.on('error', (err) => {
        console.warn(`[sdr-worker:${this.id}] ffmpeg process error:`, err.message);
      });
      fifoStream.on('error', (err) => {
        console.warn(`[sdr-worker:${this.id}] FIFO read error:`, err.message);
      });
    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Wideband attach error:`, err.message);
    }
  }

  _handleRdsJson(obj) {
    const patches = {};
    if (obj.ps) {
      const cleanPs = obj.ps.trim();
      if (cleanPs) { patches.ps = cleanPs; patches.station = cleanPs; patches.syncState = 'LOCKED'; }
    }
    if (obj.radiotext) {
      const cleanRt = obj.radiotext.trim();
      if (cleanRt) { patches.rt = cleanRt; patches.syncState = 'LOCKED'; }
    }
    if (obj.radiotext_plus) {
      const rtp = obj.radiotext_plus;
      if (rtp.item_artist) patches.artist = rtp.item_artist.trim();
      if (rtp.item_title) patches.title = rtp.item_title.trim();
      if (patches.artist && patches.title) {
        patches.rtPlus = `${patches.artist} - ${patches.title}`;
      } else if (patches.title) {
        patches.rtPlus = patches.title;
      }
      patches.syncState = 'LOCKED';
    }
    if (obj.pi !== undefined) patches.pi = obj.pi;
    if (obj.prog_type) patches.programType = obj.prog_type;

    if (patches.syncState === 'LOCKED' && (!this.state.signalPercent || this.state.signalPercent < 75)) {
      patches.signalPercent = Math.max(78, this.state.signalPercent || 80);
      patches.signal = `${patches.signalPercent}% (RDS LOCK)`;
    }

    if (Object.keys(patches).length > 0) {
      this.updateState(patches);
    }
  }

  _handleHdLine(line) {
    const patches = {};
    if (line.includes('Synchronized')) {
      patches.syncState = 'LOCKED';
    } else if (line.includes('Lost synchronization') || line.includes('Unsynchronized')) {
      patches.syncState = 'UNSYNCED';
    }

    const merMatch = line.match(/MER:\s*([\d.]+)\s*dB\s*\(([^)]+)\),\s*([\d.]+)\s*dB\s*\(([^)]+)\)/);
    if (merMatch) {
      const lower = parseFloat(merMatch[1]);
      const upper = parseFloat(merMatch[3]);
      patches.merLower = lower;
      patches.merUpper = upper;
      patches.mer = parseFloat(((lower + upper) / 2).toFixed(1));
      patches.signalPercent = Math.max(10, Math.min(100, Math.round((patches.mer / 22.0) * 100)));
      patches.signal = `+${patches.mer} dB MER (${patches.signalPercent}%)`;
      patches.dbfs = parseFloat((patches.mer - 25).toFixed(1));
    }

    const berMatch = line.match(/BER:\s*([\d.eE+-]+)/);
    if (berMatch) patches.ber = berMatch[1];

    const titleMatch = line.match(/Title:\s*(.+)$/);
    if (titleMatch) patches.title = titleMatch[1].trim();

    const artistMatch = line.match(/Artist:\s*(.+)$/);
    if (artistMatch) patches.artist = artistMatch[1].trim();

    const albumMatch = line.match(/Album:\s*(.+)$/);
    if (albumMatch) patches.album = albumMatch[1].trim();

    const stationMatch = line.match(/Station name:\s*(.+)$/);
    if (stationMatch) patches.station = stationMatch[1].trim();

    if (patches.artist && patches.title) {
      patches.rtPlus = `${patches.artist} - ${patches.title}`;
    } else if (patches.title) {
      patches.rtPlus = patches.title;
    }

    if (Object.keys(patches).length > 0) {
      this.updateState(patches);
    }
  }

  stop() {
    this.running = false;
    this.currentMode = null;
    this.currentFreq = null;
    this.activeStationName = null;

    for (const proc of this.procs) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) {}
        }, 800);
      }
    }
    this.procs = [];

    // ONLY unlink fifoPath if NOT wideband cluster (cluster manages its own FIFO lifecycle)
    if (!this.isWideband && this.fifoPath && fs.existsSync(this.fifoPath)) {
      try { fs.unlinkSync(this.fifoPath); } catch (_) {}
    }
    this.fifoPath = null;
    this.resetState();
    this.emit('stopped');
  }
}

/**
 * WidebandCluster — Manages a single python wideband_channelizer.py instance
 * digitizing up to 2.4 MHz of spectrum on one RTL-SDR stick.
 */
class WidebandCluster {
  constructor(clusterKey, deviceIndex, centerMhz, gain = 'auto', ppm = 0) {
    this.clusterKey = clusterKey;
    this.deviceIndex = deviceIndex;
    this.centerMhz = centerMhz;
    this.gain = gain;
    this.ppm = ppm;
    this.channels = new Map(); // freqMhz -> { fifoPath, worker }
    this.proc = null;
    this.tmpDir = path.join(os.tmpdir(), `sonar_wb_${clusterKey}`);
    if (!fs.existsSync(this.tmpDir)) {
      try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch (_) {}
    }
  }

  canFit(freqMhz) {
    const freqs = [...this.channels.keys(), freqMhz];
    const minF = Math.min(...freqs);
    const maxF = Math.max(...freqs);
    return (maxF - minF) <= 2.1;
  }

  addChannel(freqMhz, worker) {
    const freqs = [...this.channels.keys(), freqMhz];
    const minF = Math.min(...freqs);
    const maxF = Math.max(...freqs);
    this.centerMhz = parseFloat(((minF + maxF) / 2).toFixed(3));

    const fifoPath = path.join(this.tmpDir, `ch_${String(freqMhz).replace('.', '_')}.raw`);
    try {
      if (!fs.existsSync(fifoPath)) {
        execSync(`mkfifo "${fifoPath}"`);
      }
    } catch (_) {}
    this.channels.set(freqMhz, { fifoPath, worker });
    this.restartProcess();

    // Reconnect ALL active channel workers in the cluster so all channels receive continuous audio
    setTimeout(() => {
      for (const [f, ch] of this.channels) {
        ch.worker.connectWidebandChannel(f, ch.fifoPath, { stationName: ch.worker.activeStationName });
      }
    }, 200);
  }

  removeChannel(freqMhz) {
    const ch = this.channels.get(freqMhz);
    if (ch) {
      ch.worker.stop();
      try { if (fs.existsSync(ch.fifoPath)) fs.unlinkSync(ch.fifoPath); } catch (_) {}
      this.channels.delete(freqMhz);
    }
    if (this.channels.size === 0) {
      this.stop();
    } else {
      const freqs = [...this.channels.keys()];
      const minF = Math.min(...freqs);
      const maxF = Math.max(...freqs);
      this.centerMhz = parseFloat(((minF + maxF) / 2).toFixed(3));
      this.restartProcess();
      setTimeout(() => {
        for (const [f, c] of this.channels) {
          c.worker.connectWidebandChannel(f, c.fifoPath, { stationName: c.worker.activeStationName });
        }
      }, 200);
    }
  }

  restartProcess() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
    }
    if (this.channels.size === 0) return;

    const channelArgs = Array.from(this.channels.entries())
      .map(([freq, ch]) => `${freq}:${ch.fifoPath}`)
      .join(',');

    const pyScript = path.join(__dirname, 'wideband_channelizer.py');
    const pyCmd = fs.existsSync('/opt/whisper-env/bin/python3') ? '/opt/whisper-env/bin/python3' : 'python3';

    const args = [
      pyScript,
      '--device', String(this.deviceIndex),
      '--center', String(this.centerMhz),
      '--sample-rate', '2400000',
      '--gain', String(this.gain || 'auto'),
      '--ppm', String(this.ppm || 0),
      '--channels', channelArgs,
    ];

    console.log(`[sdr-wideband] Auto-adjusting cluster on Stick #${this.deviceIndex} (Center: ${this.centerMhz} MHz, Active Channels: [${[...this.channels.keys()].join(', ')}])`);
    this.proc = spawn(pyCmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrBuf = '';
    this.proc.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const statMatch = trimmed.match(/\[ch-stat:([\d.]+)\]\s+pct=(\d+)\s+dbfs=([-\d.]+)/);
        if (statMatch) {
          const freq = parseFloat(statMatch[1]);
          const pct = parseInt(statMatch[2], 10);
          const dbfs = parseFloat(statMatch[3]);
          const ch = this.channels.get(freq);
          if (ch && ch.worker) {
            ch.worker.updateState({
              signalPercent: pct,
              dbfs: dbfs,
              signal: `${pct}% (${dbfs >= 0 ? '+' : ''}${dbfs.toFixed(1)} dBFS)`,
              syncState: ch.worker.state.syncState === 'IDLE' ? 'RECEIVING' : ch.worker.state.syncState,
            });
          }
        } else if (trimmed.includes('Error') || trimmed.includes('offset')) {
          console.log(`[sdr-wideband:${this.clusterKey}] ${trimmed}`);
        }
      }
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
    }
    this.proc = null;
    for (const [, ch] of this.channels) {
      try { if (fs.existsSync(ch.fifoPath)) fs.unlinkSync(ch.fifoPath); } catch (_) {}
    }
    this.channels.clear();
    try { if (fs.existsSync(this.tmpDir)) fs.rmdirSync(this.tmpDir); } catch (_) {}
  }
}

/**
 * SdrPoolManager — Master manager for all physical dongles and wideband clusters
 */
class SdrPoolManager extends EventEmitter {
  constructor() {
    super();
    this.workers = new Map(); // id -> SdrWorker
    this.widebandClusters = new Map(); // clusterKey -> WidebandCluster
    this.defaultWorker = new SdrWorker('default', { deviceIndex: 0 });
    this.workers.set('default', this.defaultWorker);

    // Bubble up metadata and audio events from workers
    this.defaultWorker.on('metadata', (meta) => this.emit('metadata', meta));
    this.defaultWorker.on('audio', (chunk) => this.emit('audio', chunk));
  }

  /**
   * Scan for connected RTL-SDR USB devices
   */
  async scanDevices() {
    return new Promise((resolve) => {
      exec('rtl_test -t', { timeout: 3500 }, (error, stdout, stderr) => {
        const output = (stdout || '') + '\n' + (stderr || '');
        const devices = [];

        const foundMatch = output.match(/Found\s+(\d+)\s+device\(s\)/i);
        const count = foundMatch ? parseInt(foundMatch[1], 10) : 0;

        const devRegex = /(\d+):\s*([^\r\n]+)/g;
        let match;
        while ((match = devRegex.exec(output)) !== null) {
          if (!match[2].includes('Using device') && !match[2].includes('Supported gain')) {
            const rawDesc = match[2].trim();
            const snMatch = rawDesc.match(/SN:\s*([^\r\n,]+)/i);
            const serial = snMatch ? snMatch[1].trim() : '00000001';
            const cleanName = rawDesc.replace(/,\s*SN:\s*[^\r\n,]+/i, '').trim();

            devices.push({
              index: parseInt(match[1], 10),
              name: cleanName,
              serial: serial,
            });
          }
        }

        const tunerMatch = output.match(/Tuner\s+type[^\n:]*:\s*([^\r\n]+)/i);
        const tunerType = tunerMatch ? tunerMatch[1].trim() : 'R820T/R820T2/E4000';

        // Check if any devices are currently busy
        const busyIndexes = new Set();
        for (const [, w] of this.workers) {
          if (w.running) busyIndexes.add(w.deviceIndex);
        }
        for (const [, c] of this.widebandClusters) {
          busyIndexes.add(c.deviceIndex);
        }

        const deviceList = devices.map(d => ({
          ...d,
          inUse: busyIndexes.has(d.index),
        }));

        resolve({
          detected: count > 0 || devices.length > 0,
          count: Math.max(count, devices.length),
          devices: deviceList,
          tunerType,
          raw: output.trim().split('\n').slice(0, 8).join('\n'),
        });
      });
    });
  }

  /**
   * Write new Serial Number to RTL-SDR onboard EEPROM
   */
  async writeSerial(deviceIndex, newSerial) {
    const cleanSerial = String(newSerial || '').trim();
    if (!cleanSerial) return { success: false, error: 'Serial number cannot be empty' };

    return new Promise((resolve) => {
      console.log(`[sdr-eeprom] Spawning rtl_eeprom -d ${deviceIndex} -s ${cleanSerial}`);
      const proc = spawn('rtl_eeprom', ['-d', String(deviceIndex), '-s', cleanSerial], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      const handleChunk = (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        if (text.includes('[y/n]') || text.includes('Write new configuration') || text.includes('overwrite') || text.includes('?')) {
          try {
            proc.stdin.write('y\n');
          } catch (_) {}
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        handleChunk(d);
      });

      // Periodically send 'y' in case prompt arrived without specific keywords
      const confirmTimer = setInterval(() => {
        try {
          if (proc.stdin.writable) proc.stdin.write('y\n');
        } catch (_) {}
      }, 500);

      proc.on('close', (code) => {
        clearInterval(confirmTimer);
        const combined = stdout + '\n' + stderr;
        if (code === 0 || combined.includes('Configuration written') || combined.includes('Update successful') || combined.includes('done') || combined.includes('Re-plug device')) {
          resolve({ success: true, message: `Serial '${cleanSerial}' successfully programmed into Device #${deviceIndex} EEPROM.`, output: combined.trim() });
        } else if (combined.includes('Serial number:') && combined.includes(cleanSerial)) {
          resolve({ success: true, message: `Serial '${cleanSerial}' updated on Device #${deviceIndex}.`, output: combined.trim() });
        } else {
          resolve({ success: false, error: combined.trim() || `rtl_eeprom exited with code ${code}` });
        }
      });

      setTimeout(() => {
        clearInterval(confirmTimer);
        if (!proc.killed) {
          try { proc.kill('SIGTERM'); } catch (_) {}
          resolve({ success: true, message: `Serial update command sent to Device #${deviceIndex}.` });
        }
      }, 4000);
    });
  }

  /**
   * Auto-serialize all connected RTL-SDR dongles sequentially
   */
  async autoSerializeAll(prefix = '0000000') {
    const scan = await this.scanDevices();
    if (!scan.detected || scan.devices.length === 0) {
      return { success: false, error: 'No RTL-SDR devices detected to serialize.' };
    }

    const results = [];
    for (let i = 0; i < scan.devices.length; i++) {
      const dev = scan.devices[i];
      let newSerial;
      if (prefix === '0000000' || prefix === '000000') {
        newSerial = String(i + 1).padStart(8, '0');
      } else {
        newSerial = `${prefix}${i + 1}`;
      }

      console.log(`[sdr-eeprom] Auto-assigning serial '${newSerial}' to Device #${dev.index}`);
      const res = await this.writeSerial(dev.index, newSerial);
      results.push({
        deviceIndex: dev.index,
        oldSerial: dev.serial,
        newSerial,
        success: res.success,
        message: res.message || res.error,
      });

      await new Promise((r) => setTimeout(r, 600));
    }

    return {
      success: results.every(r => r.success),
      results,
      message: `Successfully programmed ${results.length} RTL-SDR serial number(s).`
    };
  }

  /**
   * Acquire or create a worker for a specific monitor with Smart Auto-Clustering
   */
  async acquireWorker(id, options = {}) {
    let worker = this.workers.get(id);
    const mode = options.mode || 'fm';
    const freq = parseFloat(options.freq) || 105.1;
    const pref = options.preferredDevice;
    const isExplicitWideband = pref === 'wideband' || options.isWideband;
    const isAuto = pref === 'auto' || pref === undefined || pref === null;

    // ── Smart Dynamic FM Clustering ──────────────────────────────────────────
    if (mode === 'fm' && (isAuto || isExplicitWideband)) {
      // 1. Check if an active WidebandCluster can absorb this frequency (<= 2.1 MHz span)
      for (const [, cluster] of this.widebandClusters) {
        if (cluster.canFit(freq)) {
          console.log(`[sdr-pool] Smart Auto-Adjust: Adding ${freq} MHz to existing Wideband Cluster on Stick #${cluster.deviceIndex}`);
          if (!worker) {
            worker = new SdrWorker(id, { deviceIndex: cluster.deviceIndex, isWideband: true, clusterKey: cluster.clusterKey });
            this.workers.set(id, worker);
          } else {
            worker.isWideband = true;
            worker.clusterKey = cluster.clusterKey;
            worker.deviceIndex = cluster.deviceIndex;
          }
          cluster.addChannel(freq, worker);
          return worker;
        }
      }

      // 2. Check if an active dedicated FM worker can be promoted to a shared Wideband Cluster
      for (const [existingId, existingWorker] of this.workers) {
        if (existingId !== id && existingWorker.running && existingWorker.currentMode === 'fm' && !existingWorker.isWideband && existingWorker.currentFreq) {
          const span = Math.abs(freq - existingWorker.currentFreq);
          if (span <= 2.0) {
            const devIdx = existingWorker.deviceIndex;
            console.log(`[sdr-pool] Smart Auto-Adjust: Promoting Stick #${devIdx} to Wideband Cluster for ${existingWorker.currentFreq} MHz and ${freq} MHz (span: ${span.toFixed(2)} MHz)`);
            const clusterKey = `wb_dev${devIdx}_${Math.round(freq)}`;
            const centerMhz = parseFloat(((existingWorker.currentFreq + freq) / 2).toFixed(3));
            const cluster = new WidebandCluster(clusterKey, devIdx, centerMhz, options.gain, options.ppm);
            this.widebandClusters.set(clusterKey, cluster);

            // Migrate existing worker
            const oldFreq = existingWorker.currentFreq;
            existingWorker.isWideband = true;
            existingWorker.clusterKey = clusterKey;
            cluster.addChannel(oldFreq, existingWorker);

            // Attach new worker
            if (!worker) {
              worker = new SdrWorker(id, { deviceIndex: devIdx, isWideband: true, clusterKey });
              this.workers.set(id, worker);
            } else {
              worker.isWideband = true;
              worker.clusterKey = clusterKey;
              worker.deviceIndex = devIdx;
            }
            cluster.addChannel(freq, worker);
            return worker;
          }
        }
      }

      // If user explicitly chose 'wideband' but no cluster exists yet, create one
      if (isExplicitWideband) {
        const scan = await this.scanDevices();
        const availableDev = scan.devices.find(d => !d.inUse)?.index || 0;
        const clusterKey = `wb_dev${availableDev}_${Math.round(freq)}`;
        const cluster = new WidebandCluster(clusterKey, availableDev, freq, options.gain, options.ppm);
        this.widebandClusters.set(clusterKey, cluster);

        if (!worker) {
          worker = new SdrWorker(id, { deviceIndex: availableDev, isWideband: true, clusterKey });
          this.workers.set(id, worker);
        }
        cluster.addChannel(freq, worker);
        return worker;
      }
    }

    // ── Dedicated physical tuner allocation ─────────────────────────────────
    let chosenDeviceIndex = 0;
    if (typeof pref === 'number' || (typeof pref === 'string' && !isNaN(parseInt(pref, 10)) && pref !== 'auto' && pref !== 'wideband')) {
      chosenDeviceIndex = parseInt(pref, 10);
    } else {
      // Auto-assign first idle dongle
      const scan = await this.scanDevices();
      const idle = scan.devices.find(d => !d.inUse);
      if (idle) chosenDeviceIndex = idle.index;
    }

    if (!worker) {
      worker = new SdrWorker(id, { deviceIndex: chosenDeviceIndex });
      this.workers.set(id, worker);
    } else {
      worker.deviceIndex = chosenDeviceIndex;
      worker.isWideband = false;
      worker.clusterKey = null;
    }

    if (mode === 'hd') {
      worker.tuneHd(freq, parseInt(options.program, 10) || 0, options);
    } else {
      worker.tuneFm(freq, options);
    }

    return worker;
  }

  releaseWorker(id) {
    const worker = this.workers.get(id);
    if (!worker) return;

    if (worker.isWideband && worker.clusterKey) {
      const cluster = this.widebandClusters.get(worker.clusterKey);
      if (cluster) cluster.removeChannel(worker.currentFreq);
    }

    worker.stop();
    if (id !== 'default') {
      this.workers.delete(id);
    }
  }

  getWorker(id) {
    return this.workers.get(id) || this.defaultWorker;
  }

  getPoolStatus() {
    const activeWorkers = [];
    for (const [id, w] of this.workers) {
      if (w.running) {
        activeWorkers.push({ id, ...w.getStatus() });
      }
    }
    const clusters = [];
    for (const [k, c] of this.widebandClusters) {
      clusters.push({
        clusterKey: k,
        deviceIndex: c.deviceIndex,
        centerMhz: c.centerMhz,
        channels: Array.from(c.channels.keys()),
        running: !!(c.proc && !c.proc.killed),
      });
    }
    return {
      activeWorkersCount: activeWorkers.length,
      workers: activeWorkers,
      widebandClustersCount: this.widebandClusters.size,
      clusters: clusters,
      defaultStatus: this.defaultWorker.getStatus(),
    };
  }

  // Compatibility helpers for single-tuner callers
  getStatus() {
    return this.defaultWorker.getStatus();
  }

  tuneFm(freq, options) {
    return this.defaultWorker.tuneFm(freq, options);
  }

  tuneHd(freq, prog, options) {
    return this.defaultWorker.tuneHd(freq, prog, options);
  }

  stop() {
    for (const [, w] of this.workers) w.stop();
    for (const [, c] of this.widebandClusters) c.stop();
    this.workers.clear();
    this.widebandClusters.clear();
    this.defaultWorker = new SdrWorker('default', { deviceIndex: 0 });
    this.workers.set('default', this.defaultWorker);
  }
}

const sdrPoolManager = new SdrPoolManager();

module.exports = {
  SdrWorker,
  WidebandCluster,
  SdrPoolManager,
  sdrManager: sdrPoolManager, // Export as sdrManager for drop-in compatibility
};
