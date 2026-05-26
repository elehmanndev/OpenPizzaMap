#!/usr/bin/env node
// One-shot probe: hit TA Content API /location/{id}/details for ONE
// place and print every top-level field, so we can see if review
// snippets are embedded (free) vs requiring the gated /reviews
// endpoint (403 on the current free tier).
//
// Run on opm-runner Docker container:
//   docker exec opm-runner node scripts/admin/probe-ta-details.js

const { prisma } = require("../lib/bootstrap");

async function main() {
    const apiKey = process.env.TRIPADVISOR_API_KEY;
    if (!apiKey) {
        console.error("TRIPADVISOR_API_KEY not set");
        process.exit(1);
    }

    // Pick the first visible place with a TA id, so the probe targets
    // a real venue we already index.
    const place = await prisma.place.findFirst({
        where: { isVisible: true, tripadvisorLocationId: { not: null } },
        select: { id: true, name: true, tripadvisorLocationId: true },
        orderBy: { id: "asc" },
    });
    if (!place) {
        console.error("no place with tripadvisorLocationId");
        process.exit(1);
    }

    const url = `https://api.content.tripadvisor.com/api/v1/location/${place.tripadvisorLocationId}/details?key=${apiKey}&language=en`;
    console.log(`Probing ${place.name} (#${place.id}, TA loc ${place.tripadvisorLocationId})`);
    console.log(`URL: ${url.replace(apiKey, "***")}`);
    console.log("");

    // TA's free Content API gates by Referer header — must match the
    // registered domain on the API key. Without it, /details returns 403.
    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            Referer: "https://www.openpizzamap.com/",
        },
    });
    console.log(`HTTP ${res.status}`);
    const body = await res.text();
    if (!res.ok) {
        console.log("body:", body.slice(0, 400));
        process.exit(1);
    }

    const j = JSON.parse(body);
    console.log("Top-level fields:");
    for (const key of Object.keys(j).sort()) {
        const v = j[key];
        const summary = Array.isArray(v)
            ? `array[${v.length}]`
            : v && typeof v === "object"
            ? `object{${Object.keys(v).slice(0, 6).join(",")}}`
            : typeof v === "string"
            ? `"${v.slice(0, 60)}${v.length > 60 ? "…" : ""}"`
            : String(v);
        console.log(`  ${key}: ${summary}`);
    }

    // Hunt for anything review-shaped.
    const reviewKeys = Object.keys(j).filter((k) => /review|comment|quote/i.test(k));
    if (reviewKeys.length) {
        console.log("");
        console.log("Review-shaped fields (full content):");
        for (const k of reviewKeys) {
            console.log(`\n  ${k}:`);
            console.log(JSON.stringify(j[k], null, 2).split("\n").map((l) => "    " + l).join("\n"));
        }
    } else {
        console.log("");
        console.log("No review-shaped keys found in details response.");
    }

    await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
