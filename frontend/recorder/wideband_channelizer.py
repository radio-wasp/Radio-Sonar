#!/usr/bin/env python3
"""
wideband_channelizer.py — High-Performance Real-Time Wideband FM Channelizer
Stingray BIC Version 3.1

Captures a 2.4 MSps raw IQ spectrum slice via rtl_sdr, channelizes and demodulates
multiple FM carriers concurrently using vectorized NumPy DSP, and streams 240 kSps
S16LE PCM audio/MPX to independent channel socket endpoints for redsea / ffmpeg.

Features:
- Precomputed complex rotators for zero-copy baseband DDC shift
- 61-tap lowpass FIR filter with 10x decimation (2.4 MSps -> 240 kSps)
- Fast polar discriminator FM demodulation
- Multi-client UNIX domain socket server per channel (with TCP fallback)
- Real-time carrier power, SNR, and dBFS telemetry per channel
- Stdin dynamic channel management (ADD, DEL, CENTER)
"""

import sys
import os
import argparse
import subprocess
import socket
import signal
import time
import numpy as np

# ── DSP Filter Generation ─────────────────────────────────────────────────────

def design_lowpass_fir(num_taps=61, cutoff_hz=90000.0, fs=2400000.0):
    """
    Design a standard Hamming-windowed lowpass FIR filter.
    Cutoff: 90 kHz (bandwidth: 180 kHz for FM broadcast audio + 57 kHz RDS subcarrier)
    """
    n = np.arange(num_taps) - (num_taps - 1) / 2.0
    fc = cutoff_hz / fs
    # Sinc impulse response with Hamming window
    h = np.sinc(2.0 * fc * n) * (2.0 * fc)
    w = np.hamming(num_taps)
    taps = (h * w).astype(np.float32)
    taps /= np.sum(taps)
    return taps

# ── Channel Demodulator Class ─────────────────────────────────────────────────

