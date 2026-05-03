const test = require("node:test");
const assert = require("node:assert/strict");
const {
    computeOpmRating,
    reviewAvg5,
    PRIOR_MEAN,
} = require("../src/services/opm-rating");

// Approximate equality for floating-point assertions. The bayesian
// formula sometimes lands at e.g. 3.5000000004 even after rounding, so
// give callers a modest epsilon.
function approx(actual, expected, eps = 0.011) {
    if (Math.abs(actual - expected) > eps) {
        assert.fail(`expected ${expected} (±${eps}), got ${actual}`);
    }
}

test("no reviews + no externals → null (no data, don't show prior as earned)", () => {
    const out = computeOpmRating({}, []);
    assert.equal(out, null);
});

test("only externals — single Google source under cap", () => {
    // 200 reviews × 4.5★ → effective 100 reviews (cap), weighted at 4.5.
    // Numerator: 10*3.5 + 100*4.5 = 485. Denominator: 110. → 4.409...
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 200 },
        []
    );
    approx(out, 4.41);
});

test("only externals — small Google count pulls toward prior", () => {
    // 5 reviews × 4.0★ = 4.0 weighted by 5. Numerator: 35+20=55.
    // Denominator 15. → 3.666...
    const out = computeOpmRating(
        { googleRating: 4.0, googleReviewCount: 5 },
        []
    );
    approx(out, 3.67);
});

test("cap is applied per source", () => {
    // 5000 Google reviews — should be capped to 100 effective.
    const big = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 5000 },
        []
    );
    const capped = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 100 },
        []
    );
    approx(big, capped, 0.001);
});

test("multiple external sources stack", () => {
    // Google 4.5/100 + TA 4.0/50: weights cap at 100 + 50 = 150.
    // Numerator: 35 + 100*4.5 + 50*4.0 = 685. Denominator: 10+100+50=160.
    // → 4.281... → 4.28
    const out = computeOpmRating(
        {
            googleRating: 4.5, googleReviewCount: 200,
            tripadvisorRating: 4.0, tripadvisorReviewCount: 50,
        },
        []
    );
    approx(out, 4.28);
});

test("only OPM reviews — single mid-tier review pulls toward prior", () => {
    // One review: pizza=4, local=4, servicio=4, precio=4 → avg 4
    // weight 1.25. Numerator: 35 + 1.25*4 = 40. Denom: 11.25. → 3.555...
    const out = computeOpmRating({}, [
        { pizza: 4, local: 4, servicio: 4, precio: 4 },
    ]);
    approx(out, 3.56);
});

test("mixed externals + OPM", () => {
    // Google 4.5/200 (capped 100) → value 4.5, weight 100
    // OPM review 5/5/5/5 → avg 5 → value 5, weight 1.25
    // Numerator: 35 + 100*4.5 + 1.25*5 = 491.25. Denom: 111.25. → 4.415...
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 200 },
        [{ pizza: 5, local: 5, servicio: 5, precio: 5 }]
    );
    approx(out, 4.42);
});

test("Il Figlio worked example — Google 4.7/300 baseline", () => {
    // Sanity-check the algorithm against a hand-worked case roughly mirroring
    // a popular spot. Google 4.7★/300 reviews (capped to 100):
    //   value 4.7, weight 100
    //   numerator: 10*3.5 + 100*4.7 = 505
    //   denominator: 110 → 4.590...
    const baseline = computeOpmRating(
        { googleRating: 4.7, googleReviewCount: 300 },
        []
    );
    approx(baseline, 4.59);

    // Add Eric's review: pizza 4.5, local 3.5, servicio 3.5, precio 4.0
    // (avg 3.875, weight 1.25)
    //   numerator: 505 + 1.25*3.875 = 509.84375
    //   denominator: 110 + 1.25 = 111.25 → 4.582...
    const withReview = computeOpmRating(
        { googleRating: 4.7, googleReviewCount: 300 },
        [{ pizza: 4.5, local: 3.5, servicio: 3.5, precio: 4.0 }]
    );
    approx(withReview, 4.58);

    // The single OPM review nudges the score down slightly (because 3.875 < 4.7),
    // exactly the dampening we want from a low-confidence community signal.
    assert.ok(withReview < baseline, "single mid review should pull score down from a high external");
});

test("custom priorMean overrides default", () => {
    const out = computeOpmRating({}, [
        { pizza: 4, local: 4, servicio: 4, precio: 4 },
    ], 4);
    // Numerator: 10*4 + 1.25*4 = 45. Denom: 11.25. → 4.0
    approx(out, 4.0);
});

test("ignores zero-count external entries", () => {
    // googleReviewCount = 0 should be treated as no contribution.
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 0,
          tripadvisorRating: 4.0, tripadvisorReviewCount: 50 },
        []
    );
    // Should equal "only TA 4.0/50" — Numerator: 35 + 50*4 = 235.
    // Denom: 60. → 3.916...
    approx(out, 3.92);
});

test("ignores null external rating with valid count", () => {
    // Defensive: schema allows count without rating (shouldn't happen but).
    const out = computeOpmRating(
        { googleRating: null, googleReviewCount: 100 },
        []
    );
    assert.equal(out, null);
});

test("reviewAvg5 simple average", () => {
    assert.equal(reviewAvg5({ pizza: 5, local: 4, servicio: 3, precio: 2 }), 3.5);
    assert.equal(reviewAvg5({ pizza: 0, local: 0, servicio: 0, precio: 0 }), 0);
    assert.equal(reviewAvg5({ pizza: 5, local: 5, servicio: 5, precio: 5 }), 5);
});

test("PRIOR_MEAN exported sane", () => {
    assert.ok(PRIOR_MEAN >= 2.5 && PRIOR_MEAN <= 4.5, "prior mean should be a plausible /5 score");
});
