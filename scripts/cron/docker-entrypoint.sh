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

# ─── Reinstall deps only if package-lock changed OR a critical dev dep ─────
# was previously pruned. The dev-dep guard exists because a prior bad
# entrypoint run (pre-2026-05-20 without --include=dev) could prune
# playwright AND update the hash file, so the next start would see
# "unchanged" and never reinstall the missing module.
HASH_FILE=/app/.docker-lock-hash
NEW_HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
OLD_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")
NEED_INSTALL=""
if [ "$NEW_HASH" != "$OLD_HASH" ]; then
    NEED_INSTALL="package-lock.json changed"
elif [ ! -d node_modules/playwright ]; then
    NEED_INSTALL="playwright missing from node_modules"
fi
if [ -n "$NEED_INSTALL" ]; then
    log "$NEED_INSTALL — running npm ci…"
    # --include=dev because the runner needs playwright (which lives in
    # devDependencies so Hostinger's prod install doesn't pull it in).
    SKIP_PLAYWRIGHT_INSTALL=1 npm ci --include=dev --ignore-scripts --no-audit --no-fund 2>&1 | tail -5
    echo "$NEW_HASH" > "$HASH_FILE"
else
    log "package-lock.json unchanged + deps intact, skipping npm ci"
fi

# Ensure playwright is actually loadable. The Unraid restart path
# recreates the container from the image, and the image's build-time
# npm ci (without --include=dev) may have left the playwright npm
# package out or partial — so node_modules/playwright can exist as a
# stale directory but require('playwright') still throws MODULE_NOT_FOUND.
# Force-install on every start. Idempotent: instant when already correct.
if ! node -e "require.resolve('playwright')" 2>/dev/null; then
    log "playwright not loadable — force-installing"
    SKIP_PLAYWRIGHT_INSTALL=1 npm install playwright@1.59.1 --no-save --ignore-scripts --no-audit --no-fund 2>&1 | tail -3
fi

# ─── Regen Prisma client (fast, idempotent) ────────────────────────────────
log "prisma generate…"
npx prisma generate 2>&1 | tail -3

# ─── Hand off to the runner. exec replaces this shell with node, so node ──
# becomes PID 1 and gets SIGTERM directly when Docker stops the container.
log "starting runner"
exec node scripts/cron/runner.js
