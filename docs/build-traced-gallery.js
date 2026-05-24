// Build a preview HTML gallery showing each traced SVG inside an OPM stamp.
// Reads docs/svg-from-png/*.svg and writes docs/preview-traced-stamps.html.
const fs = require("fs");
const path = require("path");

const svgDir = path.join(__dirname, "svg-from-png");
const out = path.join(__dirname, "preview-traced-stamps.html");

// city + country + ink color per icon file (slug-based)
const cityMap = {
    "alhambra-granada":   { city: "Granada",  country: "España", ink: "ink-2", landmark: "Alhambra" },
    "aqueduct":           { city: "Segovia",  country: "España", ink: "ink-7", landmark: "Roman Aqueduct" },
    "belem-tower":        { city: "Lisboa",   country: "Portugal", ink: "ink-3", landmark: "Belém Tower" },
    "big-ben":            { city: "London",   country: "UK",     ink: "ink-2", landmark: "Big Ben" },
    "brandenburg-gate":   { city: "Berlin",   country: "Deutschland", ink: "ink-7", landmark: "Brandenburg Gate" },
    "colosseum":          { city: "Roma",     country: "Italia", ink: "ink-5", landmark: "Colosseum" },
    "duomo-di-milano":    { city: "Milano",   country: "Italia", ink: "ink-2", landmark: "Duomo di Milano" },
    "eiffel-tower":       { city: "Paris",    country: "France", ink: "ink-2", landmark: "Eiffel Tower" },
    "florence":           { city: "Firenze",  country: "Italia", ink: "ink-3", landmark: "Duomo di Firenze" },
    "giralda":            { city: "Sevilla",  country: "España", ink: "ink-4", landmark: "La Giralda" },
    "gondola":            { city: "Venezia",  country: "Italia", ink: "ink-2", landmark: "Gondola" },
    "mole-antonelliana":  { city: "Torino",   country: "Italia", ink: "ink-8", landmark: "Mole Antonelliana" },
    "parthenon":          { city: "Athina",   country: "Greece", ink: "ink-7", landmark: "Parthenon" },
    "royal-palace":       { city: "Madrid",   country: "España", ink: "ink-8", landmark: "Palacio Real" },
    "temple":             { city: "Pompei",   country: "Italia", ink: "ink-7", landmark: "Roman temple" },
    "volcano":            { city: "Napoli",   country: "Italia", ink: "ink-1", landmark: "Vesuvius" },
    "pisa":               { city: "Pisa",     country: "Italia", ink: "ink-7", landmark: "Torre Pendente" },
    "sagrada-familia":    { city: "Barcelona",country: "España", ink: "ink-4", landmark: "Sagrada Familia" },
    "statue-of-liberty":  { city: "New York", country: "USA",    ink: "ink-5", landmark: "Statue of Liberty" },
};

const tiltDegrees = [-6, 3, -4, 5, -3, 6, -5, 4, -7, 2, -2, 7, -4, 5, -3, 6];

const files = fs.readdirSync(svgDir).filter((f) => f.endsWith(".svg")).sort();
const tiles = files.map((file, i) => {
    const slug = file.replace(/\.svg$/, "");
    const meta = cityMap[slug] || { city: slug, country: "—", ink: "ink-1", landmark: slug };
    const svgRaw = fs.readFileSync(path.join(svgDir, file), "utf8");
    // Strip the XML decl + outer <svg> wrapper attrs; keep inner content.
    // Actually we need to KEEP the outer svg but normalize size/class.
    // Inline the svg as-is — class will be added via attribute injection.
    const inlined = svgRaw
        .replace(/<\?xml[^?]+\?>\s*/, "")
        .replace(/<svg([^>]*?)>/, '<svg$1 class="stamp-png-icon">');
    const tilt = tiltDegrees[i % tiltDegrees.length];
    return `
    <a class="tile" href="#">
      <div class="stamp ${meta.ink}" style="transform: rotate(${tilt}deg);">
        <span class="stamp-city">${meta.city}</span>
        ${inlined}
        <span class="stamp-divider"></span>
        <span class="stamp-country">${meta.country}</span>
      </div>
      <div class="tile-label">${meta.landmark}</div>
      <div class="tile-meta">${file}</div>
    </a>`;
}).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPM stamps · traced from your PNGs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #fafaf7; --line: #e8e6e0; --ink: #1a1a1a; --ink-mute: #888;
    --shadow: 0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: 'Outfit', system-ui, sans-serif;
    background: var(--bg);
    color: var(--ink);
    padding: 28px 16px 60px;
  }
  h1 { text-align: center; font-size: 24px; margin: 0 0 6px; }
  p.lead { text-align: center; color: var(--ink-mute); font-size: 14px; margin: 0 auto 28px; max-width: 720px; }

  .gallery {
    max-width: 1180px; margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  }
  .tile {
    background: white;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 22px 14px 14px;
    text-align: center;
    box-shadow: var(--shadow);
    text-decoration: none;
    color: inherit;
  }
  .stamp {
    width: 152px; height: 152px;
    border-radius: 50%;
    border: 3.5px solid currentColor;
    position: relative;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 10px;
    margin: 0 auto 14px;
    opacity: 0.92;
    filter: contrast(1.05);
  }
  .stamp::before {
    content: ""; position: absolute; inset: 5px;
    border-radius: 50%;
    border: 1.5px solid currentColor; opacity: 0.45;
  }
  .stamp::after {
    content: ""; position: absolute; inset: -7px;
    border-radius: 50%;
    border: 1px dashed currentColor; opacity: 0.18;
  }
  .stamp-city {
    font-size: 14px; font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.1;
    white-space: nowrap;
  }
  .stamp-country {
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    font-weight: 700;
    margin-top: 2px;
    opacity: 0.75;
  }
  .stamp-divider {
    width: 38%;
    border-top: 1px solid currentColor;
    margin: 5px auto 4px;
    opacity: 0.4;
  }
  /* The traced SVG inside the stamp */
  .stamp-png-icon {
    width: 56px !important;
    height: 56px !important;
    margin: 4px 0 2px;
    color: currentColor;
    opacity: 0.92;
  }

  .tile-label { font-size: 13px; font-weight: 600; margin-top: 6px; }
  .tile-meta { font-size: 11px; color: var(--ink-mute); font-family: monospace; margin-top: 2px; }

  .ink-1 { color: #c9483a; }
  .ink-2 { color: #1e3a8a; }
  .ink-3 { color: #2d6e5c; }
  .ink-4 { color: #a8741e; }
  .ink-5 { color: #7b3961; }
  .ink-6 { color: #2d6770; }
  .ink-7 { color: #6b4423; }
  .ink-8 { color: #5f4b8b; }
</style>
</head>
<body>

<h1>OPM stamps · traced from your PNGs</h1>
<p class="lead">
  16 PNGs from <code>docs/source-icons/</code> auto-vectorized via potrace,
  inlined here inside the actual stamp design. Each takes the stamp's ink color
  via <code>currentColor</code>. Same render path that ships in <code>place.ejs</code>.
</p>

<div class="gallery">
${tiles}
</div>

</body>
</html>`;

fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${fs.statSync(out).size} bytes, ${files.length} tiles)`);
