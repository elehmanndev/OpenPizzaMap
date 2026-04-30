function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect("/auth");
    next();
}

// DEV_ADMIN_BYPASS lets the dev box skip the OAuth round-trip while iterating
// on admin pages. It MUST NEVER take effect in production — anyone setting it
// (or having it leak into the Hostinger env by mistake) would otherwise get a
// silent admin grant. Hard-gate on NODE_ENV.
const ALLOW_DEV_BYPASS =
    process.env.DEV_ADMIN_BYPASS === "1" && process.env.NODE_ENV !== "production";
if (process.env.DEV_ADMIN_BYPASS === "1" && process.env.NODE_ENV === "production") {
    console.warn("[auth] DEV_ADMIN_BYPASS=1 ignored in production");
}

function requireAdmin(req, res, next) {
    if (ALLOW_DEV_BYPASS) {
        if (!req.session.user) {
            req.session.user = { id: 0, email: "dev@local", username: "dev", role: "admin" };
        }
        return next();
    }
    if (!req.session || !req.session.user || req.session.user.role !== "admin") {
        return res.status(403).send("Forbidden");
    }
    next();
}

module.exports = { requireAuth, requireAdmin };
