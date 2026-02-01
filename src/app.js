require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");

const pages = require("./routes/pages");
const apiAuth = require("./routes/api.auth");
const apiPlaces = require("./routes/api.places");
const apiSubmissions = require("./routes/api.submissions");
const apiAdmin = require("./routes/api.admin");
const { errorHandler } = require("./middleware/error");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(morgan("dev"));
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

app.use("/public", express.static(path.join(__dirname, "..", "public")));

app.use("/", pages);
app.use("/api/auth", apiAuth);
app.use("/api/places", apiPlaces);
app.use("/api/submissions", apiSubmissions);
app.use("/api/admin", apiAdmin);

app.use(errorHandler);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`OpenPizzaMap running on port ${port}`));
