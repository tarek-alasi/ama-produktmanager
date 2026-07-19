FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       make \
       g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Stabile npm-Version verwenden und npm ci umgehen
RUN npm install --global npm@10.8.2 \
    && npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

CMD ["node", "src/server.js"]