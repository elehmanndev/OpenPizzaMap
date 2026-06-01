// Central SEO context builder (SEO roadmap Phase 1).
//
// One job: turn a fully-loaded `place` row into the head-tag + JSON-LD blob
// that layout.ejs consumes. No per-place manual work, no synchronous LLM —
// everything here is derived from existing DB fields at render time
// (governing principle §0 of docs/roadmap-seo-goto-where-learnings.md).
//
// Returns: { title, description, canonicalUrl, ogImage, ogType, robots, jsonLd }
//   - title:        concise, NO brand suffix (layout.ejs appends "| OpenPizzaMap")
//   - jsonLd:       array of plain objects; layout JSON.stringify's each into a
//                   <script type="application/ld+json"> block
//
// Deliberately deferred to a later phase (documented so the gap is explicit):
//   - OpeningHoursSpecification — Place.openingHours is localized prose
//     ("viernes: 10:00–21:00; ..."), not structured. Parsing it across 6
//     languages reliably is its own task; emitting malformed hours is worse
//     than emitting none.
//   - AggregateRating fallback to opmRating — opmRating's scale is ambiguous
//     (/10 per the roadmap, but stored values look /5). We only emit a rating
//     when googleRating is present, since that's unambiguously /5. Conservative
//     on purpose: a wrong rating in a rich snippet is a trust/ToS problem.

const DEFAULT_BASE_URL = (process.env.BASE_URL || "https://openpizzamap.com").replace(/\/+$/, "");

function clean(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function stripHtml(s) {
    return clean(String(s == null ? "" : s).replace(/<[^>]*>/g, " "));
}

// Trim to a max length on a word boundary, append an ellipsis if cut.
function truncate(s, n) {
    s = clean(s);
    if (s.length <= n) return s;
    return s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
}

// Resolve a possibly-relative asset path ("/uploads/...") to an absolute URL.
// Pass-through for already-absolute URLs. Null/empty → null.
function absUrl(u, baseUrl) {
    if (!u || typeof u !== "string") return null;
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    return base + (u.startsWith("/") ? u : "/" + u);
}

// First tagged style's human label, if any.
function styleLabel(place) {
    const styles = Array.isArray(place.styles) ? place.styles : [];
    const first = styles[0] && styles[0].style;
    if (!first) return "";
    return clean(first.shortLabel || first.name || "");
}

function buildPlaceSeo(place, opts = {}) {
    const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const name = clean(place.name);
    const city = clean(place.city);
    const country = clean(place.country);
    const label = styleLabel(place);
    const gRating = place.googleRating != null ? Number(place.googleRating) : null;
    const gCount = place.googleReviewCount != null ? Number(place.googleReviewCount) : null;

    // --- Title (decision #4, length-trimmed) ---------------------------------
    // {name} — {style} pizzeria in {city}, {country}. Rating lives in the
    // AggregateRating rich snippet (the real CTR lever) rather than the <title>,
    // which we keep short enough to avoid SERP truncation.
    const where = [city, country].filter(Boolean).join(", ");
    const title = where
        ? `${name} — ${label ? label + " " : ""}pizzeria in ${where}`
        : name;

    // --- Meta description (decision #5) --------------------------------------
    const descParts = [];
    const addr = clean(place.addressLine);
    descParts.push(name + (addr ? `, ${addr}` : (city ? `, ${city}` : "")) + ".");
    if (label) descParts.push(`${label} pizza.`);
    if (gRating != null && gCount) descParts.push(`${gRating}★ from ${gCount} Google reviews.`);
    descParts.push("Hours, photos, directions and reviews on OpenPizzaMap.");
    const description = truncate(descParts.join(" "), 160);

    // --- Canonical (slug routing is already live) ----------------------------
    const canonicalUrl = place.slug
        ? `${baseUrl}/place/${place.id}/${place.slug}`
        : `${baseUrl}/place/${place.id}`;

    // --- OG image: first gallery photo, else legacy hero --------------------
    const gallery = Array.isArray(place.images) ? place.images : [];
    const heroRaw = gallery.length ? gallery[0].localPath : place.heroImageUrl;
    const ogImage = absUrl(heroRaw, baseUrl);

    // --- JSON-LD -------------------------------------------------------------
    const jsonLd = [];

    const restaurant = {
        "@context": "https://schema.org",
        "@type": "Restaurant",
        name,
        url: canonicalUrl,
        servesCuisine: "Pizza",
    };
    if (addr || city || country) {
        const address = { "@type": "PostalAddress" };
        if (addr) address.streetAddress = addr;
        if (city) address.addressLocality = city;
        if (clean(place.region)) address.addressRegion = clean(place.region);
        if (clean(place.postalCode)) address.postalCode = clean(place.postalCode);
        if (country) address.addressCountry = country;
        restaurant.address = address;
    }
    if (place.lat != null && place.lng != null) {
        const lat = Number(place.lat);
        const lng = Number(place.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            restaurant.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lng };
        }
    }
    if (clean(place.phone)) restaurant.telephone = clean(place.phone);
    if (clean(place.websiteUrl)) restaurant.sameAs = [clean(place.websiteUrl)];
    if (ogImage) restaurant.image = ogImage;
    if (place.priceLevel) {
        const lvl = Math.max(1, Math.min(4, Number(place.priceLevel)));
        if (Number.isFinite(lvl)) restaurant.priceRange = "$".repeat(lvl);
    }
    if (gRating != null && gCount != null && gCount > 0) {
        restaurant.aggregateRating = {
            "@type": "AggregateRating",
            ratingValue: gRating,
            reviewCount: gCount,
            bestRating: 5,
            worstRating: 1,
        };
    }
    jsonLd.push(restaurant);

    // BreadcrumbList: Home › Country › City › Place. City/country levels only
    // when cityRef carries the country code (the /country/:code routing key).
    const cc = place.cityRef && place.cityRef.countryCode
        ? String(place.cityRef.countryCode).toUpperCase()
        : null;
    const crumbs = [{ name: "OpenPizzaMap", url: baseUrl + "/" }];
    if (country && cc) crumbs.push({ name: country, url: `${baseUrl}/country/${cc}` });
    if (city && cc && place.cityRef.slug) {
        crumbs.push({ name: city, url: `${baseUrl}/country/${cc}/city/${place.cityRef.slug}` });
    }
    crumbs.push({ name, url: canonicalUrl });
    jsonLd.push({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.name,
            item: c.url,
        })),
    });

    // FAQPage: only place-scoped, visible FAQs (already filtered by the route).
    const faqs = Array.isArray(place.faqs)
        ? place.faqs.filter((f) => f && clean(f.question) && stripHtml(f.answerHtml))
        : [];
    if (faqs.length) {
        jsonLd.push({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqs.map((f) => ({
                "@type": "Question",
                name: clean(f.question),
                acceptedAnswer: { "@type": "Answer", text: stripHtml(f.answerHtml) },
            })),
        });
    }

    // Keep not-yet-public rows (creator-bypass view of isVisible=false spots)
    // out of the index even if a crawler somehow reaches them.
    const robots = place.isVisible === false ? "noindex, nofollow" : undefined;

    return { title, description, canonicalUrl, ogImage, ogType: "website", robots, jsonLd };
}

module.exports = { buildPlaceSeo, absUrl };
