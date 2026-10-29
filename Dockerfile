FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages edge-tts
WORKDIR /app
COPY server.mjs .
CMD ["node", "server.mjs"]
