// Centralised error handler. With express-async-errors loaded in app.js, any
// thrown error or rejected promise inside a route handler reaches this
// function instead of becoming an unhandled rejection that takes the worker
// down.
//
// Categorise common Prisma errors so prod logs are useful and the response
// status reflects the cause (DB unreachable → 503; bad input → 400; everything
// else → 500). On 5xx we also log a structured one-liner that's easy to grep
// in stderr.log.
function errorHandler(err, req, res, next) {
    const code = err && err.code;
    const isPrismaInit =
        err &&
        (err.name === "PrismaClientInitializationError" ||
            code === "P1001" ||
            code === "P1002" ||
            code === "P1008" ||
            code === "P1017");
    const isPrismaValidation =
        err &&
        (err.name === "PrismaClientValidationError" ||
            code === "P2025" || // record not found
            code === "P2002");  // unique constraint
    const isJsonBody = err && err.type === "entity.parse.failed";

    let status = 500;
    let publicMessage = "Internal Server Error";
    if (isPrismaInit) {
        status = 503;
        publicMessage = "Database temporarily unavailable";
    } else if (isPrismaValidation || isJsonBody) {
        status = 400;
        publicMessage = "Bad request";
    }

    const logLine = JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.url,
        status,
        errName: err && err.name,
        errCode: code,
        errMsg: err && err.message ? String(err.message).slice(0, 500) : null,
    });
    if (status >= 500) {
        console.error("[err]", logLine);
        if (err && err.stack) console.error(err.stack);
    } else {
        console.warn("[warn]", logLine);
    }

    if (res.headersSent) {
        return next(err);
    }
    if ((req.path || "").startsWith("/api/")) {
        return res.status(status).json({ ok: false, error: publicMessage });
    }
    res.status(status).send(publicMessage);
}

module.exports = { errorHandler };
