# 2026-05-02 — Castellón normalisation + 7 Sensi city fix

Two small DB-only cleanups Eric flagged after the Spain/Portugal import.

## Castellón

Two visible places had different city strings for the same city:

- id=1236 *Pizzeria Capri* — `city = "Castellon"` (no accent, pre-existing)
- id=1781 *Le Otto* — `city = "Castellón de la Plana"` (new, from 50TP)

These are **two different pizzerias**, not duplicate Place rows — my earlier
session note said "Castellón duplicate" ambiguously; what was duplicated was
the city *string*, not the venue. Fix is just renaming both to canonical
`Castellón` (with accent). No soft-delete, no FK migration needed.

`updateMany` → 2 rows touched, both now `city = "Castellón"`.

## 7 Sensi (id=1773)

Pre-fix: `city = "Las Palmas"`, `region = null`, `postalCode = null`.

50TP's "Las Palmas" was the *province* name, but the venue is in Marina
Rubicón, **Playa Blanca, Lanzarote**. Coords `(28.857, -13.813)` were already
correct — 1 km from Playa Blanca centre, 178 km from Las Palmas de Gran
Canaria. Only the city/region/postal labels were loose.

Verified against the venue's TripAdvisor page and the address line that
GMaps had stored (`C. el Berrugo, 2, 35580 Playa Blanca, Las Palmas`).

Updated:

- `city = "Playa Blanca"`
- `region = "Canary Islands"`
- `postalCode = "35580"`
- coords unchanged

## Smoke test (post-fix)

API `/api/places/markers`:

- Total: 1,532 (unchanged from after the visibility flip).
- Spain: 49.
- Castellón: 2 (split-keys `Castellon` and `Castellón de la Plana` both 0).
- Playa Blanca: 1 (Las Palmas now 0).
- All previous spot checks still pass: Sorbillo 5, 50 Kalò 4, Sartoria 2,
  Baldoria 1, TRAFALGAR 1, Forno d'Oro 1.
