// Resolve a free-form Google Maps URL into structured coords + country.
//
// Powers the /add-your-spot chatbot intake (2026-05-18). The user pastes
// any of the common GMaps URL shapes — desktop /maps/place/, mobile
// short-link maps.app.goo.gl/, or even just text query strings — and we
// return { lat, lng, country, formattedAddress } good enough to write a
// Place row. The full enrichment pipeline runs afterwards and overwrites
// these fields with canonical Google Places data once the cron tick
// reaches the new row.
//
// Resolution strategy (first hit wins):
//   1. Parse lat/lng directly from the URL (handles @LAT,LNG, !3d!4d,
//      q=LAT,LNG, ll=LAT,LNG)
//   2. If it's a short link, follow redirects up to 3 hops and retry #1
//   3. Reverse-geocode the resulting coords for ISO country + address
//
// Returns null on every failure path. Caller decides whether to fall
// back to manual moderation.

const https = require("https");
const { URL } = require("url");

const SHORT_HOSTS = new Set([
    "maps.app.goo.gl",
    "goo.gl",
    "g.co",
    "maps.app",
]);

const COORD_RE = /-?\d+(?:\.\d+)?/;
const LAT_LNG_PAIR = new RegExp(`(${COORD_RE.source}),\\s*(${COORD_RE.source})`);

function isProbableCoord(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < -90 || lat > 90) return false;
    if (lng < -180 || lng > 180) return false;
    // 0,0 is "the Atlantic" and almost certainly a parser artifact.
    if (lat === 0 && lng === 0) return false;
    return true;
}

// Parse coords out of any of the URL shapes Google Maps emits.
function parseCoordsFromUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    const url = rawUrl.trim();

    // /@LAT,LNG,ZOOMz   — desktop /maps/place/foo/@40.7,-74.0,15z
    let m = url.match(/[@/](-?\d+\.\d+),(-?\d+\.\d+)(?:,\d+(?:\.\d+)?z)?/);
    if (m) {
        const lat = Number(m[1]); const lng = Number(m[2]);
        if (isProbableCoord(lat, lng)) return { lat, lng, source: "at-pin" };
    }

    // !3dLAT!4dLNG      — the post-redirect canonical place form
    const lat3 = url.match(/!3d(-?\d+\.\d+)/);
    const lng4 = url.match(/!4d(-?\d+\.\d+)/);
    if (lat3 && lng4) {
        const lat = Number(lat3[1]); const lng = Number(lng4[1]);
        if (isProbableCoord(lat, lng)) return { lat, lng, source: "3d4d" };
    }

    // query params: ?q=LAT,LNG   ?ll=LAT,LNG   ?query=LAT,LNG
    try {
        const u = new URL(url);
        for (const key of ["q", "ll", "query", "destination"]) {
            const v = u.searchParams.get(key);
            if (!v) continue;
            const pair = v.match(LAT_LNG_PAIR);
            if (!pair) continue;
            const lat = Number(pair[1]); const lng = Number(pair[2]);
            if (isProbableCoord(lat, lng)) return { lat, lng, source: `param-${key}` };
        }
    } catch (_) { /* not a parseable URL, fall through */ }

    return null;
}

function isShortLink(rawUrl) {
    try {
        const u = new URL(rawUrl.trim());
        return SHORT_HOSTS.has(u.hostname);
    } catch (_) {
        return false;
    }
}

// HEAD-follow short links to their canonical form. We use https.request
// instead of fetch() so we can inspect each hop's Location header
// without auto-decoding the body — short links sometimes return a 302
// with no body at all.
function followRedirect(url, hopsLeft = 3) {
    return new Promise((resolve, reject) => {
        if (hopsLeft <= 0) return resolve(url);
        let target;
        try { target = new URL(url); } catch (e) { return reject(e); }

        const req = https.request({
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: "GET",
            headers: {
                // Google's short-link service emits the redirect only
                // when it thinks you're a real browser.
                "User-Agent": "Mozilla/5.0 (compatible; OpenPizzaMap/1.0)",
                "Accept": "text/html,*/*;q=0.8",
            },
            timeout: 8000,
        }, (res) => {
            const status = res.statusCode || 0;
            const loc = res.headers && res.headers.location;
            // Drain body so the socket can be reused / closed cleanly.
            res.resume();
            if (status >= 300 && status < 400 && loc) {
                const next = new URL(loc, url).toString();
                followRedirect(next, hopsLeft - 1).then(resolve, reject);
            } else {
                resolve(url);
            }
        });
        req.on("timeout", () => req.destroy(new Error("redirect-timeout")));
        req.on("error", reject);
        req.end();
    });
}