class FmChannel:
    def __init__(self, freq_mhz, center_mhz, fs_in=2400000, fs_out=240000, fir_taps=None, sock_dir="/tmp/sonar_wb"):
        self.freq_mhz = float(freq_mhz)
        self.center_mhz = float(center_mhz)
        self.fs_in = fs_in
        self.fs_out = fs_out
        self.decim = int(fs_in // fs_out)  # 10
        self.fir_taps = fir_taps if fir_taps is not None else design_lowpass_fir()
        self.num_taps = len(self.fir_taps)
        self.sock_dir = sock_dir

        self.offset_hz = (self.freq_mhz - self.center_mhz) * 1e6
        self.prev_phase = 0.0
        self.prev_sample = 0.0 + 0.0j
        self.fir_state = np.zeros(self.num_taps - 1, dtype=np.complex64)

        # Pre-calculate base rotator table
        self._cached_rotator = None
        self._cached_rot_len = 0

        # Socket server for this channel
        self.freq_khz = int(round(self.freq_mhz * 1000))
        self.sock_path = os.path.join(self.sock_dir, f"ch_{self.freq_khz}.sock")
        self.tcp_port = 9200 + (self.freq_khz % 800)
        self.server_sock = None
        self.clients = []
        self._init_server()

        # Telemetry
        self.last_telemetry_time = time.time()
        self.last_dbfs = -90.0
        self.last_pct = 10

    def _init_server(self):
        try:
            os.makedirs(self.sock_dir, exist_ok=True)
            if os.path.exists(self.sock_path):
                try: os.unlink(self.sock_path)
                except Exception: pass
            
            self.server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server_sock.bind(self.sock_path)
            self.server_sock.listen(8)
            self.server_sock.setblocking(False)
            print(f"[channelizer] Channel {self.freq_mhz} MHz listening on UNIX socket: {self.sock_path}", flush=True)
        except Exception as e:
            try:
                self.server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                self.server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                self.server_sock.bind(('127.0.0.1', self.tcp_port))
                self.server_sock.listen(8)
                self.server_sock.setblocking(False)
                print(f"[channelizer] Channel {self.freq_mhz} MHz listening on TCP port: {self.tcp_port} (UNIX fallback: {e})", flush=True)
            except Exception as e2:
                print(f"[channelizer] ERROR: Failed to bind socket for {self.freq_mhz} MHz: {e2}", flush=True)

    def accept_clients(self):
        if not self.server_sock:
            return
        while True:
            try:
                conn, _ = self.server_sock.accept()
                conn.setblocking(False)
                try: conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 262144)
                except Exception: pass
                self.clients.append(conn)
                print(f"[channelizer] New reader attached to {self.freq_mhz} MHz (total: {len(self.clients)})", flush=True)
            except BlockingIOError:
                break
            except Exception:
                break

    def update_center(self, new_center_mhz):
        self.center_mhz = float(new_center_mhz)
        self.offset_hz = (self.freq_mhz - self.center_mhz) * 1e6
        self._cached_rotator = None
        self.prev_phase = 0.0

    def get_rotator(self, length):
        if self._cached_rotator is None or self._cached_rot_len != length:
            t = np.arange(length, dtype=np.float32) / self.fs_in
            w = -2.0 * np.pi * self.offset_hz
            self._cached_rotator = np.exp(1j * (w * t)).astype(np.complex64)
            self._cached_rot_len = length
            self._phase_step_per_chunk = (w * length / self.fs_in) % (2.0 * np.pi)
        return self._cached_rotator

    def process(self, iq_chunk):
        """
        Processes complex64 IQ chunk at fs_in (2.4 MSps), decimates to 240 kSps,
        FM polar discriminates, and writes S16LE PCM bytes to client sockets.
        """
        N = len(iq_chunk)
        if N == 0:
            return

        # 1. Frequency Shift (DDC)
        rot = self.get_rotator(N)
        if self.prev_phase != 0.0:
            shift_iq = iq_chunk * (rot * np.exp(1j * self.prev_phase))
        else:
            shift_iq = iq_chunk * rot
        self.prev_phase = (self.prev_phase + self._phase_step_per_chunk) % (2.0 * np.pi)

        # 2. FIR Lowpass Filter + Decimation (10x -> 240 kSps)
        conv_input = np.concatenate((self.fir_state, shift_iq))
        self.fir_state = shift_iq[-(self.num_taps - 1):]

        filtered = np.convolve(conv_input, self.fir_taps, mode='valid')
        decimated = filtered[::self.decim]

        # 3. Polar Discriminator FM Demodulation
        if len(decimated) == 0:
            return

        delayed = np.empty_like(decimated)
        delayed[0] = self.prev_sample
        delayed[1:] = decimated[:-1]
        self.prev_sample = decimated[-1]

        prod = decimated * np.conj(delayed)
        demod = np.angle(prod)

        # 4. Scale to 16-bit Signed Integer PCM
        pcm_int16 = np.clip(demod * (32767.0 / np.pi), -32768, 32767).astype(np.int16)
        raw_bytes = pcm_int16.tobytes()

        # 5. Broadcast to connected clients
        self.accept_clients()
        dead_clients = []
        for client in self.clients:
            try:
                client.sendall(raw_bytes)
            except (BlockingIOError, socket.error):
                pass
            except Exception:
                dead_clients.append(client)

        for dc in dead_clients:
            try: dc.close()
            except Exception: pass
            if dc in self.clients:
                self.clients.remove(dc)

        # 6. Telemetry calculation (~every 1.5s)
        now = time.time()
        if now - self.last_telemetry_time >= 1.5:
            self.last_telemetry_time = now
            pwr = np.mean(np.abs(decimated) ** 2) + 1e-12
            dbfs = max(-90.0, min(0.0, float(10.0 * np.log10(pwr))))
            pct = max(10, min(100, int(round(((dbfs + 65.0) / 55.0) * 100.0))))
            self.last_dbfs = dbfs
            self.last_pct = pct
            print(f"[ch-stat:{self.freq_mhz:.3f}] dbfs={dbfs:.1f} pct={pct} clients={len(self.clients)}", flush=True)

    def close(self):
        for c in self.clients:
            try: c.close()
            except Exception: pass
        self.clients = []
        if self.server_sock:
            try: self.server_sock.close()
            except Exception: pass
            self.server_sock = None
        if os.path.exists(self.sock_path):
            try: os.unlink(self.sock_path)
            except Exception: pass


# ── Main Channelizer Engine ───────────────────────────────────────────────────

