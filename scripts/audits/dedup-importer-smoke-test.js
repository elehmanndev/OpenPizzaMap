#!/usr/bin/env node
// Smoke-test the new normalize+haversine dedup fallback in
// scripts/import-places.js without actually running the importer.
//
// Replays the lookup logic against the live DB:
//   1. Starita case — searching for "Starita a Materdei" at the
//      Naples coords should resolve to id=180 ("Pizzeria Starita a
//      Materdei"), proving the slug-miss is now caught.
//   2. Inverse — searching with the prefixed name should also find
//      it, regardless of order.
//   3. Negative — a fake new place 1 km away from Starita with a
//      novel name should NOT match, proving we didn't make the
//      fallback so loose it merges unrelated rows.
//
// All read-only — no writes. Run via:
//   node scripts/dedup-importer-smoke-test.js

const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { boundingBox, haversineKm } = require(path.join(ROOT, "src", "services", "geo"));

const NAME_PREFIX_RE = /^(pizzeria|pizzaria|antica|the|le|la|il|el|los|las|\d+\s+|–|—|-)\s*/i;
function normalizeName(name) {
    let s = String(name || "")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    for (let i = 0; i < 5; i++) {
        const next = s.replace(NAME_PREFIX_RE, "").trim();
        if (next === s) break;
        s = next;
    }
    return s;
}

async function lookup(candidate) {
    const candidateNorm = normalizeName(candidate.name);
    const box = boundingBox(candidate.lat, candidate.lng, 0.2);
    const nearby = await prisma.place.findMany({
        where: {
            country: candidate.country,
            lat: { gte: box.minLat, lte: box.maxLat },
            lng: { gte: box.minLng, lte: box.maxLng },
        },
        select: { id: true, name: true, slug: true, lat: true, lng: true },
    });
    for (const row of nearby) {
        if (normalizeName(row.name) !== candidateNorm) continue;
        if (haversineKm(Number(row.lat), Number(row.lng), candidate.lat, candidate.lng) > 0.2) continue;
        return row;
    }
    return null;
}

async function main() {
    const cases = [
        // Starita case — drop the prefix on the way in. Should hit id=180.
        {
            label: "Starita without prefix",
            input: { name: "Starita a Materdei", country: "Italy", lat: 40.8560381, lng: 14.2470107 },
            expectId: 180,
        },
        // Starita inverse — prefix on the way in, prefixed row in DB. Should also hit id=180.
        {
            label: "Starita with prefix (sanity)",
            input: { name: "Pizzeria Starita a Materdei", country: "Italy", lat: 40.8560381, lng: 14.2470107 },
            expectId: 180,
        },
        // Numeric prefix — id 1673 ("10 Diego Vitagliano Pizzeria") was hidden in
        // task 1, but id 1338 ("Diego Vitagliano Pizzeria") is still visible. Drop
        // the leading "10 " and we should land on 1338.
        {
            label: "Diego Vitagliano numeric prefix strip",
            input: { name: "10 Diego Vitagliano Pizzeria", country: "Italy", lat: 40.8170586, lng: 14.175748 },
            expectId: 1338,
        },
        // Negative case — a totally novel name at the same coords should NOT
        // match an existing row. Same coords as Starita but different name.
        {
            label: "Novel name at same coords (must not match)",
            input: { name: "Mariano's Brand New Pizza Joint", country: "Italy", lat: 40.8560381, lng: 14.2470107 },
            expectId: null,
        },
        // Negative case 2 — same Starita name 1 km away. Must not match
        // (different lat/lng).
        {
            label: "Starita name 1 km away (must not match)",
            input: { name: "Starita a Materdei", country: "Italy", lat: 40.8470, lng: 14.2470107 },
            expectId: null,
        },
    ];

    let pass = 0, fail = 0;
    for (const c of cases) {
        const hit = await lookup(c.input);
        const got = hit ? hit.id : null;
        const ok = got === c.expectId;
        if (ok) pass++; else fail++;
        const verdict = ok ? "PASS" : "FAIL";
        console.log(`[${verdict}] ${c.label}`);
        console.log(`        input: name="${c.input.name}" coords=(${c.input.lat}, ${c.input.lng}) country=${c.input.country}`);
        console.log(`        expect id=${c.expectId}  got id=${got}${hit ? ` ("${hit.name}")` : ""}`);
    }
    console.log(`\n${pass}/${cases.length} pass, ${fail} fail.`);
    process.exit(fail ? 1 : 0);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
