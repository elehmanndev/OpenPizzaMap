#!/bin/sh
# Container entrypoint for the Unraid opm-runner.
#
# Pulls the latest code from main on every start so `docker restart
# opm-runner` is enough to ship a new commit — no rebuild dance,
# no Edit-Apply in the Unraid UI.
#
# The image still carries Node + Chromium + an initial copy of the
# repo and node_modules from build time. This script just:
#   1. fast-forwards the working tree to origin/main
#   2. reinstalls dependencies ONLY when package-lock.json has changed
#   3. regenerates Prisma client (fast, idempotent)
#   4. execs into the runner
#
# Failure modes are intentionally non-fatal: a network blip during
# git fetch keeps the container running with the previous code rather
# than crash-looping. Worst case Eric notices the runner is on stale
# code and we deal with it.

set -e
cd /app

log() { echo "[entrypoint $(date -u +%H:%M:%S)] $*"; }

# ─── Pull latest code ──────────────────────────────────────────────────────
log "fetching origin/main…"
if git fetch --quiet origin main 2>/dev/null; then
    OLD_SHA=$(git rev-parse HEAD)
    git reset --quiet --hard origin/main
    NEW_SHA=$(git rev-parse HEAD)
    if [ "$OLD_SHA" = "$NEW_SHA" ]; then
        log "already on latest ($NEW_SHA)"
    else
        log "updated $OLD_SHA → $NEW_SHA"
    fi
else
    log "git fetch failed (network blip?) — staying on existing code"
fi

# ─── Reinstall deps only if package-lock changed ───────────────────────────
HASH_FILE=/app/.docker-lock-hash
NEW_HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
OLD_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")
if [ "$NEW_HASH" != "$OLD_HASH" ]; then
    log "package-lock.json changed — running npm ci…"
    SKIP_PLAYWRIGHT_INSTALL=1 npm ci --ignore-scripts --no-audit --no-fund 2>&1 | tail -5
    echo "$NEW_HASH" > "$HASH_FILE"
else
    log "package-lock.json unchanged, skipping npm ci"
fi

# ─── Regen Prisma client (fast, idempotent) ────────────────────────────────
log "prisma generate…"
npx prisma generate 2>&1 | tail -3

# ─── Hand off to the runner. exec replaces this shell with node, so node ──
# becomes PID 1 and gets SIGTERM directly when Docker stops the container.
log "starting runner"
exec node scripts/cron/runner.js
