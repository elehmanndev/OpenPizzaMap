const fs = require("fs");
const path = require("path");
const hostingerEnv = path.join(process.cwd(), ".builds", "config", ".env");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
const envPath = fs.existsSync(hostingerEnv)
    ? hostingerEnv
    : (fs.existsSync(localEnv) ? localEnv : defaultEnv);
require("dotenv").config({
    path: envPath,
    override: envPath === localEnv || envPath === hostingerEnv
});
console.log(
    `Startup env: NODE_ENV=${process.env.NODE_ENV || "unset"} DATABASE_URL=${process.env.DATABASE_URL ? "set" : "unset"} BASE_URL=${process.env.BASE_URL ? "set" : "unset"}`
);
const express = require("express");
const morgan = require("morgan");

const app = express();

// Cache-bust static assets with a single version string. Scan only the asset
// dirs that ship with the app — never `uploads/`, which holds 1k+ user images
// and would burn IOPS on every worker boot under shared hosting.
const publicRoot = path.join(__dirname, "..", "public");
const assetScanDirs = ["css", "js", "assets"];
function getLatestMtimeMs(dir) {
    let latest = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            latest = Math.max(latest, getLatestMtimeMs(fullPath));
            continue;
        }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(fullPath);
        latest = Math.max(latest, stat.mtimeMs);
    }
    return latest;
}
let assetVersion = String(process.env.ASSET_VERSION || "");
if (!assetVersion) {
    try {
        let latest = 0;
        for (const sub of assetScanDirs) {
            const subPath = path.join(publicRoot, sub);
            if (fs.existsSync(subPath)) {
                latest = Math.max(latest, getLatestMtimeMs(subPath));
            }
        }
        assetVersion = latest ? String(Math.floor(latest)) : String(Date.now());
    } catch (err) {
        console.warn("Could not compute public asset version:", err && err.message ? err.message : err);
        assetVersion = String(Date.now());
    }
}
app.locals.assetVersion = assetVersion;
app.locals.asset = function asset(url) {
    if (typeof url !== "string") return url;
    if (/^https?:\/\//i.test(url) || url.startsWith("//")) return url;
    const parts = url.split("?");
    const base = parts[0];
    const query = parts.slice(1).join("?");
    const sep = query ? "&" : "?";
    return base + (query ? `?${query}` : "") + `${sep}v=${encodeURIComponent(assetVersion)}`;
};

const { escapeHtml, escapeAttr } = require("./services/escape");
app.locals.escapeHtml = escapeHtml;
app.locals.escapeAttr = escapeAttr;

const maintenanceMode = String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true";
let postListenTasks = () => {};

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Block common bot scans early (before any middleware/routes).
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    const allowedApiPrefixes = ["/api/auth", "/api/notify", "/api/places", "/api/submissions", "/api/admin"];
    const blockedPrefixes = [
        "/wp-",
        "/wp/",
        "/wp-admin",
        "/wp-login",
        "/wordpress",
        "/xmlrpc.php",
        "/cgi-bin",
        "/.env",
        "/.git",
        "/.svn",
        "/.hg",
        "/vendor/",
        "/wap/",
        "/client/",
        "/ajax/",
        "/public/mobile/",
    ];
    const blockedExtensions = [".php", ".asp", ".aspx", ".jsp", ".cgi", ".ashx", ".asmx"];

    if (p.startsWith("/api/") && !allowedApiPrefixes.some((prefix) => p.startsWith(prefix))) {
        res.set("Cache-Control", "public, max-age=3600");
        return res.status(404).end();
    }

    if (blockedPrefixes.some((prefix) => p.startsWith(prefix))) {
        res.set("Cache-Control", "public, max-age=3600");
        return res.status(404).end();
    }

    if (blockedExtensions.some((ext) => p.endsWith(ext))) {
        res.set("Cache-Control", "public, max-age=3600");
        return res.status(404).end();
    }

    next();
});

