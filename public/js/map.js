(async function () {
    const FALLBACK_CENTER = [41.9, 12.5];

    const map = L.map("map", { zoomControl: true, layers: [] }).setView(FALLBACK_CENTER, 5);

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

    L.control.layers(
        { Voyager: voyager, Positron: positron, Satellite: satellite },
        {},
        { position: "topright", collapsed: true }
    ).addTo(map);

    function pizzaIconForZoom(zoom) {
        const minZoom = 3;
        const maxZoom = 18;
        const minSize = 22;
        const maxSize = 56;
        const t = Math.max(0, Math.min(1, (zoom - minZoom) / (maxZoom - minZoom)));
        const size = Math.round(minSize + (maxSize - minSize) * t);
        return L.divIcon({
            className: "pizza-marker",
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

    const allMarkers = [];
    function rescaleMarkers() {
        const icon = pizzaIconForZoom(map.getZoom());
        for (const m of allMarkers) m.setIcon(icon);
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

    function styleLabel(stylesJson) {
        try {
            const arr = JSON.parse(stylesJson || "[]");
            if (!Array.isArray(arr) || !arr.length) return "";
            const pretty = arr[0].replace(/(^|\s)\S/g, (c) => c.toUpperCase());
            return `${pretty} pizza`;
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
        const bits = [styleLabel(p.stylesJson), p.city, priceGlyph(p.priceLevel)].filter(Boolean);
        return bits.join(" · ");
    }

    let regionNames = null;
    try {
        regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {}

    function formatAddress(p) {
        const country = p.country && regionNames ? regionNames.of(p.country) || p.country : p.country;
        const cityLine = [p.postalCode, p.city, p.region].filter(Boolean).join(" ").replace(/\s+/g, " ");
        return [p.addressLine, cityLine, country].filter(Boolean).join(", ");
    }

    function popupHtml(p) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        const directions = p.googleMapsUrl
            ? p.googleMapsUrl
            : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
        const rating = "9.7";
        const heroInner = `<span class="ppc-rating">${rating}</span>`;
        const hero = p.heroImageUrl
            ? `<div class="ppc-hero" style="background-image:url('${esc(p.heroImageUrl)}')">${heroInner}</div>`
            : `<div class="ppc-hero ppc-hero--fallback">${heroInner}<span class="ppc-hero-emoji">🍕</span></div>`;
        const address = formatAddress(p);

        return `
<article class="ppc">
  ${hero}
  <div class="ppc-body">
    <h2 class="ppc-name">${esc(p.name)}</h2>
    <a class="ppc-directions" href="${esc(directions)}" target="_blank" rel="noopener">${esc(address)}</a>
    <p class="ppc-summary">${esc(summaryFor(p))}</p>
    <a class="ppc-cta" href="/place/${p.id}">View profile</a>
  </div>
</article>`.trim();
    }

    try {
        const res = await fetch("/api/places");
        const data = await res.json();
        const places = (data && data.places) || [];

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
            });
            cluster.addLayer(marker);
            allMarkers.push(marker);
        }

        if (places.length) {
            map.fitBounds(cluster.getBounds(), { padding: [48, 48], maxZoom: 16 });
            rescaleMarkers();
        }
    } catch (err) {
        console.error("Failed to load places", err);
    }
})();
