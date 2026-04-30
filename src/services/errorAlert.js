// Fire-and-forget webhook alerts for 5xx errors. Pointed at a Slack/Discord
// incoming webhook (or anything that accepts a JSON POST), this gets us
// real-time notification without paying for Sentry.
//
// Disabled by default: ERROR_WEBHOOK_URL must be set in the env to opt in.
// Cooldown is per (errCode|path) fingerprint so a stuck endpoint doesn't
// flood the channel — the same error class on the same route fires at most
// once per minute. Failed POSTs are swallowed so the alerting path never
// recurses or backpressures the request handler.

const COOLDOWN_MS = 60 * 1000;
const lastSent = new Map();

async function alertError(info) {
    const url = process.env.ERROR_WEBHOOK_URL;
    if (!url) return;

    const fingerprint = `${info.errCode || info.errName || "Error"}|${info.path || ""}`;
    const now = Date.now();
    const last = lastSent.get(fingerprint) || 0;
    if (now - last < COOLDOWN_MS) return;
    lastSent.set(fingerprint, now);

    const text =
        `:rotating_light: OpenPizzaMap *${info.status}* on \`${info.method} ${info.path}\`\n` +
        "```" +
        `${info.errName || "Error"}${info.errCode ? ` (${info.errCode})` : ""}: ${info.errMsg || ""}` +
        "```";

    const payload = {
        // Slack/Mattermost shape; Discord ignores `text` but uses `content` —
        // we send both so a single env var works in either ecosystem.
        text,
        content: text,
        meta: {
            ts: new Date().toISOString(),
            method: info.method,
            path: info.path,
            status: info.status,
            errName: info.errName,
            errCode: info.errCode,
            errMsg: info.errMsg,
        },
    };

    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            // Don't let a slow webhook tie up the request handler.
            signal: AbortSignal.timeout(3000),
        });
    } catch (_e) {
        // Swallowed on purpose — alerts must never raise.
    }
}

module.exports = { alertError };
