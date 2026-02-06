const crypto = require("crypto");

function parseKeys(raw) {
    return String(raw || "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
}

function getProvidedKey(req) {
    const headerKey =
        req.get("x-api-key") ||
        req.get("x-api_key") ||
        req.get("x-api-token");
    if (headerKey) return String(headerKey).trim();

    const auth = req.get("authorization");
    if (auth && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }

    if (req.query && typeof req.query.api_key === "string") {
        return req.query.api_key.trim();
    }
    if (req.query && typeof req.query.apiKey === "string") {
        return req.query.apiKey.trim();
    }
    return "";
}

function safeEquals(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

function requireApiKey(options = {}) {
    const envKey = options.envKey || "ADMIN_API_KEYS";
    const keys = parseKeys(process.env[envKey]);

    return (req, res, next) => {
        if (!keys.length) {
            res.set("Cache-Control", "public, max-age=3600");
            return res.status(404).end();
        }

        const provided = getProvidedKey(req);
        if (!provided) {
            res.set("Cache-Control", "public, max-age=3600");
            return res.status(404).end();
        }

        for (const key of keys) {
            if (safeEquals(provided, key)) {
                return next();
            }
        }

        res.set("Cache-Control", "public, max-age=3600");
        return res.status(404).end();
    };
}

module.exports = { requireApiKey };
