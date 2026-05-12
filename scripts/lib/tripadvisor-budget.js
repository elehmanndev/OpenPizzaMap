// Persistent TripAdvisor Content API budget tracker.
//
// TA's pricing model (confirmed via their Rate Limits + pricing pages,
// 2026-05-12):
//   - SEARCH endpoints (/location/search, /location/nearby) are FREE.
//     TA has a separate 10,000-calls-per-day cap on these, independent
//     of any paid budget.
//   - DETAIL endpoints (/location/details, /location/photos,
//     /location/reviews) are billed against the 5,000/mo free tier;
//     above that the per-call price tiers kick in.
//
// This tracker therefore caps on DETAIL calls only — search calls are
// counted for visibility but never throw. Per-call caps:
//   - MONTHLY_HARD_CAP = 4000  (= 5000 free tier - 1000 safety margin)
//   - DAILY_SOFT_CAP   = 130   (~30 days × 130 = 3900, fits in monthly)
//
// Counter is stored in scripts/lib/.tripadvisor-budget.json (gitignored).
// Shape (current):
//   {
//     "month": "2026-05",
//     "calls":             total calls this month (search + detail, legacy)
//     "detailCalls":       billed calls this month — the one that matters
//     "searchCalls":       free search calls this month — visibility only
//     "today": "2026-05-12",
//     "todayCalls":        today's total (legacy)
//     "todayDetailCalls":  today's billed calls — the one that gates
//     "todaySearchCalls":  today's free search calls
//   }
//
// Older state files without the *Detail / *Search fields are auto-
// migrated on load() by treating past totals as detail-only — the safer
// direction (over-reports billed usage rather than under-reports).

const fs = require('fs');
const path = require('path');

const BUDGET_FILE = path.join(__dirname, '.tripadvisor-budget.json');
const MONTHLY_HARD_CAP = 4000;
const DAILY_SOFT_CAP = 130;

function ymKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymdKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Search endpoints are free per TA's Rate Limits page. Everything else
// (details / photos / reviews) counts against the 5k/mo quota.
function isBilledCall(label) {
  if (!label) return true; // unknown — be conservative
  return !/\/location\/search\b/i.test(label) && !/\/location\/nearby\b/i.test(label);
}

function freshState() {
  return {
    month: ymKey(),
    calls: 0,
    detailCalls: 0,
    searchCalls: 0,
    today: ymdKey(),
    todayCalls: 0,
    todayDetailCalls: 0,
    todaySearchCalls: 0,
  };
}

function load() {
  if (!fs.existsSync(BUDGET_FILE)) return freshState();
  let obj;
  try { obj = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); }
  catch { return freshState(); }

  // Migration: pre-2026-05-12 state files only had `calls` and
  // `todayCalls`. Treat those legacy totals as if they were all
  // detail calls — the conservative direction (might over-report
  // billed usage, but never under-reports).
  if (obj.detailCalls === undefined) obj.detailCalls = obj.calls || 0;
  if (obj.searchCalls === undefined) obj.searchCalls = 0;
  if (obj.todayDetailCalls === undefined) obj.todayDetailCalls = obj.todayCalls || 0;
  if (obj.todaySearchCalls === undefined) obj.todaySearchCalls = 0;

  // Roll over month boundary.
  if (obj.month !== ymKey()) {
    obj.month = ymKey();
    obj.calls = 0;
    obj.detailCalls = 0;
    obj.searchCalls = 0;
  }
  // Roll over day boundary.
  if (obj.today !== ymdKey()) {
    obj.today = ymdKey();
    obj.todayCalls = 0;
    obj.todayDetailCalls = 0;
    obj.todaySearchCalls = 0;
  }
  return obj;
}

function save(state) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(state, null, 2));
}

// Reserve a slot for a single TA HTTP call. Caps only fire when the
// call is billed (detail/photos/reviews). Search calls are counted but
// never throw — see comment block at top of file.
// Call this BEFORE every TripAdvisor HTTP request.
function reserve(label = 'tripadvisor-call') {
  const s = load();
  const billed = isBilledCall(label);

  if (billed) {
    if (s.detailCalls >= MONTHLY_HARD_CAP) {
      throw new Error(`tripadvisor-budget: monthly cap reached (${s.detailCalls}/${MONTHLY_HARD_CAP} billed calls for ${s.month})`);
    }
    if (s.todayDetailCalls >= DAILY_SOFT_CAP) {
      throw new Error(`tripadvisor-budget: daily cap reached (${s.todayDetailCalls}/${DAILY_SOFT_CAP} billed calls for ${s.today}). Override only if you accept the burn rate.`);
    }
  }

  s.calls += 1;
  s.todayCalls += 1;
  if (billed) {
    s.detailCalls += 1;
    s.todayDetailCalls += 1;
  } else {
    s.searchCalls += 1;
    s.todaySearchCalls += 1;
  }
  save(s);
  return { ...s, label, billed };
}

// Read-only — for status reporting / dry-runs that want to see remaining
// quota without spending. Reports detail-call usage prominently (that's
// the cap that matters) plus search-call totals for visibility.
function status() {
  const s = load();
  return {
    month: s.month,
    monthCalls: s.calls,
    monthDetailCalls: s.detailCalls,
    monthSearchCalls: s.searchCalls,
    monthRemaining: Math.max(0, MONTHLY_HARD_CAP - s.detailCalls),
    today: s.today,
    todayCalls: s.todayCalls,
    todayDetailCalls: s.todayDetailCalls,
    todaySearchCalls: s.todaySearchCalls,
    todayRemaining: Math.max(0, DAILY_SOFT_CAP - s.todayDetailCalls),
    monthlyCap: MONTHLY_HARD_CAP,
    dailyCap: DAILY_SOFT_CAP,
  };
}

module.exports = { reserve, status, isBilledCall, MONTHLY_HARD_CAP, DAILY_SOFT_CAP, BUDGET_FILE };
