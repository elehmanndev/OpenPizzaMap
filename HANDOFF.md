# OpenPizzaMap — Session Handoff (2026-04-26, end of evening)

## Prod state right now
- **1,130 places, 1,117 visible** on the map across **60+ countries** and **549+ cities**.
- **898 self-hosted hero images** at `/uploads/places/{id}.{ext}` — no more cross-origin Referer leak. Files committed to the git repo (~191 MB) so they survive Hostinger's deploy cleans.
- 232 places still have no image (mostly Instagram-embed venues from Eater pages where there's no static photo accessible, plus long-tail TasteAtlas/thegreat.pizza entries without image URLs in the source).
- API: `https://openpizzamap.com/api/places` returns the full set as JSON.
- Maintenance gate at `/` still in place. Map + style pages reachable but unlinked from the front door — Eric's call to keep it that way.

## Source breakdown (PlaceSource counts)
| Source | Count | Visibility | Notes |
|---|---|---|---|
| `avpn` | 752 | auto-flipped visible | AVPN-certified Neapolitan, 60+ countries |
| `eater` | 203 | auto-flipped visible | 13 city pages, US + London |
| `tasteatlas` | 81 | mixed | original seed, 7 pizza styles |
| `thegreat.pizza` | 99 | mixed | original seed, 16 EU+US cities |
| `50toppizza` | **0** | — | scraped (306 venues) but **import pending** — see Open Items |

## What changed this session

### 1. AVPN — 860 scraped, 636 imported, 752 PlaceSource entries
- `scripts/scrape-avpn.js` walks `https://www.pizzanapoletana.org/it/associati` (single ~860-row server-rendered table) + each detail page.
- **Coordinates come for free** from the Google Maps `embed` iframe URL — pattern `!2d{lng}!3d{lat}`. ~73% hit rate on first scrape.
- 132 HTTP-429 failures during the original concurrent scrape; the enricher retries those serial @ 2s delay (it ran once but pass-2 had a Prisma bug — fixed).
- Importer extended for global country names (Italian + English + parenthetical/dash-suffix forms; hex HTML entities).

### 2. Eater — 227 venues across 13 city pages
- `scripts/scrape-eater.js` reads `<script id="__NEXT_DATA__">` and walks to `props.pageProps.hydration.responses[*].data.node.mapPoints`.
- 100% of records have name + address + lat/lng + phone + website inline. Image URL coverage 130/227 (rest are Instagram embeds).
- Style hints carried per-page (Chicago has thin-crust/deep-dish/Detroit-square sub-pages; Eater Detroit map). Per-record `extraStyles` merged via dedupe.
- US-only + London. NYC subdomain returned 404 (retired). International expansion: try `vancouver.eater.com`, `montreal.eater.com`, `toronto.eater.com` next.

### 3. 50 Top Pizza — 306 scraped, **import incomplete**
- `scripts/scrape-50toppizza.js` parses ranking pages (Italia 2024, Italia 2023, Europe 2024, Europe 2023). Each card: rank + name + city + (region for IT lists / country for EU lists) + image.
- **No address or coords** — needs Nominatim. The local import attempt hung silently on a Nominatim request after writing the cache for ~3 min, then sat dead for 11 min before I killed it. **0 50TP places landed.**
- Importer normalizer + country table extensions are committed; just needs another import run with reliable Nominatim. Try `node scripts/import-places.js` again with retries-on-timeout on the `nominatimLookup` function (current code has none).

### 4. Image migration — self-hosted, in git
- `scripts/download-images.js` walks every Place row, downloads remote images to `public/uploads/places/{id}.{ext}`, rewrites `Place.heroImageUrl` to the local path. Idempotent (skips rows already on `/uploads/`).
- **Hostinger's Prisma client is broken right now** — it throws `PANIC: timer has gone away` on every query (Prisma 5.22 + Node 22 bug on Hostinger's distro). The first download via SSH worked, but subsequent runs all crash on the very first query. Until that's fixed, **the downloader has to run locally** (where Prisma works fine).
- The first Hostinger-side download was wiped because every git push to `main` triggers a Hostinger redeploy that clears anything not tracked in git. The fix: removed the `public/uploads/` line from `.gitignore` and committed the 898 image files (~191 MB) directly. They now ride along with each deploy.
- The repo bloat is acceptable for now. If it ever gets painful, the right refactor is an env-var path (`process.env.UPLOADS_DIR`) pointing at a persistent location outside the deploy dir, plus an Express static route — comment in `.gitignore` flags this.

### 5. Trust-flip auto-visibility
- `scripts/flip-avpn-visible.js` (yes, still that name — accepts arbitrary trusted-source list) flips any place with a PlaceSource matching `['avpn','eater','50toppizza']` to `isVisible=true`. Curated lists stand in for our manual moderation.

## Open items / next-session priorities

