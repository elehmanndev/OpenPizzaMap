const fs = require("fs");
const path = require("path");

async function buildSitemapXml(prisma, baseUrlOverride) {
    let places = [];
    let cities = [];
    let countries = [];
    try {
        places = await prisma.place.findMany({
            where: { status: "active", isVisible: true },
            select: { id: true, slug: true, updatedAt: true }
        });
    } catch (err) {
        // Keep sitemap generation non-fatal (e.g., build-time DB auth issues).
        console.error("Sitemap place query failed:", err.message || err);
    }

    try {
        cities = await prisma.city.findMany({
            where: { isVisible: true },
            select: { countryCode: true, slug: true, updatedAt: true },
        });
    } catch (err) {
        console.error("Sitemap city query failed:", err.message || err);
    }

    try {
        countries = await prisma.country.findMany({
            where: { isVisible: true },
            select: { code: true, updatedAt: true },
        });
    } catch (err) {
        console.error("Sitemap country query failed:", err.message || err);
    }

    const baseUrl = baseUrlOverride || process.env.BASE_URL || "https://openpizzamap.com";

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/map</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`;

    xml += `
  <url>
    <loc>${baseUrl}/about</loc>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>
  <url>
    <loc>${baseUrl}/faq</loc>
    <changefreq>monthly</changefreq>
    <priority>0.4</priority>
  </url>`;

    countries.forEach((c) => {
        xml += `
  <url>
    <loc>${baseUrl}/country/${c.code}</loc>
    <lastmod>${c.updatedAt.toISOString().split("T")[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
    });

    cities.forEach((c) => {
        xml += `
  <url>
    <loc>${baseUrl}/country/${c.countryCode}/city/${c.slug}</loc>
    <lastmod>${c.updatedAt.toISOString().split("T")[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
    });

    places.forEach(place => {
        xml += `
  <url>
    <loc>${baseUrl}/place/${place.id}${place.slug ? '/' + place.slug : ''}</loc>
    <lastmod>${place.updatedAt.toISOString().split("T")[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
    });

    xml += "\n</urlset>";
    return xml;
}

function writeSitemapFiles(xml) {
    const publicPath = path.join(process.cwd(), "public", "sitemap.xml");
    const rootPath = path.join(process.cwd(), "sitemap.xml");
    fs.writeFileSync(publicPath, xml, "utf8");
    fs.writeFileSync(rootPath, xml, "utf8");
}

module.exports = { buildSitemapXml, writeSitemapFiles };
