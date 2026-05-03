const test = require("node:test");
const assert = require("node:assert/strict");
const {
    computeOpmRating,
    reviewAvg5,
    PRIOR_MEAN,
} = require("../src/services/opm-rating");

// Approximate equality for floating-point assertions. The bayesian
// formula sometimes lands at e.g. 7.0000000004 even after rounding, so
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
    // 200 reviews × 4.5★ → effective 100 reviews (cap), weighted at 9.0/10.
    // Numerator: 10*7 + 100*9.0 = 970. Denominator: 110. → 8.818...
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 200 },
        []
    );
    approx(out, 8.82);
});

test("only externals — small Google count pulls toward prior", () => {
    // 5 reviews × 4.0★ = 8.0/10 weighted by 5. Numerator: 70+40=110.
    // Denominator 15. → 7.333...
    const out = computeOpmRating(
        { googleRating: 4.0, googleReviewCount: 5 },
        []
    );
    approx(out, 7.33);
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
    // Google 4.5/100 + TA 4.0/50: weights cap at 100 + 50 = 150
    // values: 9.0 and 8.0. Numerator: 70 + 100*9 + 50*8 = 1370.
    // Denominator: 10 + 100 + 50 = 160. → 8.5625 → 8.56
    const out = computeOpmRating(
        {
            googleRating: 4.5, googleReviewCount: 200,
            tripadvisorRating: 4.0, tripadvisorReviewCount: 50,
        },
        []
    );
    approx(out, 8.56);
});

test("only OPM reviews — single mid-tier review pulls toward prior", () => {
    // One review: pizza=4, local=4, servicio=4, precio=4 → avg 4 → 8/10
    // weight 1.25. Numerator: 70 + 1.25*8 = 80. Denom: 11.25. → 7.111
    const out = computeOpmRating({}, [
        { pizza: 4, local: 4, servicio: 4, precio: 4 },
    ]);
    approx(out, 7.11);
});

test("mixed externals + OPM", () => {
    // Google 4.5/200 (capped 100) → value 9.0, weight 100
    // OPM review 5/5/5/5 → avg 5 → value 10, weight 1.25
    // Numerator: 70 + 100*9 + 1.25*10 = 982.5. Denom: 111.25. → 8.831...
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 200 },
        [{ pizza: 5, local: 5, servicio: 5, precio: 5 }]
    );
    approx(out, 8.83);
});

test("Il Figlio worked example — Google 4.7/300 baseline", () => {
    // Sanity-check the algorithm against a hand-worked case roughly mirroring
    // a popular spot. Google 4.7★/300 reviews (capped to 100):
    //   value 9.4, weight 100
    //   numerator: 10*7 + 100*9.4 = 1010
    //   denominator: 110 → 9.181...
    const baseline = computeOpmRating(
        { googleRating: 4.7, googleReviewCount: 300 },
        []
    );
    approx(baseline, 9.18);

    // Add Eric's review: pizza 4.5, local 3.5, servicio 3.5, precio 4.0
    // (avg 3.875 /5 → 7.75 /10, weight 1.25)
    //   numerator: 1010 + 1.25*7.75 = 1019.6875
    //   denominator: 110 + 1.25 = 111.25 → 9.166...
    const withReview = computeOpmRating(
        { googleRating: 4.7, googleReviewCount: 300 },
        [{ pizza: 4.5, local: 3.5, servicio: 3.5, precio: 4.0 }]
    );
    approx(withReview, 9.17);

    // The single OPM review nudges the score down slightly (because 7.75 < 9.4),
    // exactly the dampening we want from a low-confidence community signal.
    assert.ok(withReview < baseline, "single mid review should pull score down from a high external");
});

test("custom priorMean overrides default", () => {
    const out = computeOpmRating({}, [
        { pizza: 4, local: 4, servicio: 4, precio: 4 },
    ], 8);
    // Numerator: 10*8 + 1.25*8 = 90. Denom: 11.25. → 8.0
    approx(out, 8.0);
});

test("ignores zero-count external entries", () => {
    // googleReviewCount = 0 should be treated as no contribution.
    const out = computeOpmRating(
        { googleRating: 4.5, googleReviewCount: 0,
          tripadvisorRating: 4.0, tripadvisorReviewCount: 50 },
        []
    );
    // Should equal "only TA 4.0/50" — Numerator: 70 + 50*8 = 470. Denom: 60. → 7.833
    approx(out, 7.83);
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
    assert.ok(PRIOR_MEAN >= 5 && PRIOR_MEAN <= 9, "prior mean should be a plausible /10 score");
});
