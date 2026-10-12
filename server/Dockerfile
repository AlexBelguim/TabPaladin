FROM node:22-alpine

# better-sqlite3 needs a compiler at install time on Alpine
RUN apk add --no-cache python3 make g++ libstdc++

WORKDIR /app

# Install deps first (cache layer)
COPY server/package.json server/package-lock.json ./
# npm ci installs exactly what the lockfile pins, so an image build can't pick
# up a newer (or compromised) transitive dependency than the one audited.
RUN npm ci --omit=dev && npm cache clean --force

# Copy server source. A glob rather than a list of filenames: index.js used to
# be named explicitly, so adding items.js shipped a container whose entrypoint
# imported a file that was not in the image, and it crash-looped on boot.
# server/*.js matches top-level modules only, so node_modules is not pulled in
# (its native better-sqlite3 build is for the host OS and would not run here).
COPY server/*.js ./
COPY server/imports ./imports

# /data is a bind mount in compose; it is created here so a container without
# one still has somewhere writable for the unprivileged user.
RUN mkdir -p /data && chown node:node /data

# PWA is copied from the build context (the repo root, see docker-compose context).
# We mount it at /app/pwa via volume or COPY in compose context.

# production: Express error pages then carry no stack traces.
ENV NODE_ENV=production
ENV PORT=18921
ENV DATA_DIR=/data
ENV PWA_DIR=/app/pwa
EXPOSE 18921

# Run unprivileged. An existing ./data directory written by the old root
# container must be handed over once: chown -R 1000:1000 ./data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18921)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "index.js"]
