// IP → default map view. Used as the fallback on /map when the browser
// denies/ignores navigator.geolocation. geoip-lite ships a bundled
// GeoLite2 country/city DB (~50MB on disk after install); no external
// API call, no key, no per-lookup cost — fits the budget rule.
//
// Returns the IP block's centroid (`ll` from geoip-lite) at a country-
// level zoom. The block centroid is often city-accurate which is
// strictly better than a country-centre lookup table.
//
// Fallback: Europe at zoom 4 — same as the prior hardcoded default, used
// when no IP, no match, or the lookup returns an unusable shape.

const geoip = require("geoip-lite");

const EUROPE_FALLBACK = { lat: 48, lng: 10, zoom: 4, source: "fallback" };

function getDefaultMapView(req) {
    try {
        const ip = pickClientIp(req);
        if (!ip) return EUROPE_FALLBACK;
        const hit = geoip.lookup(ip);
        if (!hit || !Array.isArray(hit.ll) || hit.ll.length !== 2) return EUROPE_FALLBACK;
        const [lat, lng] = hit.ll;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return EUROPE_FALLBACK;
        return {
            lat,
            lng,
            zoom: 5,
            source: hit.country ? `geoip:${hit.country}` : "geoip",
        };
    } catch (_err) {
        return EUROPE_FALLBACK;
    }
}

// Express's `trust proxy` should hand us `req.ip` already resolved from
// X-Forwarded-For, but we're behind Cloudflare → Hostinger so prefer the
// CF header if present (Cloudflare strips spoofed copies).
function pickClientIp(req) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    if (req.ip) return req.ip;
    return null;
}

module.exports = { getDefaultMapView };
