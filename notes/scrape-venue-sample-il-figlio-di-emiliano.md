# Worked example: Il Figlio di Emiliano (Sabadell)

Reconciled by hand on 2026-04-26 across all the sources `scrape-venue.js`
will eventually hit. Use as the regression fixture for the first
implementation — feeding `"Il Figlio di Emiliano" "Sabadell" --country ES`
should reproduce this record (modulo `lat`/`lng` rounding and timestamp
fields).

## Final Place record

```js
{
  name: "Il Figlio di Emiliano",
  addressLine: "Carrer Mare de Déu de les Neus, 6",
  city: "Sabadell",
  region: "Catalunya",
  postalCode: "08202",
  country: "ES",
  lat: 41.5505361,
  lng: 2.1077053,
  priceLevel: 2,
  stylesJson: '["neapolitan"]',
  dineIn: true,
  takeaway: true,
  delivery: true,
  phone: null,
  websiteUrl: "https://ilfigliodiemiliano.com",
  googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=41.5505361,2.1077053",
  instagramUrl: "https://www.instagram.com/ericayalapizzaiolo/",
  openingHours: "Mo-Fr 13:00-16:30,19:00-23:30; Sa-Su 13:00-24:00",
  status: "active",
  slug: "il-figlio-di-emiliano-sabadell",
  heroImageUrl: "/uploads/places/_staging-il-figlio-di-emiliano-sabadell.jpg",
  descriptionHtml: null,
  seoTitle: "Il Figlio di Emiliano — Neapolitan Pizza in Sabadell",
  seoDescription: "Neapolitan pizzeria in Sabadell using DOP San Marzano tomatoes, Caputo-style dough and Campanian EVO oils. Pizzaiolo trained in Naples.",
  isVisible: true,
}
// + PlaceSource: { source: "manual", rank: null }
// + PlaceStyle:  link to neapolitan style row
```

Hero JPEG already saved at:
`public/uploads/places/_staging-il-figlio-di-emiliano-sabadell.jpg`
(1920×1280, 2.1 MB, sourced from
`https://ilfigliodiemiliano.com/wp-content/uploads/2023/10/Home1_new-1.jpg`).

## Sources hit and what each gave

| Source | URL | Fields contributed |
|---|---|---|
| Official site | `https://ilfigliodiemiliano.com` | address, postcode, hours (canonical), email, instagram, hero candidates |
| Official site `/contacto/` | rendered via Playwright | confirmed address + email; no phone |
| Official site `/reserva/` | rendered via Playwright | reservations via CoverManager iframe; no phone |
| Official site `/wp-json/wp/v2/media?per_page=30` | WP REST endpoint | full image library (`Home1_new-1.jpg` … `Home7_new.jpg`, all 1920×1280) |
| Nominatim (by name) | `nominatim.openstreetmap.org/search?q=Pizzeria+Il+Figlio+di+Emiliano+Sabadell` | EMPTY — venue not in OSM |
| Nominatim (by address) | `nominatim.openstreetmap.org/search?q=Carrer+Mare+de+Deu+de+les+Neus+6+08202+Sabadell` | street centroid `41.5506693, 2.1079426` (~25m from RestaurantGuru), region `Catalunya`, ISO `ES-CT`, county `Vallès Occidental`, province `Barcelona` |
| RestaurantGuru | `restaurantguru.com/IL-FIGLIO-DI-EMILIANO-Sabadell` | JSON-LD: priceRange `$$`, aggregateRating 4.5/2893, geo `41.5505361, 2.1077053`, openingHours, image `https://img.restaurantguru.com/r6dc-design-IL-FIGLIO-DI-EMILIANO-2024-04.jpg`, servesCuisine `Pizza` |
| TripAdvisor | `tripadvisor.com/Restaurant_Review-g227870-d26872499-...` | 403 / blocked when scraped via Playwright; rating 3.6/5 (46 reviews) from search snippet only — TripAdvisor's $$$$ price is wrong, ignored |
| carta.menu | `carta.menu/restaurants/sabadell/il-figlio-di-emiliano` | confirmed address + slightly different hours (matches RestaurantGuru not official) |
| Glovo | `glovoapp.com/es/es/sabadell/il-figlio-di-emiliano-sbd/` | 404 — not on Glovo |
| Páginas Amarillas | `paginasamarillas.es/.../sabadell/...` | not listed |
| TheFork | `thefork.es/restaurante/il-figlio-di-emiliano-r717921` | redirected to unrelated London listing — wrong slug guess |
| Instagram bio | `instagram.com/ericayalapizzaiolo/` | rendered as base64 images server-side, unscrapable without auth — skip |

## Reconciliation notes

- **Coords**: RestaurantGuru `41.5505361, 2.1077053` vs Nominatim street
  centroid `41.5506693, 2.1079426` → ~25m apart. Both consistent. Trust
  RestaurantGuru's value (likely closer to actual storefront, not street
  midpoint).
- **Postcode**: official site says `08202`, Nominatim says `08201` for the
  street centroid → trust the venue's own value.
- **Hours**: official site `13:00-16:30, 19:00-23:30 / Sa-Su 13:00-24:00`
  vs RestaurantGuru schema.org `13:00-17:00, 19:00-23:00 / Sa-Su 13:00-24:00`
  — small variance, trust the official site.
- **Price**: TripAdvisor's $$$$ contradicts the actual menu (€9.50–€16.50
  pizzas). RestaurantGuru's `$$` is correct → priceLevel 2.
- **Phone**: not published anywhere. Owner deliberately routes contact
  through email + Instagram DMs + CoverManager. `null` is the truthful
  value, not a scrape gap.

## Future UX wishes (not in scope here)

- Render the venue's menu URL in an in-page iframe so users don't leave
  OpenPizzaMap.
- `tel:` click-to-dial when phone is non-null.
