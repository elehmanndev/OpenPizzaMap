const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { buildSitemapXml, writeSitemapFiles } = require(path.join(ROOT, "src", "services", "sitemap"));

async function main() {
    const xml = await buildSitemapXml(prisma);
    writeSitemapFiles(xml);
    console.log("Sitemap written to public/sitemap.xml and sitemap.xml");
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
