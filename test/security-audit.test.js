const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const authSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/api.auth.js"), "utf8");
const appSource = fs.readFileSync(path.resolve(__dirname, "../src/app.js"), "utf8");
const setPasswordView = fs.readFileSync(path.resolve(__dirname, "../src/views/set_password.ejs"), "utf8");

test("auth routes are rate limited", () => {
    const routes = ["/register", "/login", "/forgot", "/reset", "/set-password"];
    routes.forEach((route) => {
        const pattern = new RegExp(`router\\.post\\(\"${route.replace("/", "\\/")}\",\\s*authLimiter`);
        assert.match(authSource, pattern);
    });
});

test("password policy requires letters and numbers", () => {
    const marker = "(?=.*[A-Za-z])(?=.*\\d)";
    const occurrences = authSource.split(marker).length - 1;
    assert.ok(occurrences >= 3);
});

test("session cookies are httpOnly and sameSite", () => {
    assert.match(appSource, /httpOnly:\s*true/);
    assert.match(appSource, /sameSite:\s*"lax"/);
});

test("set-password email field is read-only", () => {
    assert.match(setPasswordView, /name="email"[^>]*readonly/);
});
