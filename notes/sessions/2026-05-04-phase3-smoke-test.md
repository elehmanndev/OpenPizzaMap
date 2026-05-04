# 2026-05-04 — Phase 3 smoke test + incidents

## Status: PASSED

`ENRICHMENT_PROVIDER=google_api` is live on Hostinger. Full Places API response
confirmed for Sorbillo, Naples — googlePlaceId, coords, rating, phone, hours.

## Incidents resolved

### 503 crash loop (migrate.js Prisma panic)
- **Root cause**: `prisma migrate deploy` panics with `PANIC: timer has gone away`
  (Rust futures-timer crate, Passenger fork incompatibility). This blocks `&&` chain
  in `npm start`, preventing `app.js` from starting.
- **Fix**: Wrote migration sentinel manually from SSH so `migrate.js` skips
  `prisma migrate deploy` on subsequent boots. Script: `/tmp/fix-sentinel.js`.
- **Long-term**: Consider wrapping migrate deploy in `MIGRATE_LENIENT=true` by
  default on Hostinger, or running schema changes only via `prisma db push`.

### API key IPv4/IPv6 mismatch
- **Root cause**: GCP key restricted to `92.113.28.98` (IPv4), but Hostinger
  outbound requests use IPv6 `2a02:4780:27:1749:0:3a2b:8bc:1`.
- **Fix**: Added `2a02:4780:27:1749::/64` to GCP key IP allowlist.

### App path confusion
- App lives at `~/domains/openpizzamap.com/nodejs/`, not `public_html/`.
- `public_html/` is static/empty; `.builds/config/.env` is under `public_html/`.

## Smoke test result
```json
{
  "provider": "google_api",
  "callsMade": 1,
  "resolved": {
    "googlePlaceId": "ChIJuyXzSEIIOxMR5KQy1mftAr0",
    "canonicalName": "Gino e Toto Sorbillo",
    "formattedAddress": "Via dei Tribunali, 32, 80138 Napoli NA, Italy",
    "lat": 40.8503854,
    "lng": 14.2553028,
    "rating": 4.5,
    "ratingCount": 30348,
    "phone": "081 446643",
    "websiteUrl": "http://www.sorbillo.it/"
  }
}
```

## Next
- Run 20-row batch via the importer to validate end-to-end DB writes.
- Monitor GCP quota dashboard — hard caps at 155/315/315/50×4 RPD.
