const fs = require("fs");
const path = require("path");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
require("dotenv").config({ path: fs.existsSync(localEnv) ? localEnv : defaultEnv });

const { buildSitemapXml, writeSitemapFiles } = require("../src/services/sitemap");
const { prisma } = require("../src/db");

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
