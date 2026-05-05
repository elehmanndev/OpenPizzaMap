const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { recomputeAllCityCountryVisibility } = require(path.join(ROOT, "src", "services", "landingAutoCreate"));

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
