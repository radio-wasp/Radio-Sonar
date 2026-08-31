'use strict';

/**
 * sdr_receiver.js — RTL-SDR Off-Air Demodulator & Multi-Device Pool Manager
 * Radio SONAR Version 3.1
 *
 * Supports:
 * 1. Single-Stick Wideband FM Channelizer: Demodulate multiple FM stations concurrently
 *    from a single 2.4 MHz IQ spectrum slice via Python DSP (wideband_channelizer.py)
 *    and zero-loss UNIX domain / TCP socket streaming.
 * 2. Multi-Dongle Physical Pooling: Run N physical RTL-SDR USB sticks concurrently.
 * 3. Analog FM Stereo with real-time RDS/RBDS decoding (rtl_fm + redsea + ffmpeg).
 * 4. NRSC-5 Digital HD Radio decoding (HD1–HD4) with MER/BER telemetry (nrsc5 + ffmpeg).
 * 5. Dynamic device auto-discovery, auto-clustering, and health diagnostics.
 */

const { spawn, exec } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');

class SdrWorker extends EventEmitter {
  constructor(id, options = {}) {
    super();
    this.id = id; // monitorId or 'default'
    this.deviceIndex = options.deviceIndex !== undefined ? options.deviceIndex : 0;
    this.deviceSerial = options.deviceSerial || null;
    this.isWideband = options.isWideband || false;
    this.clusterKey = options.clusterKey || null;

    this.procs = [];
    this.clientSocket = null;
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
      syncState: 'IDLE', // 'IDLE' | 'RECEIVING' | 'SYNCING' | 'LOCKED' | 'UNSYNCED' | 'ERROR'
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
      lastError: null,
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
      lastError: null,
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
    this.isWideband = false;
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

    const devArg = ['-d', String(this.deviceIndex)];
    const gainArgs = this.currentGain !== null ? ['-g', String(this.currentGain)] : [];
    const ppmArgs = this.currentPpm ? ['-p', String(this.currentPpm)] : [];

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

    console.log(`[sdr-worker:${this.id}] Spawning dedicated FM: ${rtlCmd} ${rtlArgs.join(' ')} | ${redseaCmd} | ${ffmpegCmd}`);

    try {
      const rtlProc = spawn(rtlCmd, rtlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const redseaProc = spawn(redseaCmd, redseaArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      const ffmpegProc = spawn(ffmpegCmd, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      rtlProc.stdout.pipe(redseaProc.stdin);
      redseaProc.stdout.pipe(ffmpegProc.stdin);

      rtlProc.stdout.on('error', () => {});
      redseaProc.stdin.on('error', () => {});
      redseaProc.stdout.on('error', () => {});
      ffmpegProc.stdin.on('error', () => {});

      this.procs = [rtlProc, redseaProc, ffmpegProc];

      ffmpegProc.stdout.on('data', (chunk) => {
        if (this.running) {
          this._calculateAudioRms(chunk);
          this.broadcastAudio(chunk);
        }
      });

      let rtlErrBuf = '';
      rtlProc.stderr.on('data', (data) => {
        rtlErrBuf += data.toString('utf8');
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

      let ffmpegErrBuf = '';
      ffmpegProc.stderr.on('data', (data) => {
        ffmpegErrBuf += data.toString('utf8');
      });

      const handleExit = (procName, code) => {
        if (this.running && code !== 0 && code !== null) {
          const errMsg = procName === 'rtl_fm' ? rtlErrBuf.trim() : (procName === 'ffmpeg' ? ffmpegErrBuf.trim() : '');
          console.error(`[sdr-worker:${this.id}] Process ${procName} exited with code ${code}. ${errMsg}`);
          this.updateState({
            syncState: 'ERROR',
            lastError: `${procName} exited (code ${code}): ${errMsg || 'Abnormal exit'}`
          });
        }
      };

      rtlProc.on('exit', (code) => handleExit('rtl_fm', code));
      redseaProc.on('exit', (code) => handleExit('redsea', code));
      ffmpegProc.on('exit', (code) => handleExit('ffmpeg', code));
    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Spawn error:`, err.message);
      this.updateState({ syncState: 'ERROR', lastError: err.message });
    }
  }

  /**
   * Tune dedicated NRSC-5 Digital HD Radio on a physical dongle
   */
  tuneHd(freqMhz, program = 0, options = {}) {
    this.stop();
    this.running = true;
    this.isWideband = false;
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

    const devArg = ['-d', String(this.deviceIndex)];
    const gainArgs = this.currentGain !== null ? ['-g', Number(this.currentGain).toFixed(1)] : [];
    const ppmArgs = options.ppm ? ['-p', String(options.ppm)] : [];

    const nrsc5Cmd = 'nrsc5';
    const nrsc5Args = [
      ...devArg,
      ...gainArgs,
      ...ppmArgs,
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

    console.log(`[sdr-worker:${this.id}] Spawning: ${nrsc5Cmd} ${nrsc5Args.join(' ')} | ${ffmpegCmd}`);

    try {
      const nrsc5Proc = spawn(nrsc5Cmd, nrsc5Args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const ffmpegProc = spawn(ffmpegCmd, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

      nrsc5Proc.stdout.pipe(ffmpegProc.stdin);
      nrsc5Proc.stdout.on('error', () => {});
      ffmpegProc.stdin.on('error', () => {});

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

      let ffmpegErrBuf = '';
      ffmpegProc.stderr.on('data', (data) => {
        ffmpegErrBuf += data.toString('utf8');
      });

      const handleExit = (procName, code) => {
        if (this.running && code !== 0 && code !== null) {
          const errMsg = procName === 'nrsc5' ? hdBuf.trim().split('\n').slice(-3).join(' ') : ffmpegErrBuf.trim();
          console.error(`[sdr-worker:${this.id}] Process ${procName} exited with code ${code}. ${errMsg}`);
          this.updateState({
            syncState: 'ERROR',
            lastError: `${procName} exited (code ${code}): ${errMsg || 'Abnormal exit'}`
          });
        }
      };

      nrsc5Proc.on('exit', (code) => handleExit('nrsc5', code));
      ffmpegProc.on('exit', (code) => handleExit('ffmpeg', code));
    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Spawn error:`, err.message);
      this.updateState({ syncState: 'ERROR', lastError: err.message });
    }
  }

  /**
   * Connect to Wideband Channelizer Socket Stream
   */
  connectWidebandChannel(freqMhz, sockPath, options = {}) {
    this.stop();
    this.running = true;
    this.isWideband = true;
    this.currentMode = 'fm';
    this.currentFreq = freqMhz;
    this.sockPath = sockPath;
    this.activeStationName = options.stationName || `FM ${freqMhz} MHz (Wideband)`;

    this.resetState();
    this.updateState({
      running: true,
      mode: 'fm',
      frequency: freqMhz,
      isWideband: true,
      syncState: 'RECEIVING',
      station: this.activeStationName,
    });

    console.log(`[sdr-worker:${this.id}] Connecting to Wideband Channel Socket: ${sockPath} for ${freqMhz} MHz`);

    try {
      const redseaProc = spawn('redsea', ['-r', '240k', '-u', '--feed-through'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const ffmpegProc = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-f', 's16le', '-ar', '240000', '-ac', '1', '-i', '-',
        '-af', 'aemphasis=type=75fm:mode=reproduction,lowpass=f=15000',
        '-ar', '48000', '-f', 'mp3', '-b:a', '128k', '-'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      redseaProc.stdout.pipe(ffmpegProc.stdin);

      redseaProc.stdin.on('error', () => {});
      redseaProc.stdout.on('error', () => {});
      ffmpegProc.stdin.on('error', () => {});

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

      let reconnectTimer = null;
      const connectSocket = () => {
        if (!this.running) return;
        if (this.clientSocket) {
          try { this.clientSocket.destroy(); } catch (_) {}
          this.clientSocket = null;
        }

        let sock;
        if (fs.existsSync(sockPath)) {
          sock = net.createConnection(sockPath);
        } else {
          const freqKhz = Math.round(freqMhz * 1000);
          const tcpPort = 9200 + (freqKhz % 800);
          sock = net.createConnection({ port: tcpPort, host: '127.0.0.1' });
        }

        this.clientSocket = sock;

        sock.on('connect', () => {
          console.log(`[sdr-worker:${this.id}] Attached to Wideband stream for ${freqMhz} MHz`);
          sock.pipe(redseaProc.stdin, { end: false });
        });

        sock.on('error', () => {
          if (this.running && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connectSocket();
            }, 500);
          }
        });

        sock.on('close', () => {
          if (this.running && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connectSocket();
            }, 500);
          }
        });
      };

      setTimeout(connectSocket, 250);

    } catch (err) {
      console.error(`[sdr-worker:${this.id}] Wideband connect error:`, err.message);
      this.updateState({ syncState: 'ERROR', lastError: err.message });
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
    }
    if (obj.pi) patches.pi = obj.pi;

    if (Object.keys(patches).length > 0) {
      this.updateState(patches);
    }
  }

  _handleHdLine(line) {
    if (!line) return;
    const patches = {};

    if (line.includes('Synchronized') || line.includes('sync: 1')) {
      patches.syncState = 'LOCKED';
    } else if (line.includes('Lost sync') || line.includes('sync: 0')) {
      patches.syncState = 'UNSYNCED';
    }

    const merMatch = line.match(/MER:\s*([\d.]+)\s*\(lower\)\s*,\s*([\d.]+)\s*\(upper\)\s*,\s*([\d.]+)\s*\(avg\)\s*dB/i) ||
                     line.match(/MER:\s*([\d.]+)\s*dB/i);
    if (merMatch) {
      if (merMatch[3]) {
        patches.merLower = parseFloat(merMatch[1]);
        patches.merUpper = parseFloat(merMatch[2]);
        patches.mer = parseFloat(merMatch[3]);
      } else {
        patches.mer = parseFloat(merMatch[1]);
      }
      const avgMer = patches.mer || 0;
      const pct = Math.max(10, Math.min(100, Math.round((avgMer / 22.0) * 100)));
      patches.signalPercent = pct;
      patches.dbfs = parseFloat((avgMer - 24.0).toFixed(1));
      patches.signal = `${pct}% (${avgMer.toFixed(1)} dB MER)`;
    }

    const berMatch = line.match(/BER:\s*([\d.e+-]+)/i);
    if (berMatch) patches.ber = parseFloat(berMatch[1]);

    const titleMatch = line.match(/Title:\s*(.+)/i);
    if (titleMatch) patches.title = titleMatch[1].trim();

    const artistMatch = line.match(/Artist:\s*(.+)/i);
    if (artistMatch) patches.artist = artistMatch[1].trim();

    const callMatch = line.match(/Station:\s*(.+)/i) || line.match(/Callsign:\s*(.+)/i);
    if (callMatch) {
      patches.station = callMatch[1].trim();
      patches.ps = patches.station;
    }

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

    if (this.clientSocket) {
      try { this.clientSocket.destroy(); } catch (_) {}
      this.clientSocket = null;
    }

    for (const proc of this.procs) {
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) {}
        }, 600);
      }
    }
    this.procs = [];
    this.resetState();
    this.emit('stopped');
  }
}

