#!/usr/bin/env node
// Flip hidden rows visible once enrichment has filled in a hero image or
// a non-fallback description. Pure SQL phase, no external API calls.
//
// Companion to the other phase scripts under scripts/enrichment/. The
// consolidated orchestrator at src/services/maintenance.js already runs
// the same batch in-process; this CLI exists so the Unraid cron can
// invoke it directly alongside the per-phase scripts it already runs.
// Without this entry point the "make ready rows visible" step never
// fires on the live cron — see runPublishReadyBatch in batch.js.
//
// Usage:
//   node scripts/enrichment/publish-ready.js              # flips up to 100
//   node scripts/enrichment/publish-ready.js --limit=500  # custom cap

const { prisma } = require('../lib/bootstrap');
const { runPublishReadyBatch } = require('../../src/services/enrichment/batch');

async function run({ limit = 100 } = {}) {
    const result = await runPublishReadyBatch({ limit });
    console.log(`[publish-ready] scanned=${result.scanned ?? 0} published=${result.published ?? 0}`);
    return result;
}

function parseCliArgs() {
    const intArg = (prefix) => {
        const arg = process.argv.find((a) => a.startsWith(prefix));
        return arg ? parseInt(arg.slice(prefix.length), 10) : null;
    };
    return { limit: intArg('--limit=') || 100 };
}

if (require.main === module) {
    run(parseCliArgs())
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
