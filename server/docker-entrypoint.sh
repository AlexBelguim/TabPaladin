#!/bin/sh
# Starts as root only long enough to make the data directory the server's own,
# then runs the server as the unprivileged `node` user.
#
# A data directory written by an older image (which ran as root), restored
# from a backup, or created on a NAS dataset belongs to someone else, and
# asking every host to chown it by hand is how upgrades fail. Only entries not
# already owned by node are touched, so later boots cost nothing.
#
# Some hosts refuse chown on their datasets (NFSv4 ACLs on TrueNAS, say). If
# node still cannot write there, the server runs as root rather than not at
# all, and says so. RUN_AS=root skips the hand-over entirely.

DATA="${DATA_DIR:-/data}"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

if [ "${RUN_AS}" = "root" ]; then
    echo "[TabPaladin] RUN_AS=root: running as root."
    exec "$@"
fi

mkdir -p "$DATA"
find "$DATA" \! -user node -exec chown node:node {} + 2>/dev/null \
    || echo "[TabPaladin] Could not hand every file in $DATA to the server's user (uid 1000)."

if su-exec node sh -c "test -w '$DATA' && touch '$DATA/.write-test' && rm -f '$DATA/.write-test'"; then
    exec su-exec node "$@"
fi

echo "[TabPaladin] The server's user (uid 1000) cannot write to $DATA, so it runs as root."
echo "[TabPaladin] To run unprivileged, give uid 1000 write access to the data directory on the host."
exec "$@"
