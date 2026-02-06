const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function pickFirstName(displayName, email) {
    const raw = String(displayName || "").trim();
    if (raw) {
        const camel = raw.match(/[A-Z][a-z]*/);
        if (camel && camel[0]) return camel[0].slice(0, 32);
        const spaced = raw.split(/\s+/)[0];
        if (spaced) return spaced.slice(0, 32);
    }
    if (email && email.includes("@")) {
        return email.split("@")[0].split(/[._-]/)[0].slice(0, 32);
    }
    return "pizza";
}

function normalizeUsername(raw) {
    const cleaned = String(raw || "")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 20);
    if (cleaned.length >= 3) return cleaned;
    return "";
}

async function ensureUniqueUsername(base, userId) {
    const maxLength = 20;
    let candidate = base;
    for (let i = 0; i < 50; i += 1) {
        if (!candidate) break;
        const exists = await prisma.user.findFirst({
            where: {
                username: candidate,
                NOT: { id: userId },
            },
            select: { id: true },
        });
        if (!exists) return candidate;
        const suffix = `_${i + 1}`;
        const trimmed = base.slice(0, Math.max(3, maxLength - suffix.length));
        candidate = `${trimmed}${suffix}`;
    }
    const fallback = `pizza_${Date.now().toString().slice(-5)}`;
    return fallback.slice(0, maxLength);
}

async function main() {
    const users = await prisma.user.findMany({
        select: { id: true, email: true, displayName: true, username: true, googleId: true },
    });

    for (const user of users) {
        const updates = {};

        if (!user.username) {
            const baseName = pickFirstName(user.displayName, user.email);
            const base = normalizeUsername(baseName) || normalizeUsername(user.email);
            updates.username = await ensureUniqueUsername(base || "pizza", user.id);
        }

        if (user.googleId) {
            const firstName = pickFirstName(user.displayName, user.email);
            if (firstName && firstName !== user.displayName) {
                updates.displayName = firstName;
            }
        }

        if (Object.keys(updates).length) {
            await prisma.user.update({
                where: { id: user.id },
                data: updates,
            });
            console.log("Updated user", user.id, updates);
        }
    }
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
