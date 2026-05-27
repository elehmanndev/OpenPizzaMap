# Stock photos

Licensed Adobe Stock assets used by the public homepage (`/home-preview`). Drop files in the three subfolders using the **exact filenames** listed in each subfolder's README:

- [`hero/`](./hero/) — 30 generic pizza shots, rotates 3 random per page load in the hero collage
- [`cities/`](./cities/) — 20 city character shots for the "Discover the best pizzerias in your city" row + footer landing links
- [`styles/`](./styles/) — 14 style-specific pizza shots for the "Browse by style" row + footer

## File format

- **JPEG**, sRGB
- **1200×1200** minimum (retina-safe at desktop card render size ~280×280)
- Square crop (1:1) — cards render as squares
- Aim for ~150–250 KB per file after optimization

## Wiring

When all files are placed, update `src/services/stockPhotos.js` to point at `/public/img/stock/...` paths instead of the current `picsum.photos` placeholders. The keys in `CITY_PHOTO_BY_SLUG` / `STYLE_PHOTO_BY_SLUG` map 1:1 to filenames here. No homepage code change needed.

## Why local, not hotlinked Adobe Stock URLs

- No external CDN dependency at runtime
- No risk of broken Adobe URLs if their CDN paths change
- Cacheable via the existing asset-version cache-bust
- Falls under the same `/public/` static-asset path as the rest of the site
