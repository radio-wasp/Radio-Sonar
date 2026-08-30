# Radio SONAR v3.1

**Radio Intelligence Platform** — Monitor Canadian and International radio stations in real time, detect commercials, log music, record ad breaks, analyze advertiser data across multiple networks, and demodulate **Off-Air Analog FM (with real-time RDS)** and **Digital HD Radio (NRSC-5 HD1–HD4)** using **Multiple RTL-SDR USB Sticks** and **Single-Stick Wideband FM Channelization**.

---

## What's New in Version 3.1

- 📻 **Multi-Dongle Device Pooling**: Concurrently operate multiple RTL-SDR USB dongles (`-d 0`, `-d 1`, `-d 2`, ...) across different frequencies and monitor them simultaneously with dedicated audio streams and AI transcribers.
- ⚡ **Single-Stick Wideband FM Channelizer**: Demodulate multiple nearby FM broadcast carriers concurrently from a single 2.4 MHz IQ spectrum window on **one USB stick** via high-speed vectorized Python DSP (`wideband_channelizer.py`).
- 📡 **Real-time RDS & HD Telemetry**: Live decoding of RDS PS (Program Service), RadioText, RadioText+ (Artist/Title), carrier synchronization lock status, MER (Modulation Error Ratio dB), and BER signal metrics.
- ⚡ **Adaptive Acoustic Dual-Fingerprinting**: Hybrid Shazam + Chromaprint music detection that reduces CPU load by 70% during track play.
- 🎙 **Automated OpenAI Whisper Transcription**: Fully offline local or high-speed cloud transcription of detected ad spots.
- 🔌 **Model Context Protocol (MCP) Server**: Expose stations, monitors, ad history, and SDR hardware controls to AI tools.

---

## Hardware Setup (RTL-SDR)

1. Plug an RTL-SDR v3/v4 or compatible USB dongle into the host server.
2. In `docker-compose.yml`, the USB subsystem is passed through:
   ```yaml
   devices:
     - /dev/bus/usb:/dev/bus/usb
   ```
3. The Docker container automatically blacklists `dvb_usb_rtl28xxu` kernel drivers so `libusb` can claim the receiver.

---

## Features

- **Live metadata monitoring** across Bell, Rogers, Corus, Stingray, Maritime Broadcasting, Vista, Pattison, Acadia, TuneIn, and Off-Air RTL-SDR.
- **Commercial detection** using network-specific signals (Triton ad types, blank titles, acoustic fingerprinting, volume drop, and silence detection).
- **Music & commercial history** logging per station with timestamps.
- **Automatic recording** of commercial breaks as MP3 files.
- **MusicBrainz integration** — look up and apply canonical artist/title/album/artwork to logged songs.
- **Station library** with 300+ Canadian stations across 9 networks and custom SDR presets.
- **Pure White & Deep Midnight Blue UI**.

---

## Getting Started

### Installation

1. Clone the repository
2. Run `docker-compose up --build -d`
3. Open `http://localhost:8090` in your browser

---

*Radio SONAR · Version 3.0 · Built for Advanced Broadcast Intelligence & RF Demodulation*
