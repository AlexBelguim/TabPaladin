FROM node:22-alpine

# better-sqlite3 needs a compiler at install time on Alpine; su-exec lets the
# entrypoint hand /data over as root and then drop to the node user.
RUN apk add --no-cache python3 make g++ libstdc++ su-exec

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

# The web app ships inside the image, so it is served exactly as built rather
# than from a host folder the container's user may not be allowed to read.
COPY pwa ./pwa

COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# COPY keeps the build host's file modes. On a NAS dataset those often deny
# "other" read access, and the server runs as node, not root: make every file
# readable (and directories enterable) whatever the host's modes were.
RUN chmod -R a+rX /app && chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data && chown node:node /data

# production: Express error pages then carry no stack traces.
ENV NODE_ENV=production
ENV PORT=18921
ENV DATA_DIR=/data
ENV PWA_DIR=/app/pwa
EXPOSE 18921

# Runs unprivileged: the entrypoint starts as root only to make /data the node
# user's (an existing ./data written by an older, root image included), then
# drops to node. See server/docker-entrypoint.sh.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18921)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "index.js"]
