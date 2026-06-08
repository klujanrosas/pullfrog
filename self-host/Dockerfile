FROM node:24-slim AS base

WORKDIR /app

# better-sqlite3 needs python3 + make + g++ for native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Data volume
RUN mkdir -p /data
VOLUME /data

ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3456

CMD ["node", "--import", "tsx", "src/server.ts"]
