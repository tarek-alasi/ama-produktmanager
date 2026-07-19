FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/storage/uploads /app/storage/branding /data/uploads /data/branding     && chown -R node:node /app /data

USER node

EXPOSE 3000

CMD ["npm", "start"]
