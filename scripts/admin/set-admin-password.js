const { prisma } = require("../lib/bootstrap");
const bcrypt = require("bcryptjs");

function parseArgs(argv) {
    const args = argv.slice(2);
    const defaultEmail = process.env.ADMIN_EMAIL || "admin@openpizzamap.local";

    if (args.length === 0) return { email: defaultEmail, password: null };
    if (args.length === 1) {
        if (args[0].includes("@")) return { email: args[0], password: null };
        return { email: defaultEmail, password: args[0] };
    }

    if (args[0].includes("@")) return { email: args[0], password: args[1] };
    return { email: defaultEmail, password: args[0] };
}

function printUsage() {
    console.log("Usage:");
    console.log("  node scripts/set-admin-password.js <newPassword>");
    console.log("  node scripts/set-admin-password.js <email> <newPassword>");
}

async function main() {
    const { email, password } = parseArgs(process.argv);
    if (!password) {
        printUsage();
        process.exit(1);
    }

    try {
        const hash = await bcrypt.hash(password, 12);
        await prisma.user.update({
            where: { email },
            data: { passwordHash: hash },
        });
        console.log(`Admin password updated for ${email}`);
    } catch (err) {
        if (err && err.code === "P2025") {
            console.error(`No user found with email ${email}`);
            process.exit(1);
        }
        console.error("Failed to update admin password:", err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

main();
