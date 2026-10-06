# Stage 1: Build nrsc5 (HD Radio) and redsea (RDS Decoder) from source
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git pkg-config \
    autoconf automake libtool patch wget \
    meson ninja-build \
    librtlsdr-dev libusb-1.0-0-dev libao-dev libfftw3-dev \
    libsndfile1-dev libliquid-dev nlohmann-json3-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build nrsc5 from source
RUN git clone --depth 1 https://github.com/theori-io/nrsc5.git /src/nrsc5 \
    && mkdir -p /src/nrsc5/build \
    && cd /src/nrsc5/build \
    && cmake .. -DCMAKE_BUILD_TYPE=Release \
    && make -j"$(nproc)" \
    && make install \
    && ldconfig

# Build redsea (RDS decoder) from source
RUN git clone --depth 1 https://github.com/windytan/redsea.git /src/redsea \
    && cd /src/redsea \
    && meson setup build --prefix=/usr/local \
    && meson compile -C build \
    && meson install -C build \
    && ldconfig


# Stage 2: Runtime image with Node.js 20, Python AI tools, and SDR demodulators
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    rtl-sdr \
    librtlsdr0 \
    libao4 \
    libfftw3-bin \
    libsndfile1-dev \
    libliquid-dev \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-pip \
    python3-venv \
    usbutils \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Copy nrsc5 + redsea binaries and shared libraries from builder stage
COPY --from=builder /usr/local/bin/nrsc5 /usr/local/bin/nrsc5
COPY --from=builder /usr/local/bin/redsea /usr/local/bin/redsea
COPY --from=builder /usr/local/lib/ /usr/local/lib/
RUN ldconfig

# Blacklist kernel DVB driver so libusb can claim the RTL-SDR dongle
RUN echo "blacklist dvb_usb_rtl28xxu" > /etc/modprobe.d/blacklist-rtl.conf

# Install whisper, shazamio, and DSP channelizer libs in a virtualenv
RUN python3 -m venv /opt/whisper-env && \
    /opt/whisper-env/bin/pip install --upgrade pip && \
    /opt/whisper-env/bin/pip install openai-whisper shazamio numpy scipy

ENV PATH="/opt/whisper-env/bin:$PATH"

WORKDIR /app
COPY package.json .
RUN npm install
COPY data ./data
COPY audio_dsp.js .
COPY transcriber.js .
COPY sdr_receiver.js .
COPY wideband_channelizer.py .
COPY shazam_recognize.py .
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