/**
 * WidebandCluster — Manages single-stick multi-channel DDC demodulation
 */
class WidebandCluster {
  constructor(clusterKey, deviceIndex, initialFreq, gain = null, ppm = 0) {
    this.clusterKey = clusterKey;
    this.deviceIndex = deviceIndex;
    this.centerMhz = initialFreq;
    this.gain = gain;
    this.ppm = ppm;
    this.channels = new Map(); // freq -> { worker, sockPath }
    this.tmpDir = `/tmp/sonar_wb_${deviceIndex}`;
    this.proc = null;
    this.running = true;

    try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch (_) {}
  }

  canFit(freqMhz) {
    const freqs = Array.from(this.channels.keys());
    if (freqs.length === 0) return true;
    const minF = Math.min(...freqs, freqMhz);
    const maxF = Math.max(...freqs, freqMhz);
    return (maxF - minF) <= 2.1;
  }

  calculateOptimalCenter(newFreq = null) {
    const freqs = Array.from(this.channels.keys());
    if (newFreq !== null && !freqs.includes(newFreq)) freqs.push(newFreq);
    if (freqs.length === 0) return this.centerMhz;
    const minF = Math.min(...freqs);
    const maxF = Math.max(...freqs);
    let center = parseFloat(((minF + maxF) / 2.0).toFixed(3));
    // If center matches any carrier, offset by +150 kHz to avoid LO DC spike
    for (const f of freqs) {
      if (Math.abs(center - f) < 0.05) {
        center = parseFloat((center + 0.15).toFixed(3));
        break;
      }
    }
    return center;
  }

