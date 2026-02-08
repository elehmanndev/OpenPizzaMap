const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const hostingerEnv = path.join(process.cwd(), ".builds", "config", ".env");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
const envPath = fs.existsSync(hostingerEnv)
    ? hostingerEnv
    : (fs.existsSync(localEnv) ? localEnv : defaultEnv);

dotenv.config({
    path: envPath,
    override: envPath === localEnv || envPath === hostingerEnv,
});

const { prisma } = require("../src/db");
const { recomputeAllCityCountryVisibility } = require("../src/services/landingAutoCreate");

async function main() {
    await recomputeAllCityCountryVisibility();
    console.log("Recomputed city/country visibility.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

