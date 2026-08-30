#!/usr/bin/env python3
"""
wideband_channelizer.py — Radio SONAR Wideband FM Channelizer (Version 3.1)

Demodulates multiple FM broadcast carrier frequencies concurrently from a single
RTL-SDR USB dongle capturing a 2.4 MSps raw IQ spectrum window.

Pipeline per channel:
1. Capture 2.4 MSps raw IQ via `rtl_sdr`
2. Digital Down Conversion (DDC): Frequency translation by Delta_f = f_target - f_center
3. Lowpass Decimation FIR filter: 2.4 MSps -> 240 kSps / 171 kSps
4. Polar angle discriminator: Phase difference -> FM Baseband MPX
5. Writes demodulated S16LE audio to channel output pipe/FIFO or stdout
"""

import sys
import os
import argparse
import subprocess
import signal
import time
import math
import numpy as np

try:
    from scipy import signal as sp_signal
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False

class ChannelDemodulator:
    def __init__(self, freq_mhz, center_mhz, sample_rate, out_path, out_rate=240000):
        self.freq_mhz = freq_mhz
        self.center_mhz = center_mhz
        self.in_rate = sample_rate
        self.out_rate = out_rate
        self.delta_f = (freq_mhz - center_mhz) * 1e6  # Hz offset
        self.out_path = out_path
        self.out_file = None
        self.phase = 0.0
        self.prev_sample = 0.0 + 0.0j

        # Decimation factor: 2,400,000 / 240,000 = 10
        self.decim_factor = int(self.in_rate // self.out_rate)
        if self.decim_factor < 1:
            self.decim_factor = 1

        # Pre-compute FIR filter coefficients for decimation (cutoff at 85 kHz for FM MPX)
        cutoff_hz = 85000.0
        num_taps = 61
        nyquist = self.in_rate / 2.0
        norm_cutoff = cutoff_hz / nyquist

        if HAVE_SCIPY:
            self.fir = sp_signal.firwin(num_taps, norm_cutoff, window='hamming').astype(np.float32)
            self.fir_state = np.zeros(num_taps - 1, dtype=np.complex64)
        else:
            # Simple windowed sinc fallback
            t = np.arange(- (num_taps // 2), (num_taps // 2) + 1)
            h = np.sinc(2 * norm_cutoff * t) * (2 * norm_cutoff)
            w = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(num_taps) / (num_taps - 1))
            self.fir = (h * w / np.sum(h * w)).astype(np.float32)
            self.fir_state = np.zeros(num_taps - 1, dtype=np.complex64)

    def open_output(self):
        try:
            if self.out_path == '-':
                self.out_file = sys.stdout.buffer
            elif os.path.exists(self.out_path):
                # Named pipe (FIFO)
                self.out_file = open(self.out_path, 'wb', buffering=0)
            else:
                self.out_file = open(self.out_path, 'wb')
        except Exception as err:
            sys.stderr.write(f"[channelizer] Failed to open {self.out_path}: {err}\n")
            self.out_file = None

    def process_iq(self, iq_chunk):
        """
        Process complex float32 IQ array at in_rate, output S16LE FM MPX to out_file
        """
        if self.out_file is None:
            return

        n_samples = len(iq_chunk)
        if n_samples == 0:
            return

        # 1. Digital Down Conversion (DDC) frequency shift
        # exp(-j * 2 * pi * delta_f * t)
        t = np.arange(n_samples, dtype=np.float64) / self.in_rate
        rot_phase = self.phase - (2.0 * np.pi * self.delta_f * t)
        # Advance running phase for seamless cross-chunk continuity
        self.phase = math.fmod(self.phase - (2.0 * np.pi * self.delta_f * n_samples / self.in_rate), 2.0 * np.pi)

        rotator = (np.cos(rot_phase) + 1j * np.sin(rot_phase)).astype(np.complex64)
        shifted = iq_chunk * rotator

        # 2. Lowpass Filter
        if HAVE_SCIPY:
            filtered, self.fir_state = sp_signal.lfilter(self.fir, 1.0, shifted, zi=self.fir_state)
        else:
            filtered = np.convolve(shifted, self.fir, mode='same')

        # 3. Decimate to out_rate
        decimated = filtered[::self.decim_factor]

        if len(decimated) < 2:
            return

        # 4. FM Polar Discriminator (angle of product with conjugate of previous sample)
        delayed = np.empty_like(decimated)
        delayed[0] = self.prev_sample
        delayed[1:] = decimated[:-1]
        self.prev_sample = decimated[-1]

        # Phase difference: dtheta = angle(x[n] * conj(x[n-1]))
        prod = decimated * np.conj(delayed)
        dtheta = np.angle(prod)  # range [-pi, pi]

        # 5. Scale to 16-bit PCM: max FM deviation +-75 kHz at out_rate 240k corresponds to dtheta = 2*pi*(75k/240k) ~= 1.96 rad
        # Normalize so 75 kHz deviation maps to ~16384 (half-scale)
        scale = 32767.0 / np.pi
        pcm16 = np.clip(dtheta * scale, -32768, 32767).astype(np.int16)

        try:
            self.out_file.write(pcm16.tobytes())
        except (BrokenPipeError, IOError):
            # Output pipe closed by consumer
            pass

    def close(self):
        if self.out_file and self.out_file != sys.stdout.buffer:
            try:
                self.out_file.close()
            except Exception:
                pass
            self.out_file = None


def main():
    parser = argparse.ArgumentParser(description="Radio SONAR Wideband FM Channelizer")
    parser.add_argument('--device', type=str, default='0', help='RTL-SDR device index or serial')
    parser.add_argument('--center', type=float, required=True, help='Center tuning frequency in MHz')
    parser.add_argument('--sample-rate', type=int, default=2400000, help='IQ sample rate (default 2400000)')
    parser.add_argument('--gain', type=str, default='auto', help='Tuner gain in dB or auto')
    parser.add_argument('--ppm', type=int, default=0, help='PPM frequency correction')
    parser.add_argument('--channels', type=str, required=True,
                        help='Comma-separated freq_mhz:output_path pairs (e.g. 104.9:/tmp/ch1.raw,105.1:/tmp/ch2.raw)')

    args = parser.parse_args()

    # Parse channels
    channels = []
    for pair in args.channels.split(','):
        pair = pair.strip()
        if not pair:
            continue
        parts = pair.split(':')
        if len(parts) != 2:
            sys.stderr.write(f"[channelizer] Invalid channel format: {pair}\n")
            continue
        freq = float(parts[0])
        out_path = parts[1]
        ch = ChannelDemodulator(freq, args.center, args.sample_rate, out_path)
        channels.append(ch)

    if not channels:
        sys.stderr.write("[channelizer] No valid channels specified.\n")
        sys.exit(1)

    sys.stderr.write(f"[channelizer] Starting on device {args.device}, center {args.center:.3f} MHz, rate {args.sample_rate} Sps\n")
    for ch in channels:
        offset_khz = (ch.freq_mhz - args.center) * 1e3
        sys.stderr.write(f"[channelizer]  • Channel {ch.freq_mhz:.1f} MHz (offset: {offset_khz:+.1f} kHz) -> {ch.out_path}\n")
        ch.open_output()

    # Build rtl_sdr command
    rtl_cmd = ['rtl_sdr', '-d', str(args.device), '-f', f"{int(args.center * 1e6)}", '-s', str(args.sample_rate)]
    if args.gain.lower() != 'auto':
        try:
            gain_val = float(args.gain)
            rtl_cmd.extend(['-g', str(gain_val)])
        except ValueError:
            pass
    if args.ppm != 0:
        rtl_cmd.extend(['-p', str(args.ppm)])
    rtl_cmd.append('-')

    sys.stderr.write(f"[channelizer] Executing: {' '.join(rtl_cmd)}\n")

    proc = subprocess.Popen(rtl_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def handle_sig(sig, frame):
        proc.terminate()
        for ch in channels:
            ch.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sig)
    signal.signal(signal.SIGTERM, handle_sig)

    # Read blocks of 262,144 bytes = 131,072 IQ sample pairs
    # (at 2.4 MSps this is ~54.6 ms of audio per chunk)
    CHUNK_BYTES = 262144

    try:
        while proc.poll() is None:
            raw = proc.stdout.read(CHUNK_BYTES)
            if not raw or len(raw) < 4:
                break

            # Convert interleaved uint8 [I0, Q0, I1, Q1, ...] to float32 complex centered at 0
            u8_arr = np.frombuffer(raw, dtype=np.uint8)
            # Ensure even number of samples
            if len(u8_arr) % 2 != 0:
                u8_arr = u8_arr[:-1]

            i_samples = (u8_arr[0::2].astype(np.float32) - 127.5) / 127.5
            q_samples = (u8_arr[1::2].astype(np.float32) - 127.5) / 127.5
            iq_complex = i_samples + 1j * q_samples

            # Dispatch chunk to all active channel demodulators
            for ch in channels:
                ch.process_iq(iq_complex)

    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        for ch in channels:
            ch.close()
        sys.stderr.write("[channelizer] Finished.\n")

if __name__ == '__main__':
    main()
