const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
    // Create admin user (local dev)
    const adminEmail = "admin@openpizzamap.local";
    const adminPass = "admin123!ChangeMe";
    const hash = await bcrypt.hash(adminPass, 12);

    await prisma.user.upsert({
        where: { email: adminEmail },
        update: {},
        create: {
            email: adminEmail,
            passwordHash: hash,
            displayName: "Admin",
            role: "admin",
        },
    });

    // 10 sample places (Barcelona-ish coords; edit as needed)
    const samples = [
        {
            name: "Sample Neapolitan 1",
            addressLine: "Carrer de Example 1",
            city: "Barcelona",
            region: "Catalunya",
            postalCode: "08001",
            country: "ES",
            lat: "41.3851000",
            lng: "2.1734000",
            priceLevel: 2,
            stylesJson: JSON.stringify(["neapolitan"]),
            dineIn: true, takeaway: true, delivery: false,
            websiteUrl: null, googleMapsUrl: null, instagramUrl: null,
            status: "active"
        },
        {
            name: "Sample Slice Spot",
            addressLine: "Carrer de Example 2",
            city: "Barcelona",
            region: "Catalunya",
            postalCode: "08002",
            country: "ES",
            lat: "41.3860000",
            lng: "2.1700000",
            priceLevel: 1,
            stylesJson: JSON.stringify(["ny_slice"]),
            dineIn: false, takeaway: true, delivery: true,
            status: "active"
        },
        {
            name: "Sample Roman Pizza",
            addressLine: "Carrer de Example 3",
            city: "Barcelona",
            region: "Catalunya",
            postalCode: "08003",
            country: "ES",
            lat: "41.3880000",
            lng: "2.1770000",
            priceLevel: 2,
            stylesJson: JSON.stringify(["roman"]),
            dineIn: true, takeaway: true, delivery: false,
            status: "active"
        }
    ];

    // pad to 10 with variations
    while (samples.length < 10) {
        const i = samples.length + 1;
        samples.push({
            ...samples[samples.length % 3],
            name: `Sample Place ${i}`,
            addressLine: `Carrer de Example ${i}`,
            lat: (41.3851 + (i * 0.001)).toFixed(7),
            lng: (2.1734 + (i * 0.001)).toFixed(7),
        });
    }

    for (const s of samples) {
        await prisma.place.create({ data: s });
    }

    console.log("Seed complete.");
    console.log("Admin credentials (local only):", adminEmail, adminPass);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
