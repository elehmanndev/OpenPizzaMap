// Persistent TripAdvisor Content API budget tracker.
//
// Free tier is 5000 calls/month. Per spec we cap at 4000/month for safety,
// plus a 130/day soft-cap so a runaway script can't burn the monthly budget
// in one sitting.
//
// Counter is stored in scripts/lib/.tripadvisor-budget.json (gitignored,
// joining .env on the secrets-shaped boundary). Shape:
//
//   {
//     "month": "2026-04",
//     "calls": 412,
//     "today": "2026-04-26",
//     "todayCalls": 27
//   }
//
// Both scrape-venue.js and the future tripadvisor enricher phase share this
// counter — every TA request must call recordCall() before firing.

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

function load() {
  if (!fs.existsSync(BUDGET_FILE)) {
    return { month: ymKey(), calls: 0, today: ymdKey(), todayCalls: 0 };
  }
  try {
    const obj = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    // Roll over month boundary.
    if (obj.month !== ymKey()) { obj.month = ymKey(); obj.calls = 0; }
    // Roll over day boundary.
    if (obj.today !== ymdKey()) { obj.today = ymdKey(); obj.todayCalls = 0; }
    return obj;
  } catch {
    return { month: ymKey(), calls: 0, today: ymdKey(), todayCalls: 0 };
  }
}

function save(state) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(state, null, 2));
}

// Throws if either the daily soft-cap or monthly hard-cap is exhausted.
// Call this BEFORE every TripAdvisor HTTP request. It both reserves a slot
// (incrementing the counter) and persists immediately, so a crashed script
// doesn't double-spend on retry.
function reserve(label = 'tripadvisor-call') {
  const s = load();
  if (s.calls >= MONTHLY_HARD_CAP) {
    throw new Error(`tripadvisor-budget: monthly hard cap reached (${s.calls}/${MONTHLY_HARD_CAP} for ${s.month})`);
  }
  if (s.todayCalls >= DAILY_SOFT_CAP) {
    throw new Error(`tripadvisor-budget: daily soft cap reached (${s.todayCalls}/${DAILY_SOFT_CAP} for ${s.today}). Override only if you accept the burn rate.`);
  }
  s.calls += 1;
  s.todayCalls += 1;
  save(s);
  return { ...s, label };
}

// Read-only — for status reporting / dry-runs that want to see remaining quota
// without spending.
function status() {
  const s = load();
  return {
    month: s.month,
    monthCalls: s.calls,
    monthRemaining: Math.max(0, MONTHLY_HARD_CAP - s.calls),
    today: s.today,
    todayCalls: s.todayCalls,
    todayRemaining: Math.max(0, DAILY_SOFT_CAP - s.todayCalls),
    monthlyCap: MONTHLY_HARD_CAP,
    dailyCap: DAILY_SOFT_CAP,
  };
}

module.exports = { reserve, status, MONTHLY_HARD_CAP, DAILY_SOFT_CAP, BUDGET_FILE };
