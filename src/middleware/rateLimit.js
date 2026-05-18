const rateLimit = require("express-rate-limit");

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

const submitLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
});

// Per-user daily cap on the Gemini-powered chatbot intake. Each Gemini
// call costs us tokens (and the user time); 50/day per signed-in user
// is a comfortable headroom for legit submitters while killing any
// scraper or abuse loop dead. Keyed by userId — IP-based caps don't
// work behind Hostinger's shared reverse proxy.
//
// In-memory store: resets on worker restart, which is fine. The cap
// exists to prevent the 1500 RPD Gemini free-tier from getting blown
// by one user, not to be cryptographically tamper-proof.
const chatbotLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const uid = req.session && req.session.user && req.session.user.id;
        return uid ? `u:${uid}` : `ip:${req.ip}`;
    },
    message: { ok: false, error: "Daily chat limit reached. Try again tomorrow." },
});

module.exports = { authLimiter, submitLimiter, chatbotLimiter };
