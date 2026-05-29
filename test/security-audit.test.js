const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const authSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/api.auth.js"), "utf8");
const appSource = fs.readFileSync(path.resolve(__dirname, "../src/app.js"), "utf8");
const pagesSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/pages.js"), "utf8");

test("session cookies are httpOnly and sameSite", () => {
    assert.match(appSource, /httpOnly:\s*true/);
    assert.match(appSource, /sameSite:\s*"lax"/);
});

test("session cookie is auto-secured in production", () => {
    assert.match(appSource, /secure:\s*isProd/);
});

test("account-mutating auth route is rate limited", () => {
    // Auth is Google-only; the one state-changing POST that isn't OAuth
    // (claiming a username) must sit behind the auth rate limiter.
    assert.match(authSource, /router\.post\("\/set-username",\s*authLimiter/);
});

test("Google OAuth endpoints refuse to run when unconfigured", () => {
    // Both the kickoff and callback must guard on isGoogleAuthConfigured()
    // so a misconfigured deploy fails closed instead of half-authenticating.
    const guards = authSource.split("isGoogleAuthConfigured()").length - 1;
    assert.ok(guards >= 2, "expected /google and /google/callback to both guard on config");
});

test("returnTo redirect is restricted to same-origin paths", () => {
    // safeReturnTo must reject protocol-relative ("//evil.com") and absolute
    // URLs to block open redirects through the OAuth round-trip.
    assert.match(authSource, /value\.startsWith\("\/\/"\)/);
    assert.match(authSource, /!value\.startsWith\("\/"\)/);
});

test("legacy password-auth routes are retired, not handled", () => {
    // Password auth was removed in favour of Google-only sign-in. The old
    // GET routes should now redirect to /auth, and no password-based POST
    // handlers (login/register/forgot/reset) should exist.
    assert.match(pagesSource, /"\/login",\s*"\/register",\s*"\/forgot",\s*"\/reset",\s*"\/set-password"/);
    for (const route of ["/login", "/register", "/forgot", "/reset"]) {
        assert.doesNotMatch(
            authSource,
            new RegExp(`router\\.post\\("${route}"`),
            `unexpected password-auth handler for ${route}`,
        );
    }
});
