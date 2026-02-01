function errorHandler(err, req, res, next) {
    console.error(err);
    if (req.path.startsWith("/api/")) {
        return res.status(500).json({ ok: false, error: "Internal Server Error" });
    }
    res.status(500).send("Internal Server Error");
}

module.exports = { errorHandler };
