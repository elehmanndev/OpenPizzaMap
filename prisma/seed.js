const fs = require("fs");
const path = require("path");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
require("dotenv").config({ path: fs.existsSync(localEnv) ? localEnv : defaultEnv });

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
    // No admin user is seeded. Auth is Google-only — a row with a
    // pre-baked passwordHash can never sign in. To grant admin to a
    // real Google user, sign in once to create the row, then run a
    // one-off `UPDATE User SET role = 'admin' WHERE email = ...`.

    // No place rows are seeded. The map is populated by curated
    // scrapers (scripts/scrapers/) and user submissions (/add-your-spot).
    console.log("Seed complete (no-op — places come from scrapers + intake).");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
