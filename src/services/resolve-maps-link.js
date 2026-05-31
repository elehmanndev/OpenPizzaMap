// Resolve a Google Maps link to coordinates + place id (+ address).
//
// Shared by the admin place-edit save (src/routes/pages.admin.js) and the
// opm-runner enrichment scripts, so a pasted Maps URL becomes structured
// location data in one place.
//
// Accepts:
//   - short links:  https://maps.app.goo.gl/XXXX  (resolved via redirect)
//   - full links:   https://www.google.com/maps/place/Name/@41.92,12.50,17z/data=...!3d41.92!4d12.50...!1s0x..:0x..
//
// Returns { lat, lng, placeId, address } — any field may be null if it
// couldn't be extracted. Returns null if the input isn't a Google Maps URL.
// Best-effort + time-boxed: never throws; on any failure returns what it has.

const https = require("https");

function isMapsUrl(u) {
    return /(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl|maps\.google\.[a-z.]+|goo\.gl\/maps)/i.test(u || "");
}

// Follow redirects manually (so we don't need fetch) up to a few hops,
// time-boxed. Resolves to the final URL string.
function resolveRedirect(url, { timeoutMs = 6000, maxHops = 5 } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const hop = (current, hops) => {
            if (hops > maxHops) return finish(current);
            let u;
            try { u = new URL(current); } catch { return finish(current); }
            const req = https.request(
                { method: "GET", hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "OpenPizzaMap/1.0" } },
                (res) => {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                        res.resume();
                        const next = new URL(res.headers.location, current).toString();
                        hop(next, hops + 1);
                    } else {
                        // Not a redirect — the current URL is final. Drain + return.
                        res.resume();
                        finish(current);
                    }
                }
            );
            req.on("error", () => finish(current));
            req.setTimeout(timeoutMs, () => { req.destroy(); finish(current); });
            req.end();
        };
        hop(url, 0);
    });
}

function parseLatLng(finalUrl) {
    // Prefer the !3d<lat>!4d<lng> data block (the pin), fall back to @lat,lng.
    let m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(finalUrl);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    m = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(finalUrl);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    return { lat: null, lng: null };
}

function parsePlaceId(finalUrl) {
    // FTID hex pair from the !1s segment.
    const ftid = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(finalUrl);
    if (ftid) return ftid[1];
    // ChIJ-style id if present.
    const chij = /!1s(ChIJ[\w-]+)/.exec(finalUrl);
    if (chij) return chij[1];
    return null;
}

// Reverse-geocode coords to a street address via Nominatim (free, polite).
function reverseGeocode(lat, lng, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
        const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=0`;
        const req = https.request(
            new URL(u),
            { headers: { "User-Agent": "OpenPizzaMap-resolve/1.0 (admin@openpizzamap.com)" } },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    try {
                        const j = JSON.parse(data);
                        resolve(j && j.display_name ? String(j.display_name) : null);
                    } catch { resolve(null); }
                });
            }
        );
        req.on("error", () => resolve(null));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function resolveMapsLink(url, { reverseGeocodeAddress = true } = {}) {
    if (!isMapsUrl(url)) return null;
    try {
        const finalUrl = await resolveRedirect(url);
        const { lat, lng } = parseLatLng(finalUrl);
        const placeId = parsePlaceId(finalUrl);
        let address = null;
        if (reverseGeocodeAddress && lat != null && lng != null) {
            address = await reverseGeocode(lat, lng);
        }
        return { lat, lng, placeId, address, finalUrl };
    } catch {
        return { lat: null, lng: null, placeId: null, address: null };
    }
}

module.exports = { resolveMapsLink, isMapsUrl };
