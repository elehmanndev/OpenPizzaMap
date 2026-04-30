function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect("/auth");
    next();
}

function requireAdmin(req, res, next) {
    if (process.env.DEV_ADMIN_BYPASS === "1") {
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
