(async function () {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query") || "";
    const city = params.get("city") || "";
    const radius = params.get("radius") || "5";

    const map = L.map("map").setView([41.3851, 2.1734], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    const listEl = document.getElementById("results");

    function renderList(places) {
        listEl.innerHTML = "";
        if (!places.length) {
            listEl.innerHTML = "<p>No results.</p>";
            return;
        }
        for (const p of places) {
            const div = document.createElement("div");
            div.className = "card";
            const dist = (p.distance_km != null) ? ` · ${p.distance_km.toFixed(2)} km` : "";
            div.innerHTML = `<a href="/place/${p.id}"><strong>${p.name}</strong></a><div>${p.city}${dist}</div>`;
            listEl.appendChild(div);
        }
    }

    function addMarkers(places) {
        for (const p of places) {
            const marker = L.marker([Number(p.lat), Number(p.lng)]).addTo(map);
            marker.bindPopup(`<a href="/place/${p.id}">${p.name}</a>`);
        }
    }

    async function fetchAndRender(url) {
        const res = await fetch(url);
        const data = await res.json();
        const places = data.places || [];
        renderList(places);
        addMarkers(places);

        if (places.length) {
            const first = places[0];
            map.setView([Number(first.lat), Number(first.lng)], 13);
        }
    }

    document.getElementById("searchForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const q = document.getElementById("q").value.trim();
        const c = document.getElementById("c").value.trim();
        window.location.href = `/map?query=${encodeURIComponent(q)}&city=${encodeURIComponent(c)}`;
    });

    document.getElementById("nearMe").addEventListener("click", async () => {
        if (!navigator.geolocation) return alert("Geolocation not supported");
        navigator.geolocation.getCurrentPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            window.location.href = `/map?lat=${latitude}&lng=${longitude}&radius=${encodeURIComponent(radius)}`;
        }, () => alert("Could not get location"));
    });

    // initial load
    if (params.get("lat") && params.get("lng")) {
        const lat = params.get("lat");
        const lng = params.get("lng");
        await fetchAndRender(`/api/places?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=${encodeURIComponent(radius)}`);
    } else {
        await fetchAndRender(`/api/places?query=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}`);
    }
})();
