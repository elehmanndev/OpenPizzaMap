(async function () {
    const FALLBACK_CENTER = [41.9, 12.5];

    const map = L.map("map", { zoomControl: false, layers: [] }).setView(FALLBACK_CENTER, 5);

    const cartoAttr =
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>';
    const esriAttr =
        'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

    const voyager = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, attribution: cartoAttr, subdomains: "abcd" }
    );
    const positron = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, attribution: cartoAttr, subdomains: "abcd" }
    );
    const esriImagery = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: esriAttr }
    );
    const voyagerLabels = L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, attribution: "", subdomains: "abcd", pane: "shadowPane" }
    );
    const satellite = L.layerGroup([esriImagery, voyagerLabels]);

    voyager.addTo(map);

    function pizzaIconForZoom(zoom, highlighted = false) {
        const minZoom = 3;
        const maxZoom = 18;
        const minSize = 22;
        const maxSize = 56;
        const t = Math.max(0, Math.min(1, (zoom - minZoom) / (maxZoom - minZoom)));
        const size = Math.round(minSize + (maxSize - minSize) * t);
        return L.divIcon({
            className: highlighted ? "pizza-marker pizza-marker--hl" : "pizza-marker",
            html: `<span class="pizza-marker-emoji" style="font-size:${size}px">🍕</span>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size],
            popupAnchor: [0, -size + 4],
        });
    }

    const cluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 50,
    });
    map.addLayer(cluster);

    const allEntries = []; // { place, marker }
    let highlightedMarker = null;

    function rescaleMarkers() {
        const z = map.getZoom();
        for (const e of allEntries) {
            e.marker.setIcon(pizzaIconForZoom(z, e.marker === highlightedMarker));
        }
    }
    map.on("zoomend", rescaleMarkers);

    const esc = (s) =>
        String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

    function priceGlyph(level) {
        const n = Math.max(1, Math.min(4, Number(level) || 1));
        return "€".repeat(n);
    }

    function styleChips(p) {
        const styles = Array.isArray(p.styles) && p.styles.length ? p.styles : null;
        if (styles) {
            return styles.map((s) =>
                `<a class="ppc-style-chip" href="/style/${esc(s.slug)}">${esc(s.shortLabel || s.name)}</a>`
            ).join("");
        }
        try {
            const arr = JSON.parse(p.stylesJson || "[]");
            if (!Array.isArray(arr) || !arr.length) return "";
            return arr.map((slug) =>
                `<a class="ppc-style-chip" href="/style/${esc(slug)}">${esc(slug.replace(/-/g, " "))}</a>`
            ).join("");
        } catch {
            return "";
        }
    }

    function stripHtml(s) {
        const tmp = document.createElement("div");
        tmp.innerHTML = s || "";
        return (tmp.textContent || "").trim();
    }

    function summaryFor(p) {
        if (p.seoDescription) return p.seoDescription;
        if (p.descriptionHtml) return stripHtml(p.descriptionHtml);
        return [p.city, priceGlyph(p.priceLevel)].filter(Boolean).join(" · ");
    }

    let regionNames = null;
    try {
        regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {}

    function formatAddress(p) {
        let country = p.country;
        if (country && regionNames && /^[A-Za-z]{2}$/.test(country)) {
            try { country = regionNames.of(country.toUpperCase()) || country; } catch {}
        }
        const cityLine = [p.postalCode, p.city, p.region].filter(Boolean).join(" ").replace(/\s+/g, " ");
        return [p.addressLine, cityLine, country].filter(Boolean).join(", ");
    }

    function thumbUrlFor(url) {
        if (!url || typeof url !== "string") return url;
        if (!url.startsWith("/uploads/places/")) return url;
        const m = url.match(/^(.*)\.(jpe?g|png|webp|gif|avif)$/i);
        if (!m) return url;
        if (/-thumb$/.test(m[1])) return url;
        return `${m[1]}-thumb.jpg`;
    }

    function ratingFor(p) {
        const r = p.opmRating ?? p.googleRating ?? p.tripadvisorRating ?? p.yelpRating;
        const n = Number(r);
        return Number.isFinite(n) ? n : null;
    }

    function ratingLabel(p) {
        const n = ratingFor(p);
        if (n == null) return "—";
        // opmRating is 1-10 with one decimal; google/ta/yelp are 1-5. Show as-is.
        return n.toFixed(1);
    }

    function popupHtml(p) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        const directions = p.googleMapsUrl
            ? p.googleMapsUrl
            : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
        const rating = ratingLabel(p);
        const heroInner = `<span class="ppc-rating">${rating}</span>`;
        const heroSrc = thumbUrlFor(p.heroImageUrl);
        const hero = p.heroImageUrl
            ? `<div class="ppc-hero">
    <img class="ppc-hero-img" src="${esc(heroSrc)}" data-fallback="${esc(p.heroImageUrl)}" alt="" loading="lazy" onerror="if(this.src!==this.dataset.fallback){this.src=this.dataset.fallback}else{this.remove()}" />
    ${heroInner}
  </div>`
            : `<div class="ppc-hero ppc-hero--fallback">${heroInner}<span class="ppc-hero-emoji">🍕</span></div>`;
        const address = formatAddress(p);

        const chips = styleChips(p);
        return `
<article class="ppc">
  ${hero}
  <div class="ppc-body">
    <h2 class="ppc-name">${esc(p.name)}</h2>
    <a class="ppc-directions" href="${esc(directions)}" target="_blank" rel="noopener">${esc(address)}</a>
    ${chips ? `<div class="ppc-styles">${chips}</div>` : ""}
    <p class="ppc-summary">${esc(summaryFor(p))}</p>
    <a class="ppc-cta" href="/place/${p.id}">View profile</a>
  </div>
</article>`.trim();
    }

    function favBtnHtml(favorited) {
        const cls = favorited ? "msc-fav is-active" : "msc-fav";
        const icon = favorited ? "favorite" : "favorite";
        const label = favorited ? "Remove from favourites" : "Add to favourites";
        return `<button type="button" class="${cls}" data-fav-btn aria-label="${esc(label)}" aria-pressed="${favorited ? "true" : "false"}">
    <span class="material-symbols-rounded" aria-hidden="true">${icon}</span>
  </button>`;
    }

    function cardHtml(p) {
        const heroSrc = thumbUrlFor(p.heroImageUrl);
        const rating = ratingLabel(p);
        const hero = p.heroImageUrl
            ? `<div class="msc-hero">
    <img class="msc-hero-img" src="${esc(heroSrc)}" data-fallback="${esc(p.heroImageUrl)}" alt="" loading="lazy" onerror="if(this.src!==this.dataset.fallback){this.src=this.dataset.fallback}else{this.style.display='none'}" />
    <span class="msc-rating">${rating}</span>
  </div>`
            : `<div class="msc-hero msc-hero--fallback">
    <span class="msc-rating">${rating}</span>
    <span class="msc-hero-emoji">🍕</span>
  </div>`;
        const cityLine = [p.city, p.country].filter(Boolean).join(", ");
        const price = p.priceLevel ? priceGlyph(p.priceLevel) : "";
        const meta = [cityLine, price].filter(Boolean).join(" · ");
        const chips = styleChips(p);
        const fav = favBtnHtml(!!p.viewerFavorited);
        return `
${hero}
${fav}
<div class="msc-body">
  <h3 class="msc-name">${esc(p.name)}</h3>
  ${meta ? `<p class="msc-meta">${esc(meta)}</p>` : ""}
  ${chips ? `<div class="msc-styles">${chips}</div>` : ""}
</div>`.trim();
    }

    // -- Geo helpers ---------------------------------------------------------
    function haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const toRad = (x) => (x * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // -- DOM refs ------------------------------------------------------------
    const sidebarList = document.querySelector(".map-sidebar-list");
    const emptyState = document.querySelector(".map-sidebar-empty");
    const zoomOutBtn = document.querySelector(".map-zoom-out");
    const resultCount = document.querySelector(".map-result-count");
    const searchInput = document.querySelector(".map-search-input");
    const searchClear = document.querySelector(".map-search-clear");
    const sortDropdown = document.querySelector(".map-sort-dropdown");
    const styleDropdown = document.querySelector(".map-style-dropdown");
    const styleMenuEl = document.querySelector(".map-style-menu");
    const styleSummaryCount = document.querySelector(".map-style-summary-count");

    // -- State ---------------------------------------------------------------
    const state = {
        query: "",
        sort: "popular",
        activeStyles: new Set(),
        userLoc: null,    // { lat, lng } if geoloc granted
        searchCenter: null, // { lat, lng } from text-search match (city centroid)
    };

    // -- Search helpers ------------------------------------------------------
    // Strip diacritics so "naples" matches "Nápoles", "Munchen" matches "München", etc.
    function normalize(s) {
        return String(s || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^\w\s'-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Multilingual aliases for cities/countries we have in the DB but users may
    // type in their own language. Keys must be normalized; values are added to
    // the haystack for matching, not displayed.
    // Each entry maps a normalized query to a list of equivalent forms. The
    // matcher OR's them together so "rome" finds rows whose city is stored as
    // "Roma" without breaking rows whose city is stored as "Rome".
    const SEARCH_ALIASES = {
        "naples": ["napoli"], "napoli": ["naples"],
        "florence": ["firenze"], "firenze": ["florence"],
        "rome": ["roma"], "roma": ["rome"],
        "milan": ["milano"], "milano": ["milan"],
        "turin": ["torino"], "torino": ["turin"],
        "venice": ["venezia"], "venezia": ["venice"],
        "genoa": ["genova"], "genova": ["genoa"],
        "padua": ["padova"], "padova": ["padua"],
        "syracuse": ["siracusa"], "siracusa": ["syracuse"],
        "leghorn": ["livorno"], "livorno": ["leghorn"],
        "munich": ["munchen"], "munchen": ["munich"],
        "cologne": ["koln"], "koln": ["cologne"],
        "nuremberg": ["nurnberg"], "nurnberg": ["nuremberg"],
        "vienna": ["wien"], "wien": ["vienna"],
        "prague": ["praha"], "praha": ["prague"],
        "warsaw": ["warszawa"], "warszawa": ["warsaw"],
        "lisbon": ["lisboa"], "lisboa": ["lisbon"],
        "seville": ["sevilla"], "sevilla": ["seville"],
        "saragossa": ["zaragoza"], "zaragoza": ["saragossa"],
        "cordova": ["cordoba"], "cordoba": ["cordova"],
        "majorca": ["mallorca"], "mallorca": ["majorca"],
        "minorca": ["menorca"], "menorca": ["minorca"],
        "ibiza": ["eivissa"], "eivissa": ["ibiza"],
        "the hague": ["den haag"], "den haag": ["the hague"],
        "antwerp": ["antwerpen"], "antwerpen": ["antwerp"],
        "brussels": ["bruxelles", "brussel"], "bruxelles": ["brussels", "brussel"],
        "ghent": ["gent"], "gent": ["ghent"],
        "copenhagen": ["kobenhavn"], "kobenhavn": ["copenhagen"],
        "gothenburg": ["goteborg"], "goteborg": ["gothenburg"],
        "moscow": ["moskva"], "moskva": ["moscow"],
        "athens": ["athina"], "athina": ["athens"],
        "italy": ["italia"], "italia": ["italy"],
        "spain": ["espana"], "espana": ["spain"],
        "germany": ["deutschland"], "deutschland": ["germany"],
        "japan": ["nihon"], "nihon": ["japan"],
        "greece": ["ellada"], "ellada": ["greece"],
    };

    // Returns a list of normalized query alternatives. Each is matched
    // independently (OR), but tokens within one alternative are AND'd.
    function queryAlternatives(q) {
        const norm = normalize(q);
        if (!norm) return [];
        const aliases = SEARCH_ALIASES[norm] || [];
        return [norm, ...aliases];
    }

    // Token-prefix fuzzy: query "nap pizza" matches if every token is a prefix
    // of some word in the haystack. Tolerant of order, partials and accents.
    function fuzzyTokenMatch(haystack, queryTokens) {
        if (!queryTokens.length) return true;
        const words = haystack.split(/\s+/).filter(Boolean);
        for (const tok of queryTokens) {
            const t = tok.toLowerCase();
            let hit = false;
            for (const w of words) {
                if (w.startsWith(t) || (t.length >= 5 && w.includes(t))) {
                    hit = true; break;
                }
            }
            if (!hit) return false;
        }
        return true;
    }

    function buildHaystack(p) {
        return normalize([p.name, p.city, p.region, p.country].filter(Boolean).join(" "));
    }

    // -- Filtering / sorting -------------------------------------------------
    function placeMatchesQuery(p, q) {
        if (!q) return true;
        const alts = queryAlternatives(q);
        if (!alts.length) return true;
        const hay = buildHaystack(p);
        for (const alt of alts) {
            const tokens = alt.split(/\s+/).filter(Boolean);
            if (fuzzyTokenMatch(hay, tokens)) return true;
        }
        return false;
    }

    function placeMatchesStyles(p) {
        if (state.activeStyles.size === 0) return true;
        const slugs = Array.isArray(p.styles)
            ? p.styles.map((s) => s.slug)
            : (() => {
                  try { return JSON.parse(p.stylesJson || "[]"); } catch { return []; }
              })();
        for (const s of slugs) if (state.activeStyles.has(s)) return true;
        return false;
    }

    function inBounds(entry, bounds) {
        return bounds.contains(entry.marker.getLatLng());
    }

    function sortEntries(entries) {
        const sorted = entries.slice();
        switch (state.sort) {
            case "rating":
                sorted.sort((a, b) => {
                    const ra = ratingFor(a.place);
                    const rb = ratingFor(b.place);
                    if (ra == null && rb == null) return 0;
                    if (ra == null) return 1;
                    if (rb == null) return -1;
                    return rb - ra;
                });
                break;
            case "popular":
                sorted.sort((a, b) => (b.place.visitCount || 0) - (a.place.visitCount || 0));
                break;
            case "price-asc":
            case "price-desc": {
                const dir = state.sort === "price-asc" ? 1 : -1;
                sorted.sort((a, b) => {
                    const pa = a.place.priceLevel;
                    const pb = b.place.priceLevel;
                    if (pa == null && pb == null) return 0;
                    if (pa == null) return 1;
                    if (pb == null) return -1;
                    return (pa - pb) * dir;
                });
                break;
            }
            case "distance-me": {
                const c = state.userLoc;
                if (!c) return sorted;
                sorted.sort((a, b) => {
                    const da = haversineKm(c.lat, c.lng, Number(a.place.lat), Number(a.place.lng));
                    const db = haversineKm(c.lat, c.lng, Number(b.place.lat), Number(b.place.lng));
                    return da - db;
                });
                break;
            }
            case "distance-city": {
                const c = state.searchCenter;
                if (!c) return sorted;
                sorted.sort((a, b) => {
                    const da = haversineKm(c.lat, c.lng, Number(a.place.lat), Number(a.place.lng));
                    const db = haversineKm(c.lat, c.lng, Number(b.place.lat), Number(b.place.lng));
                    return da - db;
                });
                break;
            }
        }
        return sorted;
    }

    function visibleEntries() {
        // The sidebar shows what's currently in the viewport, filtered by the
        // active style chips. The search input drives the suggest panel only;
        // confirming a suggestion flies the map and the sidebar follows.
        const bounds = map.getBounds();
        const filtered = allEntries.filter((e) => {
            if (!placeMatchesStyles(e.place)) return false;
            if (!inBounds(e, bounds)) return false;
            return true;
        });
        return sortEntries(filtered);
    }

    // -- Render --------------------------------------------------------------
    let renderToken = 0;
    const cardEls = new WeakMap(); // marker -> card element

    function renderSidebar() {
        const token = ++renderToken;
        const entries = visibleEntries();
        const frag = document.createDocumentFragment();

        sidebarList.innerHTML = "";
        cardEls.clear?.();

        for (const e of entries) {
            const card = document.createElement("a");
            card.className = "map-sidebar-card";
            card.href = `/place/${e.place.id}`;
            card.setAttribute("role", "listitem");
            card.dataset.placeId = String(e.place.id);
            card.innerHTML = cardHtml(e.place);

            card.addEventListener("mouseenter", () => highlight(e.marker));
            card.addEventListener("mouseleave", () => highlight(null));
            card.addEventListener("click", (ev) => {
                // Heart button intercepts the click before this fires.
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                ev.preventDefault();
                map.setView(e.marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
                e.marker.openPopup();
            });

            const favBtn = card.querySelector("[data-fav-btn]");
            if (favBtn) {
                favBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggleFavorite(e.place, favBtn);
                });
            }

            cardEls.set(e.marker, card);
            frag.appendChild(card);
        }

        if (token !== renderToken) return;
        sidebarList.appendChild(frag);

        const total = entries.length;
        resultCount.textContent = total === 1 ? "1 spot" : `${total} spots`;
        emptyState.hidden = total > 0;
        sidebarList.hidden = total === 0;
    }

    async function toggleFavorite(place, btn) {
        if (!window.__OPM_USER__) {
            window.location.href = "/auth";
            return;
        }
        // Optimistic toggle
        const wasFav = btn.classList.contains("is-active");
        btn.classList.toggle("is-active", !wasFav);
        btn.setAttribute("aria-pressed", String(!wasFav));
        place.viewerFavorited = !wasFav;
        try {
            const res = await fetch(`/api/places/${place.id}/favorite`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            if (!res.ok) throw new Error("favorite failed");
            const data = await res.json();
            place.viewerFavorited = !!data.favorited;
            btn.classList.toggle("is-active", !!data.favorited);
            btn.setAttribute("aria-pressed", String(!!data.favorited));
        } catch (err) {
            // Revert
            place.viewerFavorited = wasFav;
            btn.classList.toggle("is-active", wasFav);
            btn.setAttribute("aria-pressed", String(wasFav));
            console.error("Favorite toggle failed", err);
        }
    }

    function highlight(marker) {
        if (highlightedMarker === marker) return;
        const z = map.getZoom();
        if (highlightedMarker) {
            highlightedMarker.setIcon(pizzaIconForZoom(z, false));
        }
        highlightedMarker = marker;
        if (marker) {
            marker.setIcon(pizzaIconForZoom(z, true));
        }
    }

    // -- Style filter dropdown ----------------------------------------------
    function updateStyleSummary() {
        const n = state.activeStyles.size;
        if (n === 0) {
            styleSummaryCount.hidden = true;
            styleSummaryCount.textContent = "";
        } else {
            styleSummaryCount.hidden = false;
            styleSummaryCount.textContent = String(n);
        }
    }

    function buildStyleFilters() {
        const counts = new Map(); // slug -> { label, n }
        for (const e of allEntries) {
            const styles = Array.isArray(e.place.styles) ? e.place.styles : [];
            for (const s of styles) {
                if (!s.slug) continue;
                const cur = counts.get(s.slug);
                if (cur) cur.n += 1;
                else counts.set(s.slug, { label: s.shortLabel || s.name || s.slug, n: 1 });
            }
        }
        const items = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);

        styleMenuEl.innerHTML = "";
        for (const [slug, { label, n }] of items) {
            const id = `style-opt-${slug}`;
            const row = document.createElement("label");
            row.className = "map-style-opt";
            row.htmlFor = id;
            row.innerHTML = `
                <input type="checkbox" id="${id}" value="${slug}" />
                <span class="map-style-opt-label">${label}</span>
                <span class="map-style-opt-count">${n}</span>
            `;
            const cb = row.querySelector("input");
            cb.addEventListener("change", () => {
                if (cb.checked) state.activeStyles.add(slug);
                else state.activeStyles.delete(slug);
                updateStyleSummary();
                renderSidebar();
            });
            styleMenuEl.appendChild(row);
        }

        // Close dropdown on outside click.
        document.addEventListener("click", (ev) => {
            if (!styleDropdown.open) return;
            if (!styleDropdown.contains(ev.target)) styleDropdown.open = false;
        });
        updateStyleSummary();
    }

    // -- Search --------------------------------------------------------------
    function updateSearchCenter() {
        if (!state.query.trim()) { state.searchCenter = null; return; }
        // City centroid: average lat/lng of matching places (uses the same
        // fuzzy/alias matcher as the sidebar filter so "Naples" → Napoli works).
        const matches = allEntries.filter((e) => placeMatchesQuery(e.place, state.query));
        if (!matches.length) { state.searchCenter = null; return; }
        let lat = 0, lng = 0;
        for (const e of matches) {
            lat += Number(e.place.lat);
            lng += Number(e.place.lng);
        }
        state.searchCenter = { lat: lat / matches.length, lng: lng / matches.length };
    }

    function flyToSearchResults() {
        if (!state.query.trim()) return;
        const matches = allEntries.filter((e) =>
            placeMatchesQuery(e.place, state.query) && placeMatchesStyles(e.place)
        );
        if (!matches.length) return;
        const group = L.featureGroup(matches.map((m) => m.marker));
        map.flyToBounds(group.getBounds(), { padding: [48, 48], maxZoom: 14, duration: 0.6 });
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    }

    // -- Suggest panel ------------------------------------------------------
    const suggestEl = document.querySelector(".map-search-suggest");
    const suggestCitiesUl = suggestEl?.querySelector("[data-suggest-cities] .map-suggest-list");
    const suggestSpotsUl = suggestEl?.querySelector("[data-suggest-spots] .map-suggest-list");
    const suggestCitiesSec = suggestEl?.querySelector("[data-suggest-cities]");
    const suggestSpotsSec = suggestEl?.querySelector("[data-suggest-spots]");
    const suggestEmpty = suggestEl?.querySelector(".map-suggest-empty");

    function showSuggest() { if (suggestEl) suggestEl.hidden = false; }
    function hideSuggest() { if (suggestEl) suggestEl.hidden = true; }

    function renderSuggest() {
        if (!suggestEl) return;
        const q = state.query.trim();
        if (!q) { hideSuggest(); return; }

        // Spot matches: top hits where the place's name matches.
        const spotMatches = [];
        // City buckets: key = `${city}|${country}` → { city, country, count, sample }
        const cityMap = new Map();

        for (const e of allEntries) {
            const matchesAll = placeMatchesQuery(e.place, q);
            if (!matchesAll) continue;

            // City bucket if its city itself matches the query.
            if (e.place.city) {
                const cityHay = normalize([e.place.city, e.place.country].filter(Boolean).join(" "));
                let cityMatched = false;
                for (const alt of queryAlternatives(q)) {
                    const tokens = alt.split(/\s+/).filter(Boolean);
                    if (fuzzyTokenMatch(cityHay, tokens)) { cityMatched = true; break; }
                }
                if (cityMatched) {
                    const key = `${e.place.city}|${e.place.country || ""}`;
                    const cur = cityMap.get(key);
                    if (cur) cur.count += 1;
                    else cityMap.set(key, { city: e.place.city, country: e.place.country, count: 1, sample: e });
                }
            }

            // Spot match: name must contain the literal query — no alias
            // expansion here, otherwise typing "Naples" surfaces every
            // pizzeria with "Napoli" in its name and floods the suggest.
            const nameHay = normalize(e.place.name || "");
            const nameTokens = normalize(q).split(/\s+/).filter(Boolean);
            if (nameTokens.length && fuzzyTokenMatch(nameHay, nameTokens)) {
                spotMatches.push(e);
            }
        }

        const cities = [...cityMap.values()].sort((a, b) => b.count - a.count).slice(0, 4);
        const spots = spotMatches.slice(0, 6);

        suggestCitiesUl.innerHTML = "";
        for (const c of cities) {
            const li = document.createElement("li");
            li.className = "map-suggest-item";
            li.innerHTML = `
                <span class="map-suggest-thumb map-suggest-thumb--city" aria-hidden="true">
                    <span class="material-symbols-rounded">local_pizza</span>
                </span>
                <span class="map-suggest-text">
                    <span class="map-suggest-name">${esc(c.city)}</span>
                    <span class="map-suggest-meta">${esc(c.country || "")}</span>
                </span>
                <span class="map-suggest-count">${c.count}</span>
            `;
            li.addEventListener("mousedown", (ev) => {
                ev.preventDefault();
                pickCity(c);
            });
            suggestCitiesUl.appendChild(li);
        }
        suggestCitiesSec.hidden = cities.length === 0;

        suggestSpotsUl.innerHTML = "";
        for (const e of spots) {
            const li = document.createElement("li");
            li.className = "map-suggest-item";
            const thumb = e.place.heroImageUrl
                ? `<img class="map-suggest-thumb" src="${esc(thumbUrlFor(e.place.heroImageUrl))}" data-fallback="${esc(e.place.heroImageUrl)}" alt="" loading="lazy" onerror="if(this.src!==this.dataset.fallback){this.src=this.dataset.fallback}else{this.outerHTML='<span class=\\'map-suggest-thumb map-suggest-thumb--icon\\'>🍕</span>'}" />`
                : `<span class="map-suggest-thumb map-suggest-thumb--icon" aria-hidden="true">🍕</span>`;
            li.innerHTML = `
                ${thumb}
                <span class="map-suggest-text">
                    <span class="map-suggest-name">${esc(e.place.name)}</span>
                    <span class="map-suggest-meta">${esc([e.place.city, e.place.country].filter(Boolean).join(", "))}</span>
                </span>
            `;
            li.addEventListener("mousedown", (ev) => {
                ev.preventDefault();
                pickSpot(e);
            });
            suggestSpotsUl.appendChild(li);
        }
        suggestSpotsSec.hidden = spots.length === 0;

        suggestEmpty.hidden = !(cities.length === 0 && spots.length === 0);
        showSuggest();
    }

    function pickCity(c) {
        searchInput.value = c.city;
        state.query = c.city;
        searchClear.hidden = false;
        // Fly to bounds of all places in this city. Some imported rows have
        // a correct city/country but a wrong lat/lng (e.g. one Naples, Italy
        // entry that geocoded to Naples, Florida). Drop those outliers using
        // the median of the cluster so a single bad row doesn't blow the
        // bounds open across an ocean.
        const matches = allEntries.filter((e) =>
            e.place.city === c.city && (!c.country || e.place.country === c.country)
        );
        if (matches.length) {
            const latlngs = matches.map((m) => [Number(m.place.lat), Number(m.place.lng)]);
            const sortedLat = [...latlngs.map((p) => p[0])].sort((a, b) => a - b);
            const sortedLng = [...latlngs.map((p) => p[1])].sort((a, b) => a - b);
            const medLat = sortedLat[Math.floor(sortedLat.length / 2)];
            const medLng = sortedLng[Math.floor(sortedLng.length / 2)];
            // Keep points within ~50 km of the cluster median (≈0.5°).
            const MAX_DEG = 0.5;
            const clean = latlngs.filter(([la, ln]) =>
                Math.abs(la - medLat) <= MAX_DEG && Math.abs(ln - medLng) <= MAX_DEG
            );
            const bounds = L.latLngBounds(clean.length ? clean : latlngs);
            map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 14, duration: 0.6 });
        }
        updateSearchCenter();
        hideSuggest();
    }

    function pickSpot(e) {
        searchInput.value = e.place.name;
        state.query = e.place.name;
        searchClear.hidden = false;
        map.setView(e.marker.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
        e.marker.openPopup();
        hideSuggest();
        renderSidebar();
    }

    const onSearchInput = debounce(() => {
        state.query = searchInput.value;
        searchClear.hidden = !state.query;
        updateSearchCenter();
        renderSuggest();
        renderSidebar();
    }, 200);

    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("focus", () => {
        if (state.query) renderSuggest();
    });
    searchInput.addEventListener("blur", () => {
        // Delay so mousedown on a suggestion can fire first.
        setTimeout(hideSuggest, 120);
    });
    searchInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
            hideSuggest();
            searchInput.blur();
        }
    });
    searchClear.addEventListener("click", () => {
        searchInput.value = "";
        state.query = "";
        searchClear.hidden = true;
        state.searchCenter = null;
        hideSuggest();
        renderSidebar();
    });

    sortDropdown.addEventListener("change", (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLInputElement) || t.name !== "map-sort") return;
        state.sort = t.value;
        sortDropdown.open = false;
        renderSidebar();
    });
    document.addEventListener("click", (ev) => {
        if (!sortDropdown.open) return;
        if (!sortDropdown.contains(ev.target)) sortDropdown.open = false;
    });

    zoomOutBtn?.addEventListener("click", () => {
        map.setZoom(Math.max(map.getZoom() - 2, 3));
    });

    map.on("moveend", () => {
        renderSidebar();
    });

    // -- Geolocation default view -------------------------------------------
    function tryGeolocate() {
        return new Promise((resolve) => {
            if (!navigator.geolocation) { resolve(null); return; }
            const timeout = setTimeout(() => resolve(null), 6000);
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    clearTimeout(timeout);
                    resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                },
                () => { clearTimeout(timeout); resolve(null); },
                { enableHighAccuracy: false, timeout: 5000, maximumAge: 5 * 60 * 1000 }
            );
        });
    }

    // -- Mobile bottom sheet -------------------------------------------------
    // Translate-based (GPU-accelerated) bottom sheet. Sheet is fixed height
    // (~85dvh); we slide it up and down via transform: translateY. Snap points
    // are stored as Y-offsets in px (0 = fully expanded, large = collapsed).
    const sheet = (() => {
        const el = document.querySelector(".map-sidebar");
        const handle = document.querySelector(".map-sheet-handle");
        const list = document.querySelector(".map-sidebar-list");
        const COLLAPSED_VISIBLE = 132; // px of sheet showing when collapsed
        const mq = window.matchMedia("(max-width: 900px)");

        // Offsets in px from the fully-expanded position (0). snaps[0] is the
        // largest offset (collapsed = sheet pushed furthest down).
        let snaps = [0, 0, 0];

        function recalc() {
            const sheetH = el.offsetHeight || Math.round(window.innerHeight * 0.85);
            const peekH = Math.round(window.innerHeight * 0.45);
            snaps = [
                Math.max(0, sheetH - COLLAPSED_VISIBLE), // collapsed
                Math.max(0, sheetH - peekH),             // peek
                0,                                        // expanded
            ];
        }
        function setOffset(off) { el.style.setProperty("--sheet-offset", `${off}px`); }
        function snapTo(idx) {
            const i = Math.max(0, Math.min(snaps.length - 1, idx));
            setOffset(snaps[i]);
            el.dataset.snap = String(i);
        }
        function nearest(off) {
            let best = 0, bd = Infinity;
            for (let i = 0; i < snaps.length; i++) {
                const d = Math.abs(snaps[i] - off);
                if (d < bd) { bd = d; best = i; }
            }
            return best;
        }
        function currentOffset() {
            const v = el.style.getPropertyValue("--sheet-offset");
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : snaps[0];
        }

        recalc();
        if (mq.matches) snapTo(0);

        window.addEventListener("resize", () => {
            recalc();
            if (mq.matches) snapTo(Number(el.dataset.snap || 0));
        });

        const DRAG_THRESHOLD = 6;
        let pending = false, dragging = false, fromList = false;
        let startY = 0, startOffset = 0, lastDy = 0, moved = false;
        let rafScheduled = false;

        function isHardOptOut(target) {
            // Form controls, links, dropdown summaries handle their own touch.
            return !!target.closest("input, button, select, textarea, label, summary, a");
        }
        function applyOffset() {
            rafScheduled = false;
            const off = Math.max(0, Math.min(snaps[0], startOffset - lastDy));
            setOffset(off);
        }
        function onDown(ev) {
            if (!mq.matches) return;
            if (isHardOptOut(ev.target)) return;
            pending = true;
            dragging = false;
            moved = false;
            lastDy = 0;
            fromList = !!ev.target.closest(".map-sidebar-list");
            startY = ev.clientY;
            startOffset = currentOffset();
        }
        function onMove(ev) {
            if (!pending && !dragging) return;
            const dy = startY - ev.clientY; // up = positive

            if (!dragging) {
                if (Math.abs(dy) < DRAG_THRESHOLD) return;
                // If the gesture started inside the list, only steal it when:
                //   - list is scrolled to the top, AND
                //   - the user is pulling DOWN (dy < 0, i.e. would close).
                // Otherwise let the list scroll natively.
                if (fromList) {
                    if (list.scrollTop > 0 || dy >= 0) {
                        pending = false;
                        return;
                    }
                }
                dragging = true;
                el.classList.add("is-dragging");
            }
            moved = true;
            lastDy = dy;
            ev.preventDefault();
            if (!rafScheduled) {
                rafScheduled = true;
                requestAnimationFrame(applyOffset);
            }
        }
        function onUp() {
            const wasDragging = dragging;
            pending = false;
            dragging = false;
            fromList = false;
            if (!wasDragging) return;
            el.classList.remove("is-dragging");
            // Settle to the nearest snap based on the most recent visual offset.
            const off = Math.max(0, Math.min(snaps[0], startOffset - lastDy));
            snapTo(nearest(off));
        }
        // Drag listeners attached to the sheet element so pointerdown fires on
        // any descendant via bubbling. We bail in onDown for hard opt-outs.
        el.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        if (handle) {
            handle.addEventListener("click", () => {
                if (!mq.matches || moved) return;
                const cur = Number(el.dataset.snap || 0);
                snapTo(cur === 0 ? 1 : 0);
            });
        }

        mq.addEventListener?.("change", (e) => {
            if (e.matches) snapTo(0);
            else el.style.removeProperty("--sheet-offset");
        });

        return {
            collapse() { if (mq.matches) snapTo(0); },
            peek() { if (mq.matches) snapTo(1); },
            expand() { if (mq.matches) snapTo(2); },
            isMobile: () => mq.matches,
        };
    })();

    // Expand sheet when the user reaches for search; collapse on map tap.
    searchInput.addEventListener("focus", () => sheet.expand());
    map.on("click", () => sheet.collapse());
    map.on("popupopen", () => sheet.collapse());

    // -- Boot ---------------------------------------------------------------
    let places = [];
    try {
        const res = await fetch("/api/places");
        const data = await res.json();
        places = (data && data.places) || [];
    } catch (err) {
        console.error("Failed to load places", err);
    }

    const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

    for (const p of places) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const marker = L.marker([lat, lng], { icon: pizzaIconForZoom(map.getZoom()) });
        marker.bindPopup(popupHtml(p), {
            className: "ppc-popup",
            maxWidth: 300,
            minWidth: 280,
            closeButton: true,
            // Reserve room for the collapsed bottom sheet on mobile so popups
            // don't autoPan behind it.
            autoPanPaddingTopLeft: [16, 16],
            autoPanPaddingBottomRight: [16, 160],
        });
        marker.on("click", () => { if (isMobile()) sheet.collapse(); });
        cluster.addLayer(marker);
        allEntries.push({ place: p, marker });
    }

    buildStyleFilters();

    // Default view: try geoloc, else fit-all-markers.
    const geo = await tryGeolocate();
    if (geo) {
        state.userLoc = geo;
        // Add a "you are here" marker.
        const youIcon = L.divIcon({
            className: "you-are-here",
            html: '<span class="you-are-here-dot"></span>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        });
        L.marker([geo.lat, geo.lng], { icon: youIcon, interactive: false, keyboard: false }).addTo(map);
        map.setView([geo.lat, geo.lng], 13);
        // Sort stays on Popular by default; user can switch to "Near me".
    } else {
        // Default to a Europe-centred view when geolocation is denied or
        // unavailable — most of the data lives there and the world view at
        // zoom 2-3 shows nothing legible.
        map.setView([48, 10], 4);
    }

    rescaleMarkers();
    renderSidebar();
})();
