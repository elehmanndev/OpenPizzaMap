// EnrichmentProvider interface + concrete adapters.
//
// Spec:
//   findPlace(name, city, country?) → { googlePlaceId, canonicalName,
//     formattedAddress, lat, lng, rating?, ratingCount?, googleMapsUrl?,
//     phone?, websiteUrl?, openingHours? } | null
//
// PlaywrightProvider — wraps scripts/lib/gmaps.js. Free. No googlePlaceId
//   today (the GMaps DOM doesn't expose it on the search/place panel
//   reliably), so the dedup gate falls through to the bbox+name layer for
//   rows resolved this way.
//
// GoogleApiProvider — Places API (New) Text Search + Place Details (Essentials).
//   Returns googlePlaceId. Caps respected via the GCP project's hard
//   quotas (docs/setup-google-maps-api.md); on 429 we throw QuotaExceeded
//   and the orchestrator falls back to PlaywrightProvider.
//
// Both providers share an on-DB cache (EnrichmentCache table) keyed by
// (provider, sha256("name|city|country")). 90-day TTL — long enough that
// a re-import doesn't recharge Google, short enough that closed venues
// drop out within a season.

const crypto = require("crypto");

const CACHE_TTL_DAYS = 90;
const PIPELINE_VERSION = 1;

// ─── Cache helpers ──────────────────────────────────────────────────────────

