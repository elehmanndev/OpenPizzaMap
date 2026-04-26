# scripts/lib/ — shared helpers

Two modules, both required by `enricher.js` and `scrape-venue.js`.

## scripts/lib/utils.js

The shared helper library. Extracted on 2026-04-26 from inline copies in
`enricher.js` after `scrape-venue.js` showed up needing the same logic.

### Exports

| Export | Type | What it does |
|---|---|---|
| `DEFAULT_UA` | string | Default User-Agent. Override per-call via `fetchWithTimeout(url, { userAgent: ... })`. |
| `sleep(ms)` | fn → Promise | `setTimeout` wrapper. |
| `isEmpty(v)` | fn → bool | `null` / `undefined` / `''` / whitespace-only string. |
| `normalizeName(s)` | fn → string | Lowercase, strip diacritics, drop parentheticals, drop venue-noun stopwords (`pizzeria`, `ristorante`, `the`, `la`...) and place-name stopwords (`napoli`, `naples`, `londra`, `london`...), collapse non-alnum runs to single space. |
| `jaroWinkler(a, b)` | fn → number 0..1 | String similarity. |
| `haversineM(lat1, lng1, lat2, lng2)` | fn → number | Distance in meters. |
| `fetchWithTimeout(url, opts, timeoutMs)` | fn → Promise<Response> | `fetch` with `AbortController` timeout. `opts.userAgent` overrides default UA; `opts.accept` sets `Accept`; `opts.headers` merges over both. |
| `slugify(s)` | fn → string | NFD-normalize + lowercase + replace non-alnum with `-`. Used for `Place.slug` and uploaded filenames. |
| `canonCity(s)` | fn → string | Looser: lowercase + diacritic strip only. For cross-locale comparisons. |
| `dedupKey(name, city)` | fn → string | `slugify(name) + '\|' + slugify(city)`. |
| `STYLE_PATTERNS` | array | Pizza-style regexes (`neapolitan`, `al-taglio`, `ny`, `detroit`, `chicago`, `new-haven`, `italian` for Roman/Pinsa). |
| `inferStylesFromText(text)` | fn → string[] | Returns dedup'd slugs found in text. |
| `parseSchemaOrgFromHtml(html)` | fn → object | Parses every `<script type="application/ld+json">` block, finds Restaurant/FoodEstablishment/LocalBusiness items, returns merged `{addressLine, postalCode, region, country, lat, lng, phone, website, instagramUrl, openingHours, priceRange, priceLevel, heroImageUrl, description, styles[], aggregateRating, reviewCount, acceptsReservations, hasMenu}`. |
| `priceRangeToLevel(pr)` | fn → 1..4 \| null | `$$` → 2, `$$$$` → 4, etc. Handles `€` `£` `¥`. |
| `ddgSearch(query, opts)` | fn → string[] | DuckDuckGo HTML scrape — up to 8 result URLs, decoded if wrapped in DDG's redirect. |
| `decodeDdgLink(href)` | fn → string \| null | Unwraps `//duckduckgo.com/l/?uddg=ENCODED` redirects. |
| `plausibleVenueUrl(url, name)` | fn → bool | True iff URL passes `AGGREGATOR_HOSTS` reject-list AND contains a name token. |
| `isAggregatorUrl(url)` | fn → bool | True for URLs we still want to fetch for JSON-LD signals (RestaurantGuru, carta.menu, TripAdvisor) but never adopt as `websiteUrl`. |
| `AGGREGATOR_HOSTS` | RegExp | The big reject-list pattern — facebook, instagram, tripadvisor, yelp, opentable, thefork, google, maps, youtube, wikipedia, wikidata, tiktok, twitter, x.com, reddit, theinfatuation, eater, michelin, tasteatlas, 50toppizza, pizzanapoletana, theguardian, nytimes, timeout, condenast, restaurantguru, carta.menu, paginasamarillas, glovoapp, justeat, deliveroo, ubereats, covermanager, resy, sevenrooms. |

### Conventions

- **Never overwrite a non-null with null.** Both consumers honor this. The
  utility helpers here return null on miss; the caller decides whether to
  fill.
- **Decimal awareness.** `haversineM` calls `parseFloat` defensively so it
  works on Prisma `Decimal` objects without explicit conversion.
- **No Prisma dep.** This file deliberately doesn't import `@prisma/client`
  — keeps the lib lightweight and reusable in non-DB contexts (probes,
  one-off scripts).

### When to add to this lib

Add a helper here if:

- It's used by ≥2 scripts (enricher + scrape-venue, or any two scrapers).
- It's pure or stateless. Stateful things (HTTP retries with backoff,
  budget tracking) get their own module — see `tripadvisor-budget.js`.
- It doesn't pull in heavy deps. The lib should stay zero-dep.

Don't add:

- One-off helpers used by a single script.
- Anything that references `process.env`. Env-coupled logic belongs in
  the consumer.

## scripts/lib/tripadvisor-budget.js

Persistent counter for the TripAdvisor Content API. Call `reserve()`
*before* every TA HTTP request — it increments the counter and persists
to disk before returning, so a crashed script doesn't double-spend on
retry.

### State file

`scripts/lib/.tripadvisor-budget.json` (gitignored). Shape:

```json
{
  "month": "2026-04",
  "calls": 7,
  "today": "2026-04-26",
  "todayCalls": 7
}
```

Day and month boundaries roll over automatically on the first
`load()` of a new period — no cron job needed.

### Caps

| Cap | Limit | Reason |
|---|---|---|
| Monthly hard | 4000 | Free tier is 5000; leave 1000 for emergencies. |
| Daily soft | 130 | A runaway script can't burn the monthly budget in one sitting. 4000 / 30 days ≈ 133. |

### API

```js
const taBudget = require('./scripts/lib/tripadvisor-budget');

// Reserve a slot — throws if either cap is exhausted.
const slot = taBudget.reserve('label-for-this-call');
// → { month, calls, today, todayCalls, label, monthlyCap?, dailyCap? }

// Read-only status (does NOT increment).
console.log(taBudget.status());
// → { month, monthCalls, monthRemaining, today, todayCalls, todayRemaining,
//     monthlyCap, dailyCap }
```

### Sharing the budget

`scrape-venue.js` and the future TA enricher phase both read/write the
same file. No locking — the budget file is small enough that
last-write-wins is fine for the "did I exceed N calls" question, and
both consumers run sequentially (not in parallel).

If we ever run them concurrently we should add file-lock semantics, but
that's not on the roadmap.

## Why two separate lib modules

`utils.js` is pure logic — safe to import in any context, zero side
effects. `tripadvisor-budget.js` does file I/O (read + write the
counter) on every call. Keeping them separate so consumers that only
need string utilities don't accidentally trigger TA budget I/O.
