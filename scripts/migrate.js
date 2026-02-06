const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { spawnSync } = require("child_process");

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

const result = spawnSync(
    process.execPath,
    ["node_modules/.bin/prisma", "migrate", "deploy"],
    {
        stdio: "inherit",
        env: process.env,
    }
);

if (result.status !== 0) {
    console.error("Prisma migrate deploy failed.");
    if (String(process.env.MIGRATE_STRICT || "").toLowerCase() === "true") {
        process.exit(result.status || 1);
    }
}