function queryHash(name, city, country) {
  const key = `${(name || "").trim().toLowerCase()}|${(city || "").trim().toLowerCase()}|${(country || "").trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function readCache(prisma, provider, hash) {
  const row = await prisma.enrichmentCache.findUnique({
    where: { provider_queryHash: { provider, queryHash: hash } },
  });
  if (!row) return null;
  if (row.expiresAt < new Date()) return null;
  try {
    return JSON.parse(row.responseJson);
  } catch {
    return null;
  }
}

async function writeCache(prisma, provider, hash, payload) {
  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 86400 * 1000);
  const responseJson = JSON.stringify(payload);
  await prisma.enrichmentCache.upsert({
    where: { provider_queryHash: { provider, queryHash: hash } },
    update: { responseJson, expiresAt },
    create: { provider, queryHash: hash, responseJson, expiresAt },
  });
}

// ─── PlaywrightProvider ─────────────────────────────────────────────────────

class PlaywrightProvider {
  constructor({ prisma }) {
    this.prisma = prisma;
    this.name = "playwright";
    this._page = null;
    this._browser = null;
  }

  async _ensurePage() {
    if (this._page) return this._page;
    const { createGmapsPage } = require("../../../scripts/lib/gmaps");
    const { browser, page } = await createGmapsPage();
    this._browser = browser;
    this._page = page;
    return this._page;
  }

  async close() {
    if (this._browser) await this._browser.close().catch(() => {});
    this._browser = null;
    this._page = null;
  }

  async findPlace(name, city, country) {
    const hash = queryHash(name, city, country);
    const cached = await readCache(this.prisma, this.name, hash);
    if (cached !== null) return cached.miss ? null : cached;

    const { lookup } = require("../../../scripts/lib/gmaps");
    const page = await this._ensurePage();
    let result = null;
    try {
      result = await lookup(page, name, city);
    } catch (err) {
      // Treat any scrape error as a miss — caller falls back to Nominatim.
      await writeCache(this.prisma, this.name, hash, { miss: true, error: err.message });
      return null;
    }

    if (!result || !result.address) {
      await writeCache(this.prisma, this.name, hash, { miss: true });
      return null;
    }

    const payload = {
      googlePlaceId: null, // Playwright DOM doesn't expose it reliably
      canonicalName: result.title || name,
      formattedAddress: result.address,
      lat: result.lat != null ? Number(result.lat) : null,
      lng: result.lng != null ? Number(result.lng) : null,
      rating: null,
      ratingCount: null,
      googleMapsUrl: null,
      phone: result.phone || null,
      websiteUrl: result.websiteUrl || null,
      openingHours: result.openingHours || null,
    };
    await writeCache(this.prisma, this.name, hash, payload);
    return payload;
  }
}

// ─── GoogleApiProvider ──────────────────────────────────────────────────────

class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededError";
    this.code = "QUOTA_EXCEEDED";
  }
}

class GoogleApiProvider {
  constructor({ prisma, apiKey }) {
    this.prisma = prisma;
    this.name = "google_api";
    this.apiKey = apiKey;
    if (!apiKey) {
      throw new Error("GoogleApiProvider requires GOOGLE_MAPS_API_KEY");
    }
    this.callsMade = 0;
  }

  async close() {
    /* no-op */
  }

  async _post(url, body, fieldMask) {
    const headers = {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": this.apiKey,
    };
    if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    this.callsMade++;
    if (res.status === 429) {
      throw new QuotaExceededError(`Google API quota exceeded (POST ${url})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async _get(url) {
    const res = await fetch(url, {
      headers: { "X-Goog-Api-Key": this.apiKey },
    });
    this.callsMade++;
    if (res.status === 429) {
      throw new QuotaExceededError(`Google API quota exceeded (GET ${url})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // Places API (New) Text Search → returns up to 1 result with the fields
  // we need. FieldMask trims the response (and the bill, since "Essentials"
  // SKU is what we're paying for). See:
  //   https://developers.google.com/maps/documentation/places/web-service/text-search
  async findPlace(name, city, country, { skipCache = false } = {}) {
    const hash = queryHash(name, city, country);
    if (!skipCache) {
      const cached = await readCache(this.prisma, this.name, hash);
      if (cached !== null) return cached.miss ? null : cached;
    }

    const textQuery = [name, city, country].filter(Boolean).join(", ");
    const body = {
      textQuery,
      pageSize: 1,
    };
    const fieldMask = [
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.location",
      "places.rating",
      "places.userRatingCount",
      "places.googleMapsUri",
      "places.nationalPhoneNumber",
      "places.internationalPhoneNumber",
      "places.websiteUri",
      "places.regularOpeningHours.weekdayDescriptions",
      "places.photos",
    ].join(",");

    let json;
    try {
      json = await this._post(
        "https://places.googleapis.com/v1/places:searchText",
        body,
        fieldMask,
      );
    } catch (err) {
      // Don't cache transient errors (network / 5xx / quota). Caller decides.
      throw err;
    }

    this._lastRawResponse = json;

    const place = (json.places || [])[0];
    if (!place) {
      if (!skipCache) await writeCache(this.prisma, this.name, hash, { miss: true });
      return null;
    }

    // Fetch photo URL if the response includes a photo reference.
    // This is a separate Place Photos call (10k free/month).
    let photoUrl = null;
    const photoRef = (place.photos || [])[0];
    if (photoRef && photoRef.name) {
      try {
        const photoJson = await this._get(
          `https://places.googleapis.com/v1/${photoRef.name}/media?maxWidthPx=800&skipHttpRedirect=true`,
        );
        photoUrl = photoJson.photoUri || null;
      } catch {
        // Non-fatal — we still have all other fields
      }
    }

    const payload = {
      googlePlaceId: place.id || null,
      canonicalName: (place.displayName && place.displayName.text) || name,
      formattedAddress: place.formattedAddress || null,
      lat: place.location ? Number(place.location.latitude) : null,
      lng: place.location ? Number(place.location.longitude) : null,
      rating: place.rating != null ? Number(place.rating) : null,
      ratingCount: place.userRatingCount != null ? Number(place.userRatingCount) : null,
      googleMapsUrl: place.googleMapsUri || null,
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || null,
      websiteUrl: place.websiteUri || null,
      openingHours:
        place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions
          ? place.regularOpeningHours.weekdayDescriptions.join("; ")
          : null,
      photoUrl,
    };
    await writeCache(this.prisma, this.name, hash, payload);
    return payload;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

function getProvider({ prisma, override } = {}) {
  const which = (override || process.env.ENRICHMENT_PROVIDER || "playwright").toLowerCase();
  if (which === "google_api") {
    return new GoogleApiProvider({ prisma, apiKey: process.env.GOOGLE_MAPS_API_KEY });
  }
  return new PlaywrightProvider({ prisma });
}

module.exports = {
  getProvider,
  PlaywrightProvider,
  GoogleApiProvider,
  QuotaExceededError,
  PIPELINE_VERSION,
  queryHash,
};
