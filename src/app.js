const fs = require("fs");
const path = require("path");
const localEnv = path.join(process.cwd(), ".env.local");
const defaultEnv = path.join(process.cwd(), ".env");
const envPath = fs.existsSync(localEnv) ? localEnv : defaultEnv;
require("dotenv").config({ path: envPath, override: envPath === localEnv });
const express = require("express");
const morgan = require("morgan");

const app = express();

const maintenanceMode = String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true";

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
    autoSeed();

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
app.listen(port, () =>
    console.log(
        `OpenPizzaMap running on port ${port}${maintenanceMode ? " (maintenance mode)" : ""}`
    )
);
