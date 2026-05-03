// Shared Google Maps Playwright helper. Used by:
//   - scripts/resolve-via-gmaps.js (address resolver, single-purpose CLI)
//   - scripts/enricher.js (phaseGmaps, opt-in --phase=gmaps)
//
// Both consumers share the same on-disk cache so a row looked up by one
// script doesn't need re-fetching by the other. The cache key is
// `${name}|${city}` to match the original resolver's keying.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(ROOT, 'gmaps-resolve-cache.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Boot a chromium context primed for Google Maps scraping: consent cookies
// pre-set (skips the EU GDPR redirect), image/font/media requests blocked
// (DOM-only), en-US locale + Chrome UA. Returns { browser, context, page };
// the caller is responsible for browser.close() when done.
async function createGmapsPage() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addCookies([
        { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
        { name: 'SOCS', value: 'CAESHAgBEhJnd3NfMjAyMzA3MDQtMF9SQzIaAmVuIAEaBgiAqIaqBg', domain: '.google.com', path: '/' },
    ]);
    const page = await context.newPage();
    await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
    });
    return { browser, context, page };
}

// One-shot diagnostic dump — only fires once per process to avoid pile-ups.
let DUMPED = false;

// Look up a venue on Google Maps by name + city. Returns:
//   { address, lat, lng, title, phone, websiteUrl, openingHours }
// or null on a hard miss (no result + no first-card to click). Each field
// is null if the place panel didn't expose it.
//
// lat/lng come from a Nominatim forward-geocode of the address — Google's
// place panel doesn't expose coords via URL or DOM on direct-hit pages
// (the map is a canvas; URL stays /search/). With a full street + number,
// Nominatim is reliable; reverse-geocoding (coords → address) was the
// brittle path we learned not to trust for the text-search use case.
async function lookup(page, name, city) {
    const q = encodeURIComponent(`${name} ${city || ''}`.trim());
    await page.goto(`https://www.google.com/maps/search/${q}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Dismiss EU consent if present (covers ES/EN/DE locales).
    for (const sel of ['button[aria-label*="Accept"]', 'button[aria-label*="Acepto"]', 'button[aria-label*="Akzeptieren"]', 'form[action*="consent"] button']) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) { await btn.click().catch(() => {}); await sleep(500); break; }
    }
    await Promise.race([
        page.waitForSelector('button[data-item-id="address"]', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('a.hfpxzc', { timeout: 8000 }).catch(() => null),
    ]);
    let address = await page.$eval('button[data-item-id="address"]', (el) => el.textContent.trim()).catch(() => null);
    if (!address) {
        const first = await page.$('a.hfpxzc');
        if (!first) {
            if (!DUMPED) {
                DUMPED = true;
                try {
                    const html = await page.content();
                    fs.writeFileSync(path.join(ROOT, 'gmaps-debug.html'), html);
                    await page.screenshot({ path: path.join(ROOT, 'gmaps-debug.png'), fullPage: false });
                    console.log('[gmaps] DEBUG dumped first-miss page → gmaps-debug.{html,png}');
                } catch { /* debug dump is best-effort */ }
            }
            return null;
        }
        await first.click();
        await page.waitForSelector('button[data-item-id="address"]', { timeout: 8000 }).catch(() => null);
        address = await page.$eval('button[data-item-id="address"]', (el) => el.textContent.trim()).catch(() => null);
    }
    if (!address) return null;

    // Pull metadata from the place panel. Each is wrapped so a missing
    // element doesn't blank the whole dict.
    const meta = await page.evaluate(() => {
        const out = { phone: null, websiteUrl: null, openingHours: null };

        const phoneBtn = document.querySelector('button[data-item-id^="phone"]');
        if (phoneBtn) {
            const dataId = phoneBtn.getAttribute('data-item-id') || '';
            const m = dataId.match(/phone:tel:(.+)$/);
            if (m) out.phone = m[1].trim();
            else {
                const aria = phoneBtn.getAttribute('aria-label') || '';
                const m2 = aria.match(/[:\s]([\d+()\s.-]{7,})\s*$/);
                if (m2) out.phone = m2[1].trim();
            }
        }

        const webA = document.querySelector('a[data-item-id="authority"]');
        if (webA) {
            const href = webA.href || '';
            if (href && !/^https?:\/\/(www\.)?(facebook|instagram|google|business\.site)\./i.test(href)) {
                out.websiteUrl = href;
            }
        }

        const hoursBtn = document.querySelector('[data-item-id="oh"], [aria-label*="Hide open hours"], [aria-label*="Show open hours"]');
        if (hoursBtn) {
            const aria = hoursBtn.getAttribute('aria-label') || '';
            if (aria.length > 30) out.openingHours = aria.replace(/\s+/g, ' ').trim();
        }
        if (!out.openingHours) {
            const table = document.querySelector('table');
            if (table && /day|lunes|martes|montag|lundi|domingo|sunday/i.test(table.textContent || '')) {
                const lines = [];
                for (const tr of table.querySelectorAll('tr')) {
                    const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
                    if (cells.length >= 2) lines.push(`${cells[0]}: ${cells[1]}`);
                }
                if (lines.length >= 3) out.openingHours = lines.join('; ');
            }
        }
        return out;
    }).catch(() => ({ phone: null, websiteUrl: null, openingHours: null }));

    // GMaps sometimes renders the today-only summary ("Cerrado · Apertura:
    // 18:30·Ver más horarios") instead of the full week aria-label. Two-stage
    // expansion: click the [oh] button to open the hours flyout, then click
    // the "Ver más horarios" link inside it to expand the full week. Re-read
    // from the expanded table. If neither surfaces a real week (≥4 distinct
    // days), null out the field — better no data than misleading half-data.
    const TRUNC_RE = /Ver más horarios|See more times|Vedi altri orari|Voir plus d'horaires|Weitere Öffnungszeiten/i;
    if (meta.openingHours && TRUNC_RE.test(meta.openingHours)) {
        try {
            await page.click('[data-item-id="oh"]', { timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(700);
            // Click the "Ver más horarios" element (it's inside a span; walk
            // up to find a clickable ancestor).
            await page.evaluate((reSrc) => {
                const re = new RegExp(reSrc, 'i');
                for (const el of document.querySelectorAll('button, a, [role="button"], span, div')) {
                    const t = (el.textContent || '').trim();
                    if (!t || t.length > 60 || !re.test(t)) continue;
                    let click = el;
                    for (let depth = 0; click && depth < 5; depth++) {
                        if (['BUTTON', 'A'].includes(click.tagName) || click.getAttribute('role') === 'button') break;
                        click = click.parentElement;
                    }
                    if (click) { click.click(); return true; }
                }
                return false;
            }, TRUNC_RE.source).catch(() => {});
            await page.waitForTimeout(1100);

            const dayCodes = { domingo: 'Su', lunes: 'Mo', martes: 'Tu', miércoles: 'We', miercoles: 'We', jueves: 'Th', viernes: 'Fr', sábado: 'Sa', sabado: 'Sa', sunday: 'Su', monday: 'Mo', tuesday: 'Tu', wednesday: 'We', thursday: 'Th', friday: 'Fr', saturday: 'Sa', domenica: 'Su', lunedì: 'Mo', lunedi: 'Mo', martedì: 'Tu', martedi: 'Tu', mercoledì: 'We', mercoledi: 'We', giovedì: 'Th', giovedi: 'Th', venerdì: 'Fr', venerdi: 'Fr', sonntag: 'Su', montag: 'Mo', dienstag: 'Tu', mittwoch: 'We', donnerstag: 'Th', freitag: 'Fr', samstag: 'Sa', dimanche: 'Su', lundi: 'Mo', mardi: 'Tu', mercredi: 'We', jeudi: 'Th', vendredi: 'Fr', samedi: 'Sa' };
            const expanded = await page.evaluate((dayCodesObj) => {
                const stripAcc = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
                // Walk every element looking for a "<day><time-range>"
                // pattern. Dedup by (day → first occurrence) so we don't
                // double-count nested wrappers.
                const found = new Map();
                for (const el of document.querySelectorAll('tr, li, div, span')) {
                    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!t || t.length > 100) continue;
                    const m = t.match(/^([A-Za-zÀ-ÿ]+)\s*[:.]?\s*(\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}.*)$/);
                    if (m) {
                        const code = dayCodesObj[stripAcc(m[1])];
                        if (code && !found.has(code)) found.set(code, m[2].trim());
                        continue;
                    }
                    // Closed pattern: "lunes Cerrado" / "Monday Closed"
                    const c = t.match(/^([A-Za-zÀ-ÿ]+)\s*[:.]?\s*(Cerrado|Closed|Chiuso|Fermé|Geschlossen|Fechado)$/i);
                    if (c) {
                        const code = dayCodesObj[stripAcc(c[1])];
                        if (code && !found.has(code)) found.set(code, 'Cerrado');
                    }
                }
                if (found.size < 4) return null;
                const order = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
                const labels = { Mo: 'lunes', Tu: 'martes', We: 'miércoles', Th: 'jueves', Fr: 'viernes', Sa: 'sábado', Su: 'domingo' };
                return order.filter((c) => found.has(c)).map((c) => `${labels[c]}: ${found.get(c)}`).join('; ');
            }, dayCodes);
            meta.openingHours = expanded || null;
        } catch {
            meta.openingHours = null;
        }
    }

    // Forward-geocode address → coords via Nominatim.
    let lat = null, lng = null;
    try {
        const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
        const r = await fetch(u, { headers: { 'User-Agent': 'OpenPizzaMap-gmaps/0.1 (eric@openpizzamap.com)' } });
        if (r.ok) {
            const arr = await r.json();
            if (Array.isArray(arr) && arr.length) { lat = arr[0].lat; lng = arr[0].lon; }
        }
    } catch { /* coord enrich is best-effort */ }
    await sleep(1100); // honour Nominatim 1 req/sec

    const title = (await page.title()).replace(/\s*-\s*Google Maps\s*$/, '').trim();
    return { address, lat, lng, title, ...meta };
}

module.exports = { createGmapsPage, lookup, loadCache, saveCache, CACHE_PATH };