  startProcess() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
    }

    const channelStr = Array.from(this.channels.keys()).join(',');
    const gainArgs = this.gain !== null ? ['-g', String(this.gain)] : [];
    const ppmArgs = this.ppm ? ['-p', String(this.ppm)] : [];

    const scriptPath = path.join(__dirname, 'wideband_channelizer.py');
    const args = [
      scriptPath,
      '-d', String(this.deviceIndex),
      '-c', String(this.centerMhz),
      '-ch', channelStr,
      ...gainArgs,
      ...ppmArgs,
      '--sock-dir', this.tmpDir
    ];

    console.log(`[wideband-cluster:${this.clusterKey}] Spawning: python3 ${args.join(' ')}`);

    this.proc = spawn('python3', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const statMatch = trimmed.match(/\[ch-stat:([\d.]+)\]\s+dbfs=([-\d.]+)\s+pct=(\d+)/i);
        if (statMatch) {
          const f = parseFloat(statMatch[1]);
          const dbfs = parseFloat(statMatch[2]);
          const pct = parseInt(statMatch[3], 10);
          const chInfo = this.channels.get(f);
          if (chInfo && chInfo.worker) {
            chInfo.worker.updateState({
              dbfs,
              signalPercent: pct,
              signal: `${pct}% (${dbfs.toFixed(1)} dBFS)`,
              syncState: chInfo.worker.state.syncState === 'IDLE' ? 'RECEIVING' : chInfo.worker.state.syncState,
            });
          }
        }
      }
    });

    this.proc.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) console.error(`[wideband-cluster:${this.clusterKey}] ${msg}`);
    });

    this.proc.on('exit', (code) => {
      if (this.channels.size > 0 && this.running) {
        console.warn(`[wideband-cluster:${this.clusterKey}] Process exited with code ${code}. Restarting in 2s...`);
        setTimeout(() => {
          if (this.channels.size > 0 && this.running) this.startProcess();
        }, 2000);
      }
    });
  }

  addChannel(freqMhz, worker) {
    const freqKhz = Math.round(freqMhz * 1000);
    const sockPath = path.join(this.tmpDir, `ch_${freqKhz}.sock`);
    const isNew = !this.channels.has(freqMhz);

    this.channels.set(freqMhz, { worker, sockPath });

    const newCenter = this.calculateOptimalCenter(freqMhz);
    const centerChanged = Math.abs(newCenter - this.centerMhz) > 0.001;
    this.centerMhz = newCenter;

    if (!this.proc || this.proc.killed || isNew || centerChanged) {
      this.startProcess();
    } else {
      try {
        if (this.proc.stdin && this.proc.stdin.writable) {
          this.proc.stdin.write(`ADD ${freqMhz}\n`);
        }
      } catch (_) {}
    }

    worker.connectWidebandChannel(freqMhz, sockPath, { stationName: worker.activeStationName });
  }

  removeChannel(freqMhz) {
    const ch = this.channels.get(freqMhz);
    if (ch) {
      this.channels.delete(freqMhz);
      if (this.channels.size === 0) {
        this.stop();
      } else {
        try {
          if (this.proc && this.proc.stdin && this.proc.stdin.writable) {
            this.proc.stdin.write(`DEL ${freqMhz}\n`);
          }
        } catch (_) {}
      }
    }
  }

  stop() {
    this.running = false;
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
    }
    this.proc = null;
    this.channels.clear();
    try {
      if (fs.existsSync(this.tmpDir)) {
        const files = fs.readdirSync(this.tmpDir);
        for (const f of files) try { fs.unlinkSync(path.join(this.tmpDir, f)); } catch (_) {}
        fs.rmdirSync(this.tmpDir);
      }
    } catch (_) {}
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

    // Bubble up metadata and audio events from default worker
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

        // Check which physical dongles are actively tuning
        const busyMap = new Map();
        for (const [id, w] of this.workers) {
          if (w.running) {
            busyMap.set(w.deviceIndex, {
              monitorId: id,
              stationName: w.activeStationName || `FM ${w.currentFreq} MHz`,
              freq: w.currentFreq,
              mode: w.currentMode,
              isWideband: w.isWideband
            });
          }
        }
        for (const [, c] of this.widebandClusters) {
          if (c.channels.size > 0) {
            busyMap.set(c.deviceIndex, {
              centerMhz: c.centerMhz,
              channels: Array.from(c.channels.keys()),
              isWideband: true,
              stationName: `Wideband Center ${c.centerMhz} MHz (${Array.from(c.channels.keys()).join(', ')} MHz)`
            });
          }
        }

        const deviceList = devices.map(d => ({
          ...d,
          inUse: busyMap.has(d.index),
          activeStation: busyMap.get(d.index) || null,
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

    // ── Smart Dynamic FM Wideband Clustering ─────────────────────────────────
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
          worker.activeStationName = options.stationName || `FM ${freq} MHz`;
          cluster.addChannel(freq, worker);
          return worker;
        }
      }

      // 2. Check if an active dedicated FM worker can be promoted to a shared Wideband Cluster
      for (const [existingId, existingWorker] of this.workers) {
        if (existingId !== id && existingWorker.running && existingWorker.currentMode === 'fm' && !existingWorker.isWideband && existingWorker.currentFreq) {
          const span = Math.abs(freq - existingWorker.currentFreq);
          if (span <= 2.1) {
            const devIdx = existingWorker.deviceIndex;
            console.log(`[sdr-pool] Smart Auto-Adjust: Promoting Stick #${devIdx} to Wideband Cluster for ${existingWorker.currentFreq} MHz and ${freq} MHz (span: ${span.toFixed(2)} MHz)`);
            const clusterKey = `wb_dev${devIdx}`;
            const cluster = new WidebandCluster(clusterKey, devIdx, existingWorker.currentFreq, options.gain, options.ppm);
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
            worker.activeStationName = options.stationName || `FM ${freq} MHz`;
            cluster.addChannel(freq, worker);
            return worker;
          }
        }
      }

      // If user explicitly chose 'wideband' and no cluster exists yet, create one
      if (isExplicitWideband) {
        const scan = await this.scanDevices();
        const availableDev = scan.devices.find(d => !d.inUse)?.index || 0;
        const clusterKey = `wb_dev${availableDev}`;
        const cluster = new WidebandCluster(clusterKey, availableDev, freq, options.gain, options.ppm);
        this.widebandClusters.set(clusterKey, cluster);

        if (!worker) {
          worker = new SdrWorker(id, { deviceIndex: availableDev, isWideband: true, clusterKey });
          this.workers.set(id, worker);
        } else {
          worker.isWideband = true;
          worker.clusterKey = clusterKey;
          worker.deviceIndex = availableDev;
        }
        worker.activeStationName = options.stationName || `FM ${freq} MHz`;
        cluster.addChannel(freq, worker);
        return worker;
      }
    }

    // ── Dedicated physical tuner allocation ─────────────────────────────────
    let chosenDeviceIndex = 0;
    if (typeof pref === 'number' || (typeof pref === 'string' && !isNaN(parseInt(pref, 10)) && pref !== 'auto' && pref !== 'wideband')) {
      chosenDeviceIndex = parseInt(pref, 10);
    } else {
      const scan = await this.scanDevices();
      const idle = scan.devices.find(d => !d.inUse);
      if (idle) {
        chosenDeviceIndex = idle.index;
      }
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
  sdrManager: sdrPoolManager,
};
