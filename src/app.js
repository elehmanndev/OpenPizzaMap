const fs = require("fs");
const path = require("path");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
const envPath = fs.existsSync(localEnv) ? localEnv : defaultEnv;
require("dotenv").config({ path: envPath, override: envPath === localEnv });
console.log(
    `Startup env: NODE_ENV=${process.env.NODE_ENV || "unset"} DATABASE_URL=${process.env.DATABASE_URL ? "set" : "unset"} BASE_URL=${process.env.BASE_URL ? "set" : "unset"}`
);
const express = require("express");
const morgan = require("morgan");

const app = express();

const maintenanceMode = String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true";
let postListenTasks = () => {};

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "..", "public")));

if (maintenanceMode) {
    // Maintenance-only mode: serve the maintenance page for all routes/methods.
    app.use((req, res) => {
        res.status(503);
        res.set("Retry-After", "3600");
        res.render("maintenance");
    });
} else {
    const session = require("express-session");
    const cookieParser = require("cookie-parser");

    const pages = require("./routes/pages");
    const apiAuth = require("./routes/api.auth");
    const apiPlaces = require("./routes/api.places");
    const apiSubmissions = require("./routes/api.submissions");
    const apiAdmin = require("./routes/api.admin");
    const { errorHandler } = require("./middleware/error");
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
    app.use("/api/places", apiPlaces);
    app.use("/api/submissions", apiSubmissions);
    app.use("/api/admin", apiAdmin);

    app.use(errorHandler);
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
    console.log(
        `OpenPizzaMap running on port ${port}${maintenanceMode ? " (maintenance mode)" : ""}`
    );
    postListenTasks();
});
