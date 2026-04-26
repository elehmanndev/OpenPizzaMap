function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect("/auth");
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user || req.session.user.role !== "admin") {
        return res.status(403).send("Forbidden");
    }
    next();
}

module.exports = { requireAuth, requireAdmin };
