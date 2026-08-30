FROM node:22-alpine

# better-sqlite3 needs a compiler at install time on Alpine
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /app

# Install deps first (cache layer)
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev

# Copy server source. A glob rather than a list of filenames: index.js used to
# be named explicitly, so adding items.js shipped a container whose entrypoint
# imported a file that was not in the image, and it crash-looped on boot.
# server/*.js matches top-level modules only, so node_modules is not pulled in
# (its native better-sqlite3 build is for the host OS and would not run here).
COPY server/*.js ./
COPY server/imports ./imports

# PWA is copied from the build context (the repo root, see docker-compose context).
# We mount it at /app/pwa via volume or COPY in compose context.

ENV PORT=18921
ENV DATA_DIR=/data
ENV PWA_DIR=/app/pwa
EXPOSE 18921

CMD ["node", "index.js"]
