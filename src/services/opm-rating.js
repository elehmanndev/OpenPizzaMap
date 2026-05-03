// Bayesian aggregation of OPM community reviews + external aggregator
// signals (Google, TripAdvisor, Yelp) into a single 0–5 score that
// matches the scale every external star rating already publishes — no
// mental /10 → /5 conversion when reading the place page.
//
// Why bayesian: external rating averages with low review counts (and OPM
// reviews when we only have one or two) overshoot in both directions —
// a single 5★ Google review on its own would pin the raw mean to a
// perfect 5.0, which is misleading. The bayesian blend pulls every place
// toward a global prior unless it's accumulated enough evidence to
// deserve to escape it.
//
// Inputs:
//   place: { googleRating, googleReviewCount,
//            tripadvisorRating, tripadvisorReviewCount,
//            yelpRating, yelpReviewCount }    (all values in /5)
//   opmReviews: array of { pizza, local, servicio, precio }  (each /5)
//   priorMean (optional): the global /5 prior (default PRIOR_MEAN)
//
// Output: number in [0, 5] rounded to 2 decimals, or null if there are
// zero contributions (place has no reviews from any source — better to
// surface the absence than to display the prior as if it were earned).

const PRIOR_WEIGHT = 10;
// PRIOR_MEAN is on the same 0–5 scale as everything else now. 3.5 is the
// "decent but not great" centre we want unanchored places to drift toward.
const PRIOR_MEAN = 3.5;
const CAP_PER_EXTERNAL_SOURCE = 100;
const OPM_REVIEW_WEIGHT = 1.25;

const EXTERNAL_SOURCES = [
    { ratingField: "googleRating", countField: "googleReviewCount" },
    { ratingField: "tripadvisorRating", countField: "tripadvisorReviewCount" },
    { ratingField: "yelpRating", countField: "yelpReviewCount" },
];

function reviewAvg5(r) {
    return (r.pizza + r.local + r.servicio + r.precio) / 4;
}

function computeOpmRating(place, opmReviews, priorMean = PRIOR_MEAN) {
    const contributions = [];

    // OPM reviews: avg of the four 0–5 categories, weighted at 1.25 (slight
    // community boost vs. a single external review, but well below cap=100
    // so the first OPM review can't dominate a popular place).
    for (const r of opmReviews || []) {
        contributions.push({ value: reviewAvg5(r), weight: OPM_REVIEW_WEIGHT });
    }

    // External aggregators: each source contributes one entry, weighted
    // by min(reviewCount, CAP). Cap prevents a 5000-review Google place
    // from completely overriding the prior; small-N sources pull less.
    // All sources publish on a 0–5 star scale already, so no rescale.
    for (const src of EXTERNAL_SOURCES) {
        const rating = place ? place[src.ratingField] : null;
        const count = place ? place[src.countField] : null;
        if (rating == null || count == null) continue;
        const ratingNum = Number(rating);
        const countNum = Number(count);
        if (!Number.isFinite(ratingNum) || !Number.isFinite(countNum) || countNum <= 0) continue;
        const effectiveCount = Math.min(countNum, CAP_PER_EXTERNAL_SOURCE);
        contributions.push({ value: ratingNum, weight: effectiveCount });
    }

    if (!contributions.length) return null;

    // Bayesian: shift the average toward priorMean by PRIOR_WEIGHT
    // pseudo-observations.
    let totalWeight = PRIOR_WEIGHT;
    let weightedSum = PRIOR_WEIGHT * priorMean;
    for (const c of contributions) {
        totalWeight += c.weight;
        weightedSum += c.weight * c.value;
    }
    const raw = weightedSum / totalWeight;
    return Math.round(raw * 100) / 100;
}

// ---------- DB-aware helpers (kept here so the route layer doesn't have
// to know about the bayesian internals — but `computeOpmRating` itself
// stays pure and unit-testable without a Prisma instance) ----------

const PRIOR_MEAN_TTL_MS = 60 * 60 * 1000; // 1 h
let cachedPriorMean = null;
let priorMeanCachedAt = 0;

// Recompute the dataset-wide priorMean from every external aggregator
// signal in the Place table, count-weighted with the same cap as the
// per-place algorithm. Cached for an hour: a single review submit
// shouldn't trigger a full table scan.
async function getPriorMean(prisma) {
    if (cachedPriorMean != null && Date.now() - priorMeanCachedAt < PRIOR_MEAN_TTL_MS) {
        return cachedPriorMean;
    }
    const rows = await prisma.place.findMany({
        select: {
            googleRating: true, googleReviewCount: true,
            tripadvisorRating: true, tripadvisorReviewCount: true,
            yelpRating: true, yelpReviewCount: true,
        },
    });
    const pairs = [
        ["googleRating", "googleReviewCount"],
        ["tripadvisorRating", "tripadvisorReviewCount"],
        ["yelpRating", "yelpReviewCount"],
    ];
    let totalWeight = 0, weighted = 0;
    for (const p of rows) {
        for (const [rf, cf] of pairs) {
            const r = p[rf], c = p[cf];
            if (r == null || c == null) continue;
            const rn = Number(r), cn = Number(c);
            if (!Number.isFinite(rn) || !Number.isFinite(cn) || cn <= 0) continue;
            const w = Math.min(cn, CAP_PER_EXTERNAL_SOURCE);
            weighted += rn * w;
            totalWeight += w;
        }
    }
    cachedPriorMean = totalWeight === 0 ? PRIOR_MEAN : Math.round((weighted / totalWeight) * 100) / 100;
    priorMeanCachedAt = Date.now();
    return cachedPriorMean;
}

// Convenience for tests / explicit recomputes.
function clearPriorMeanCache() {
    cachedPriorMean = null;
    priorMeanCachedAt = 0;
}

// Recompute and persist a single place's opmRating after a review
// write. Reads the place + its visible reviews, computes, updates if
// the rounded value actually changed (saves an UPDATE on no-op).
async function recalcPlaceOpmRating(prisma, placeId) {
    const place = await prisma.place.findUnique({
        where: { id: placeId },
        select: {
            id: true, opmRating: true,
            googleRating: true, googleReviewCount: true,
            tripadvisorRating: true, tripadvisorReviewCount: true,
            yelpRating: true, yelpReviewCount: true,
        },
    });
    if (!place) return null;
    const reviews = await prisma.review.findMany({
        where: { placeId, isVisible: true },
        select: { pizza: true, local: true, servicio: true, precio: true },
    });
    const priorMean = await getPriorMean(prisma);
    const next = computeOpmRating(place, reviews, priorMean);
    const stored = place.opmRating == null ? null : Number(place.opmRating);
    const changed = (next == null) !== (stored == null)
        || (next != null && stored != null && Math.abs(next - stored) >= 0.005);
    if (changed) {
        await prisma.place.update({
            where: { id: placeId },
            data: {
                opmRating: next,
                opmRatingSource: next == null
                    ? null
                    : (reviews.length ? "blend" : "external"),
            },
        });
    }
    return next;
}

module.exports = {
    computeOpmRating,
    reviewAvg5,
    getPriorMean,
    clearPriorMeanCache,
    recalcPlaceOpmRating,
    PRIOR_WEIGHT,
    PRIOR_MEAN,
    CAP_PER_EXTERNAL_SOURCE,
    OPM_REVIEW_WEIGHT,
};
