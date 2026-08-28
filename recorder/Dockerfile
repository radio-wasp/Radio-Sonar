FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libchromaprint-tools \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install whisper and shazamio in a venv
RUN python3 -m venv /opt/whisper-env && \
    /opt/whisper-env/bin/pip install --upgrade pip && \
    /opt/whisper-env/bin/pip install openai-whisper shazamio

ENV PATH="/opt/whisper-env/bin:$PATH"

WORKDIR /app
COPY package.json .
RUN npm install
COPY data ./data
COPY audio_dsp.js .
COPY transcriber.js .
COPY shazam_recognize.py .
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