// Reverse-geocode coords via the classic Geocoding API. Returns an
// object with `country` (ISO2 — Place schema stores ISO2 for new rows
// even though legacy rows have full names) and `formattedAddress`.
async function reverseGeocode(lat, lng, apiKey) {
    if (!apiKey) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
        res = await fetch(url);
    } catch (err) {
        return null;
    }
    if (!res.ok) return null;
    let json;
    try { json = await res.json(); } catch { return null; }
    if (json.status !== "OK" || !Array.isArray(json.results) || !json.results.length) return null;

    // Prefer the first "street_address" / "premise" result for a usable
    // formatted address, fall back to results[0]. Country code comes
    // from address_components on any result — they share it.
    const primary = json.results.find((r) =>
        Array.isArray(r.types) && (r.types.includes("street_address") || r.types.includes("premise") || r.types.includes("establishment"))
    ) || json.results[0];

    let country = null;
    for (const r of json.results) {
        const comps = r.address_components || [];
        const c = comps.find((x) => Array.isArray(x.types) && x.types.includes("country"));
        if (c && c.short_name) { country = String(c.short_name).toUpperCase(); break; }
    }

    return {
        country: country || null,
        formattedAddress: primary.formattedAddress || primary.formatted_address || null,
    };
}

async function resolveGmapsLink(rawUrl, { apiKey } = {}) {
    if (!rawUrl) return null;
    // 1. Try parsing the raw URL.
    let coords = parseCoordsFromUrl(rawUrl);
    let expandedUrl = rawUrl;

    // 2. Expand short links and retry.
    if (!coords && isShortLink(rawUrl)) {
        try {
            expandedUrl = await followRedirect(rawUrl, 3);
            coords = parseCoordsFromUrl(expandedUrl);
        } catch (_) { /* leave coords null */ }
    }

    if (!coords) return null;

    // 3. Reverse-geocode for country + address. Optional — if the
    // Geocoding API is unavailable we still return coords and let the
    // caller decide.
    let country = null;
    let formattedAddress = null;
    if (apiKey) {
        const geo = await reverseGeocode(coords.lat, coords.lng, apiKey);
        if (geo) { country = geo.country; formattedAddress = geo.formattedAddress; }
    }

    return {
        lat: coords.lat,
        lng: coords.lng,
        country,
        formattedAddress,
        expandedUrl,
        source: coords.source,
    };
}

// Classify a user-pasted URL so finalize-spot knows whether to feed it
// into the gmaps fast-path, treat it as the spot's website, file it as
// a social handle, or discard it. The user may paste ANYTHING — their
// Maps share link, the pizzeria's homepage, a TripAdvisor URL, an
// Instagram handle, a news article. We accept all of it.
//
// Returns one of:
//   { kind: "gmaps",     url } — Google Maps URL (any of the parsed shapes)
//   { kind: "instagram", url } — instagram.com / instagr.am / ig.me
//   { kind: "facebook",  url } — facebook.com / fb.com / m.facebook.com
//   { kind: "thirdparty",url, host } — TripAdvisor / Yelp / Foursquare / etc
//   { kind: "website",   url } — anything else http(s) — likely the spot's own site
//   null                      — not a parseable URL
//
// `url` is the cleaned, https-normalized version (we don't follow redirects
// here — that's `resolveGmapsLink`'s job for gmaps specifically).
const GMAPS_HOSTS = new Set([
    "maps.google.com",
    "www.google.com",       // www.google.com/maps/place/...
    "google.com",
    "maps.app.goo.gl",
    "goo.gl",
    "g.co",
    "maps.app",
]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "instagr.am", "ig.me"]);
const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "fb.com", "fb.me"]);
// Known third-party review/aggregator platforms. Worth saving the URL
// in the audit-trail payload but NOT writing to Place — the existing
// scrapers/enrichers own those fields.
const THIRDPARTY_HOSTS = new Set([
    "tripadvisor.com", "tripadvisor.it", "tripadvisor.es", "tripadvisor.fr", "tripadvisor.co.uk", "www.tripadvisor.com", "www.tripadvisor.it", "www.tripadvisor.es", "www.tripadvisor.fr", "www.tripadvisor.co.uk",
    "yelp.com", "www.yelp.com", "yelp.es", "yelp.it",
    "foursquare.com", "www.foursquare.com",
    "thefork.com", "www.thefork.com", "thefork.es", "thefork.it",
    "opentable.com", "www.opentable.com",
    "twitter.com", "x.com",
    "tiktok.com", "www.tiktok.com",
    "youtube.com", "youtu.be", "www.youtube.com",
    "reddit.com", "www.reddit.com",
]);

function classifyUserUrl(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Tolerate missing scheme — common when users paste a domain.
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let u;
    try { u = new URL(withScheme); }
    catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;

    const host = u.hostname.toLowerCase();

    // Google Maps URLs — by host OR by path (some shapes use a non-maps host).
    if (GMAPS_HOSTS.has(host)) {
        // Tighten: only google.com when path starts with /maps. Plain
        // google.com search URLs aren't usable here.
        if ((host === "google.com" || host === "www.google.com") && !u.pathname.toLowerCase().startsWith("/maps")) {
            return { kind: "website", url: withScheme }; // unlikely but safe fallback
        }
        return { kind: "gmaps", url: withScheme };
    }
    if (INSTAGRAM_HOSTS.has(host)) return { kind: "instagram", url: withScheme };
    if (FACEBOOK_HOSTS.has(host))  return { kind: "facebook",  url: withScheme };
    if (THIRDPARTY_HOSTS.has(host)) return { kind: "thirdparty", url: withScheme, host };
    return { kind: "website", url: withScheme };
}

module.exports = {
    resolveGmapsLink,
    parseCoordsFromUrl,
    isShortLink,
    followRedirect,
    reverseGeocode,
    classifyUserUrl,
};
