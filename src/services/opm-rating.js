// Bayesian aggregation of OPM community reviews + external aggregator
// signals (Google, TripAdvisor, Yelp) into a single 0–10 score.
//
// Why bayesian: external rating averages with low review counts (and OPM
// reviews when we only have one or two) overshoot in both directions —
// a single 5★ Google review pulls the raw mean to a perfect 10, which
// is misleading. The bayesian blend pulls every place toward a global
// prior unless it's accumulated enough evidence to deserve to escape it.
//
// Inputs:
//   place: { googleRating, googleReviewCount,
//            tripadvisorRating, tripadvisorReviewCount,
//            yelpRating, yelpReviewCount }    (all values in /5)
//   opmReviews: array of { pizza, local, servicio, precio }  (each /5)
//   priorMean (optional): the global /10 prior (default PRIOR_MEAN)
//
// Output: number in [0, 10] rounded to 2 decimals, or null if there are
// zero contributions (place has no reviews from any source — better to
// surface the absence than to display the prior as if it were earned).

const PRIOR_WEIGHT = 10;
const PRIOR_MEAN = 7;
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

    // OPM reviews: rescale 0–5 → 0–10, weight 1.25 each (slight community
    // boost vs. a single external review, but well below cap=100 so the
    // first OPM review can't dominate a popular place).
    for (const r of opmReviews || []) {
        contributions.push({ value: reviewAvg5(r) * 2, weight: OPM_REVIEW_WEIGHT });
    }

    // External aggregators: each source contributes one entry, weighted
    // by min(reviewCount, CAP). Cap prevents a 5000-review Google place
    // from completely overriding the prior; small-N sources pull less.
    for (const src of EXTERNAL_SOURCES) {
        const rating = place ? place[src.ratingField] : null;
        const count = place ? place[src.countField] : null;
        if (rating == null || count == null) continue;
        const ratingNum = Number(rating);
        const countNum = Number(count);
        if (!Number.isFinite(ratingNum) || !Number.isFinite(countNum) || countNum <= 0) continue;
        const value10 = ratingNum * 2;
        const effectiveCount = Math.min(countNum, CAP_PER_EXTERNAL_SOURCE);
        contributions.push({ value: value10, weight: effectiveCount });
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

module.exports = {
    computeOpmRating,
    reviewAvg5,
    PRIOR_WEIGHT,
    PRIOR_MEAN,
    CAP_PER_EXTERNAL_SOURCE,
    OPM_REVIEW_WEIGHT,
};
