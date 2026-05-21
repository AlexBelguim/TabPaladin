FROM node:22-alpine

# better-sqlite3 needs a compiler at install time on Alpine
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy server source
COPY index.js ./

# PWA is copied from the build context (the repo root, see docker-compose context).
# We mount it at /app/pwa via volume or COPY in compose context.

ENV PORT=18921
ENV DATA_DIR=/data
ENV PWA_DIR=/app/pwa
EXPOSE 18921

CMD ["node", "index.js"]