class WidebandChannelizer:
    def __init__(self, device_index, center_mhz, channel_list, gain=None, ppm=0, sock_dir="/tmp/sonar_wb"):
        self.device_index = int(device_index)
        self.center_mhz = float(center_mhz)
        self.gain = gain
        self.ppm = int(ppm)
        self.sock_dir = sock_dir
        self.fs = 2400000
        self.fir_taps = design_lowpass_fir(num_taps=61, cutoff_hz=90000.0, fs=self.fs)

        self.channels = {}  # freq_mhz -> FmChannel
        self.running = True
        self.rtl_proc = None

        os.makedirs(self.sock_dir, exist_ok=True)
        for freq in channel_list:
            self.add_channel(freq)

    def add_channel(self, freq_mhz):
        freq_mhz = float(freq_mhz)
        if freq_mhz not in self.channels:
            ch = FmChannel(freq_mhz, self.center_mhz, fs_in=self.fs, fs_out=240000, fir_taps=self.fir_taps, sock_dir=self.sock_dir)
            self.channels[freq_mhz] = ch
            print(f"[channelizer] Activated Channel {freq_mhz} MHz (Offset: {(freq_mhz - self.center_mhz)*1000:+.1f} kHz)", flush=True)

    def remove_channel(self, freq_mhz):
        freq_mhz = float(freq_mhz)
        if freq_mhz in self.channels:
            self.channels[freq_mhz].close()
            del self.channels[freq_mhz]
            print(f"[channelizer] Deactivated Channel {freq_mhz} MHz", flush=True)

    def set_center(self, new_center_mhz):
        new_center_mhz = float(new_center_mhz)
        if abs(new_center_mhz - self.center_mhz) > 0.001:
            print(f"[channelizer] Shifting Center Freq: {self.center_mhz} -> {new_center_mhz} MHz", flush=True)
            self.center_mhz = new_center_mhz
            for ch in self.channels.values():
                ch.update_center(new_center_mhz)
            self._restart_rtl_sdr()

    def _start_rtl_sdr(self):
        if self.rtl_proc and self.rtl_proc.poll() is None:
            try: self.rtl_proc.kill()
            except Exception: pass

        dev_arg = ['-d', str(self.device_index)]
        ppm_arg = ['-p', str(self.ppm)] if self.ppm else []
        gain_arg = ['-g', str(self.gain)] if (self.gain is not None and str(self.gain).lower() != 'auto') else []

        center_hz = int(round(self.center_mhz * 1e6))
        cmd = [
            'rtl_sdr',
            *dev_arg,
            *ppm_arg,
            *gain_arg,
            '-s', str(self.fs),
            '-f', str(center_hz),
            '-'
        ]

        print(f"[channelizer] Spawning SDR capture: {' '.join(cmd)}", flush=True)
        self.rtl_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=262144
        )

    def _restart_rtl_sdr(self):
        self._start_rtl_sdr()

    def run(self):
        self._start_rtl_sdr()
        chunk_bytes = 262144  # 131,072 complex samples per chunk (~54.6 ms)

        try:
            import fcntl
            fl = fcntl.fcntl(sys.stdin.fileno(), fcntl.F_GETFL)
            fcntl.fcntl(sys.stdin.fileno(), fcntl.F_SETFL, fl | os.O_NONBLOCK)
        except Exception:
            pass

        print(f"[channelizer] Wideband Channelizer Engine Online! Center: {self.center_mhz} MHz, Bandwidth: 2.4 MHz", flush=True)

        while self.running:
            try:
                line = sys.stdin.readline()
                if line:
                    parts = line.strip().split()
                    if parts:
                        cmd = parts[0].upper()
                        if cmd == 'ADD' and len(parts) > 1:
                            self.add_channel(float(parts[1]))
                        elif cmd == 'DEL' and len(parts) > 1:
                            self.remove_channel(float(parts[1]))
                        elif cmd == 'CENTER' and len(parts) > 1:
                            self.set_center(float(parts[1]))
                        elif cmd == 'QUIT' or cmd == 'STOP':
                            break
            except Exception:
                pass

            if not self.rtl_proc or self.rtl_proc.poll() is not None:
                print("[channelizer] rtl_sdr exited or failed to start. Restarting in 2s...", flush=True)
                time.sleep(2.0)
                self._start_rtl_sdr()
                continue

            try:
                raw = self.rtl_proc.stdout.read(chunk_bytes)
                if not raw or len(raw) < 1024:
                    time.sleep(0.01)
                    continue

                raw_u8 = np.frombuffer(raw, dtype=np.uint8)
                n_samples = len(raw_u8) // 2
                raw_u8 = raw_u8[:n_samples * 2]

                i_samp = (raw_u8[0::2].astype(np.float32) - 127.5) * (1.0 / 128.0)
                q_samp = (raw_u8[1::2].astype(np.float32) - 127.5) * (1.0 / 128.0)
                iq_complex = i_samp + 1j * q_samp

                for ch in list(self.channels.values()):
                    ch.process(iq_complex)

            except Exception as e:
                print(f"[channelizer] Processing error: {e}", flush=True)
                time.sleep(0.05)

        self.stop()

    def stop(self):
        self.running = False
        if self.rtl_proc:
            try: self.rtl_proc.kill()
            except Exception: pass
            self.rtl_proc = None
        for ch in self.channels.values():
            ch.close()
        self.channels.clear()
        print("[channelizer] Engine shutdown complete.", flush=True)


# ── CLI Interface ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Wideband RTL-SDR FM Channelizer")
    parser.add_argument("--device", "-d", default="0", help="RTL-SDR device index")
    parser.add_argument("--center", "-c", type=float, required=True, help="Center frequency in MHz")
    parser.add_argument("--channels", "-ch", required=True, help="Comma-separated channel frequencies in MHz")
    parser.add_argument("--gain", "-g", default=None, help="Tuner gain in dB or auto")
    parser.add_argument("--ppm", "-p", type=int, default=0, help="PPM frequency correction")
    parser.add_argument("--sock-dir", default="/tmp/sonar_wb", help="Directory for channel sockets")

    args = parser.parse_args()
    channel_list = [float(f.strip()) for f in args.channels.split(",") if f.strip()]

    engine = WidebandChannelizer(
        device_index=args.device,
        center_mhz=args.center,
        channel_list=channel_list,
        gain=args.gain,
        ppm=args.ppm,
        sock_dir=args.sock_dir
    )

    def handle_sig(sig, frame):
        engine.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    engine.run()


if __name__ == "__main__":
    main()
