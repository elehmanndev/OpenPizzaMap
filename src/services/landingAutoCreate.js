const { prisma } = require("../db");
const { slugify } = require("./slugify");

function normalizeKey(input) {
    return String(input || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

async function ensureCountry({ code }) {
    const upper = String(code || "").trim().toUpperCase();
    if (!upper || upper.length !== 2) return null;
    return prisma.country.upsert({
        where: { code: upper },
        update: {},
        create: { code: upper, isVisible: false },
    });
}

async function findOrCreateCity({ name, countryCode }) {
    const cc = String(countryCode || "").trim().toUpperCase();
    const displayName = String(name || "").trim();
    if (!displayName || !cc || cc.length !== 2) return null;

    const baseSlug = slugify(displayName) || "city";
    let candidate = baseSlug;

    for (let i = 0; i < 25; i++) {
        const existing = await prisma.city.findUnique({
            where: { countryCode_slug: { countryCode: cc, slug: candidate } },
        });
        if (!existing) {
            return prisma.city.create({
                data: {
                    name: displayName,
                    slug: candidate,
                    countryCode: cc,
                    isVisible: false,
                },
            });
        }

        // If the slug exists, attempt to treat it as the same city by name normalization.
        if (normalizeKey(existing.name) === normalizeKey(displayName)) {
            return existing;
        }

        candidate = `${baseSlug}-${i + 2}`;
    }

    // Extremely unlikely; fall back to the existing base slug record.
    return prisma.city.findUnique({
        where: { countryCode_slug: { countryCode: cc, slug: baseSlug } },
    });
}

async function recomputeCityVisibility({ cityId }) {
    const city = await prisma.city.findUnique({ where: { id: cityId } });
    if (!city) return;

    const count = await prisma.place.count({
        where: {
            country: city.countryCode,
            OR: [
                { cityId: city.id },
                // Back-compat for places created before we started attaching cityId.
                { cityId: null, city: city.name },
            ],
            status: "active",
            isVisible: true,
        },
    });

    if (count >= 6 && !city.isVisible) {
        await prisma.city.update({ where: { id: city.id }, data: { isVisible: true } });
    }
}

async function recomputeCountryVisibility({ countryCode }) {
    const cc = String(countryCode || "").trim().toUpperCase();
    if (!cc || cc.length !== 2) return;

    const country = await prisma.country.findUnique({ where: { code: cc } });
    if (!country) return;

    const visibleCities = await prisma.city.count({
        where: { countryCode: cc, isVisible: true },
    });

    if (visibleCities >= 5 && !country.isVisible) {
        await prisma.country.update({ where: { code: cc }, data: { isVisible: true } });
    }
}

async function ensureCityCountryAfterPlaceApproved(place) {
    if (!place) return;

    const country = await ensureCountry({ code: place.country });
    const city = await findOrCreateCity({ name: place.city, countryCode: place.country });
    if (city && !place.cityId) {
        await prisma.place.update({ where: { id: place.id }, data: { cityId: city.id } });
        place.cityId = city.id;
    }

    if (city) {
        await recomputeCityVisibility({ cityId: city.id });
    }
    if (country) {
        await recomputeCountryVisibility({ countryCode: country.code });
    }
}

async function recomputeAllCityCountryVisibility() {
    // Ensures Country + City rows exist for all places, then recomputes visibility thresholds.
    const places = await prisma.place.findMany({
        select: { id: true, city: true, country: true, cityId: true },
        where: { status: "active", isVisible: true },
    });

    // Create missing Countries and Cities and attach cityId.
    for (const p of places) {
        await ensureCountry({ code: p.country });
        const city = await findOrCreateCity({ name: p.city, countryCode: p.country });
        if (city && !p.cityId) {
            await prisma.place.update({ where: { id: p.id }, data: { cityId: city.id } });
        }
    }

    // Recompute city visibility.
    const cities = await prisma.city.findMany({ select: { id: true } });
    for (const c of cities) {
        await recomputeCityVisibility({ cityId: c.id });
    }

    // Recompute country visibility.
    const countries = await prisma.country.findMany({ select: { code: true } });
    for (const c of countries) {
        await recomputeCountryVisibility({ countryCode: c.code });
    }
}

module.exports = {
    ensureCityCountryAfterPlaceApproved,
    recomputeAllCityCountryVisibility,
};