// In production keep request logging quiet — Passenger captures stdout to
// disk, which adds writes per request. Skip 2xx/3xx noise.
if (process.env.NODE_ENV === "production") {
    app.use(morgan("combined", {
        skip: (req, res) => res.statusCode < 400,
    }));
} else {
    app.use(morgan("dev"));
}
const staticOpts = { maxAge: "30d", immutable: true, etag: true };
app.use("/public", express.static(path.join(__dirname, "..", "public"), staticOpts));
app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads"), staticOpts));

if (maintenanceMode) {
    // Maintenance-only mode: serve the maintenance page for all routes/methods.
    app.use((req, res) => {
        res.status(503);
        res.set("Retry-After", "3600");
        res.render("maintenance");
    });
} else {
    const session = require("express-session");
    const { PrismaSessionStore } = require("@quixo3/prisma-session-store");
    const cookieParser = require("cookie-parser");

    const pages = require("./routes/pages");
    const apiAuth = require("./routes/api.auth");
    const apiNotify = require("./routes/api.notify");
    const apiPlaces = require("./routes/api.places");
    const apiSubmissions = require("./routes/api.submissions");
    const apiAdmin = require("./routes/api.admin");
    const { errorHandler } = require("./middleware/error");
    const { requireApiKey } = require("./middleware/apiKey");
    const { prisma } = require("./db");
    const passport = require("passport");
    const { configureGoogleAuth } = require("./services/googleAuth");

    // Auto-seed if empty (Hostinger helper)
    let autoSeedScheduled = false;
    async function autoSeed() {
        try {
            const count = await prisma.place.count();
            if (count === 0) {
                console.log("Database empty, running auto-seed...");
                const { execSync } = require("child_process");
                execSync("node prisma/seed.js", { stdio: "inherit" });
            }
        } catch (e) {
            console.error("Auto-seed skipped/failed:", e.message);
            // We don't crash the app here, just log it.
        }
    }
    postListenTasks = () => {
        if (autoSeedScheduled) return;
        if (String(process.env.AUTO_SEED || "true").toLowerCase() === "false") {
            console.log("Auto-seed disabled via AUTO_SEED=false");
            return;
        }
        autoSeedScheduled = true;
        const delayMs = Number(process.env.AUTO_SEED_DELAY_MS || 3000);
        setTimeout(() => {
            autoSeed().catch((e) => {
                console.error("Auto-seed failed:", e && e.message ? e.message : e);
            });
        }, Number.isFinite(delayMs) ? delayMs : 3000);
    };

    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(cookieParser());

    app.use(
        session({
            name: "opm.sid",
            secret: process.env.SESSION_SECRET || "dev-secret-change-me",
            resave: false,
            saveUninitialized: false,
            store: new PrismaSessionStore(prisma, {
                checkPeriod: 10 * 60 * 1000,
                dbRecordIdIsSessionId: true,
            }),
            cookie: {
                httpOnly: true,
                sameSite: "lax",
                secure: false // set true behind HTTPS in production if possible
            },
        })
    );
    configureGoogleAuth();
    app.use(passport.initialize());

    app.use("/", pages);
    app.use("/api/auth", apiAuth);
    app.use("/api/notify", apiNotify);
    app.use("/api/places", apiPlaces);
    app.use("/api/submissions", apiSubmissions);
    app.use("/api/admin", requireApiKey({ envKey: "ADMIN_API_KEYS" }), apiAdmin);

    app.use((req, res) => {
        if (req.path && req.path.startsWith("/api/")) {
            return res.status(404).json({ ok: false, error: "Not Found" });
        }
        const notFoundPath = path.join(__dirname, "..", "public", "404.html");
        res.set("Cache-Control", "no-store");
        return res.status(404).sendFile(notFoundPath, (err) => {
            if (err) {
                res.status(404).send("Not Found");
            }
        });
    });

    app.use(errorHandler);
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(
        `OpenPizzaMap running on port ${port}${maintenanceMode ? " (maintenance mode)" : ""}`
    );
    postListenTasks();
});