### High priority
1. **Finish 50 Top Pizza import** — `nominatimLookup` now has 10s timeout + retry, but the import still stalls partway through (different failure than the original hang). Try chunking with `--limit 50` batches, or rewrite the geocode loop to use serial fetches with explicit progress logging so the next stall can be diagnosed. 306 venues are in `50toppizza-scrape.json` and the importer recognises them; just needs a clean run.
2. **Re-run `download-images.js` locally** after 50TP lands — to grab images for the ~150 new venues. Then commit + push images. Each subsequent push is now safe (the deploy preserves git-tracked uploads).
3. **Fix Prisma on Hostinger.** `PrismaClientRustPanicError: timer has gone away` on every query, Prisma 5.22 + Node 22. Try upgrading `@prisma/client` and `prisma` to the latest 5.x or 6.x — known issue with patched fix in newer versions. Until that works, the downloader and any other DB script can only run from a local laptop.

### Medium priority
4. **Eater international** — probe `vancouver.eater.com`, `montreal.eater.com`, `toronto.eater.com` for `/maps/best-pizza-*`. If alive, add to `CITY_PAGES` in `scripts/scrape-eater.js`.
5. **Editing UI on both sides** — Eric's morning brief still applies. Admin needs `admin_styles.ejs` / `admin_style_edit.ejs`, bulk visibility toggle on `admin_places.ejs`. User side needs audit of `add.ejs`, `suggest_edit.ejs`, `me.ejs`.

### Lower priority (queued sources from research)
6. **The Infatuation** — Next.js `__NEXT_DATA__` shape, ~10 cities × 20 places. Fast adaptation of `scrape-eater.js`.
7. **Michelin pizza filter** — Cloudflare-gated (HTTP 202 empty body). Needs Playwright. ~400 places worldwide with Bib Gourmand badge.
8. **OSM Overpass** — biggest single volume play (5000+). Free, OdbL. Best as fill-in layer.
9. **CT Pizza Trail** — fills the empty `new-haven` style page (currently 5 places).

### Deferred (don't bring up unless Eric asks)
- Replacing the maintenance gate at `/`.
- AI-generated style/city intros.
- Reviews / karma / anti-Karen schema.
- MapLibre GL + OpenFreeMap migration.
- ISO-2 standardisation of `Place.country` (currently free text).

## Hostinger ops cheat sheet

**TL;DR:** As of 2026-04-26 evening, **don't run scripts on Hostinger** — Prisma client is broken there (`PANIC: timer has gone away` on every query). Run scripts on your laptop against prod DB instead, and let `git push` propagate code + images to the server.

If/when Prisma is fixed:
```bash
ssh -p 65002 u975898812@92.113.28.98
cd /home/u975898812/domains/openpizzamap.com/nodejs
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH

# DATABASE_URL is NOT in interactive shell env — copy from hPanel → Node.js → Env Vars
export DATABASE_URL='mysql://...'

# Then any node script:
node scripts/<name>.js
```

Hostinger app dir is `/home/u975898812/domains/openpizzamap.com/nodejs`. Node binaries live at `/opt/alt/alt-nodejs{18,20,22,24}/root/usr/bin/node`.

**Security debt:** the prod DB password was pasted into the assistant's chat history during this session. Eric chose not to rotate. Worth flagging in the next session if it bothers him.

## How a new source lands (the pipeline)

```
1. Scraper (scripts/scrape-<source>.js)              → JSON file at repo root
2. Add entry to SOURCES in scripts/import-places.js + write normalize<Source>
3. node scripts/import-places.js                      # geocodes + upserts
4. node scripts/seed-styles.js                        # Place.stylesJson → PlaceStyle
5. node scripts/flip-avpn-visible.js                  # flips trusted-source visible
6. node scripts/download-images.js                    # downloads images locally
7. git add public/uploads/places/ && git commit       # commit images + script changes
8. git push                                           # Hostinger auto-deploys
```

**Everything runs locally** (laptop's `.env` points at prod DB). Hostinger's role is only to host the deployed app — its Prisma is currently broken (see Open Item #3) so we don't run scripts on it.

Step 6 only re-fetches images for rows where `heroImageUrl` is null or external. To force a full re-download, first reset:
```
node -e "require('dotenv').config();const{PrismaClient}=require('@prisma/client');(async()=>{const p=new PrismaClient();await p.place.updateMany({where:{heroImageUrl:{startsWith:'/uploads/'}},data:{heroImageUrl:null}});await p.\$disconnect();})();"
```

## Useful pointers
- Schema: `prisma/schema.prisma`
- Importer: `scripts/import-places.js` (normalizers per shape; country tables; geocode multi-strategy)
- Scrapers: `scripts/scrape-{avpn,eater,50toppizza}.js`
- Image downloader: `scripts/download-images.js`
- Trust-flip: `scripts/flip-avpn-visible.js` (accepts source-list arg)
- Enricher (AVPN re-scrape + delegated geocode): `scripts/enrich-places.js`
- Map view: `src/views/map.ejs` + `public/js/map.js`
- Style pages: `src/views/styles.ejs`, `src/views/style.ejs`
- Admin views: `src/views/admin_*.ejs` — Style admin still missing, see open item #5
- Geocode cache: `geocode-cache.json` (committed, ~1100 entries)
- Scrape outputs at repo root: `avpn-scrape.json`, `eater-scrape.json`, `50toppizza-scrape.json`, `scrape-result.json`, `tasteatlas-*.json`

## Vision (unchanged)
- Community pizza map. Anti-"Karen reviews".
- Plan: curated scrape + user submissions + reddit-style karma.
- **Hard budget:** domain + Hostinger only. No paid APIs/SaaS/tile keys, ever.
