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
elif [ ! -d node_modules/sharp ]; then
    NEED_INSTALL="sharp missing from node_modules"
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
    # NODE_ENV=development override needed: with NODE_ENV=production
    # (set on the container for the live app), npm install silently
    # skips devDependencies even with --no-save, so playwright stays
    # missing and the next start hits this same branch in a loop.
    # See notes/sessions/2026-05-23 — probe found the runner had been
    # FAILing on playwrightFallback for at least a week because of this.
    SKIP_PLAYWRIGHT_INSTALL=1 NODE_ENV=development npm install playwright@1.59.1 --no-save --include=dev --ignore-scripts --no-audit --no-fund 2>&1 | tail -3
fi

# Same self-heal pattern for sharp. Added 2026-05-28 when the v2 photo
# pipeline (process-and-upload-photos.js) shipped — opm-runner now
# runs libvips locally for resize ops, where before sharp was only on
# Hostinger. The image built pre-v2 has no sharp in node_modules, and
# `--ignore-scripts` during npm ci would skip sharp's prebuilt-binary
# download anyway. So force-install with scripts enabled if missing.
if ! node -e "require.resolve('sharp')" 2>/dev/null; then
    log "sharp not loadable — force-installing (scripts enabled for prebuilt binary)"
    NODE_ENV=development npm install sharp --no-save --include=dev --no-audit --no-fund 2>&1 | tail -3
fi

# CloakBrowser self-heal. Added 2026-05-28 when the TA scrape revealed
# TA fingerprints stock Playwright and returns blank pages
# (bodyLen=0, no h1, no og:title, title="tripadvisor.com"). CloakBrowser
# patches the navigator.webdriver + other detection vectors; the same
# memory note that documents this for Gambero Rosso (Cloudflare-gated
# AJAX) applies here. ~535MB binary, MIT, install with --no-save.
if ! node -e "require.resolve('cloakbrowser')" 2>/dev/null; then
    log "cloakbrowser not loadable — force-installing for TA scrape"
    NODE_ENV=development npm install cloakbrowser --no-save --include=dev --no-audit --no-fund 2>&1 | tail -3
fi

# ─── Regen Prisma client (fast, idempotent) ────────────────────────────────
log "prisma generate…"
npx prisma generate 2>&1 | tail -3

# ─── Hand off to the runner. exec replaces this shell with node, so node ──
# becomes PID 1 and gets SIGTERM directly when Docker stops the container.
log "starting runner"
exec node scripts/cron/runner.js
