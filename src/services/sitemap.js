const fs = require("fs");
const path = require("path");

async function buildSitemapXml(prisma, baseUrlOverride) {
    const places = await prisma.place.findMany({
        where: { status: "active" },
        select: { id: true, updatedAt: true }
    });

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

    places.forEach(place => {
        xml += `
  <url>
    <loc>${baseUrl}/place/${place.id}</loc>
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
