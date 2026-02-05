const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");

function mockModule(resolvedPath, exports) {
    require.cache[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports,
    };
}

function clearModule(resolvedPath) {
    delete require.cache[resolvedPath];
}

function createFakePrisma(seedUsers = []) {
    const users = seedUsers.map((u) => ({ ...u }));
    let nextId = users.reduce((max, user) => Math.max(max, user.id || 0), 0) + 1;

    const pick = (source, select) => {
        if (!select) return source;
        const out = {};
        Object.keys(select).forEach((key) => {
            if (select[key]) out[key] = source[key];
        });
        return out;
    };

    const findBy = (predicate) => users.find(predicate) || null;

    const user = {
        findUnique: async ({ where }) => {
            if (where.email) return findBy((u) => u.email === where.email);
            if (where.id) return findBy((u) => u.id === where.id);
            if (where.googleId) return findBy((u) => u.googleId === where.googleId);
            return null;
        },
        findFirst: async ({ where }) => {
            if (where.displayName) return findBy((u) => u.displayName === where.displayName);
            if (where.resetTokenHash) return findBy((u) => u.resetTokenHash === where.resetTokenHash);
            if (where.googleId) return findBy((u) => u.googleId === where.googleId);
            return null;
        },
        create: async ({ data, select }) => {
            const created = { id: data.id || nextId++, ...data };
            users.push(created);
            return pick(created, select);
        },
        update: async ({ where, data, select }) => {
            const target = where.id
                ? findBy((u) => u.id === where.id)
                : where.email
                  ? findBy((u) => u.email === where.email)
                  : null;
            if (!target) throw new Error("User not found");
            Object.assign(target, data);
            return pick(target, select);
        },
        delete: async ({ where }) => {
            const index = users.findIndex((u) => u.id === where.id);
            if (index === -1) throw new Error("User not found");
            const removed = users.splice(index, 1)[0];
            return removed;
        },
    };

    return { prisma: { user }, users };
}

function loadAuthRouter({ prisma, email }) {
    const dbPath = path.resolve(__dirname, "../src/db.js");
    const limiterPath = path.resolve(__dirname, "../src/middleware/rateLimit.js");
    const emailPath = path.resolve(__dirname, "../src/services/email.js");
    const googlePath = path.resolve(__dirname, "../src/services/googleAuth.js");
    const authPath = path.resolve(__dirname, "../src/routes/api.auth.js");

    mockModule(dbPath, { prisma });
    mockModule(limiterPath, { authLimiter: (_req, _res, next) => next() });
    mockModule(emailPath, email);
    clearModule(googlePath);
    clearModule(authPath);

    return require(authPath);
}

async function withServer(router, fn) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => {
        req.session = {};
        next();
    });
    app.use("/api/auth", router);

    const server = await new Promise((resolve) => {
        const started = app.listen(0, () => resolve(started));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
        await fn(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("registers a new user", async () => {
    const { prisma, users } = createFakePrisma();
    let verificationCalls = 0;
    const router = loadAuthRouter({
        prisma,
        email: {
            sendVerificationEmail: async () => {
                verificationCalls += 1;
            },
            sendPasswordResetEmail: async () => {},
        },
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "mario@example.com",
                displayName: "Mario_123",
                password: "Pizza123",
                termsAccepted: true,
            }),
        });
        const data = await res.json();
        assert.equal(res.status, 200);
        assert.equal(data.ok, true);
    });

    assert.equal(users.length, 1);
    assert.equal(verificationCalls, 1);
});

test("register detects existing Google-only account", async () => {
    const { prisma } = createFakePrisma([
        {
            id: 1,
            email: "luigi@example.com",
            displayName: "Luigi",
            role: "user",
            passwordHash: null,
            googleId: "google-1",
        },
    ]);
    const router = loadAuthRouter({
        prisma,
        email: { sendVerificationEmail: async () => {}, sendPasswordResetEmail: async () => {} },
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "luigi@example.com",
                displayName: "Luigi_2",
                password: "Pizza123",
                termsAccepted: true,
            }),
        });
        const data = await res.json();
        assert.equal(res.status, 409);
        assert.equal(data.error, "google_account");
    });
});

test("login succeeds with valid credentials", async () => {
    const passwordHash = await bcrypt.hash("Slice123", 10);
    const { prisma } = createFakePrisma([
        {
            id: 2,
            email: "peach@example.com",
            displayName: "Peach",
            role: "user",
            passwordHash,
            emailVerifiedAt: new Date(),
        },
    ]);
    const router = loadAuthRouter({
        prisma,
        email: { sendVerificationEmail: async () => {}, sendPasswordResetEmail: async () => {} },
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: "peach@example.com",
                password: "Slice123",
            }),
        });
        const data = await res.json();
        assert.equal(res.status, 200);
        assert.equal(data.ok, true);
        assert.equal(data.user.email, "peach@example.com");
    });
});

test("forgot password stores reset token for email users", async () => {
    const { prisma, users } = createFakePrisma([
        {
            id: 3,
            email: "toad@example.com",
            displayName: "Toad",
            role: "user",
            passwordHash: "hash",
        },
    ]);
    let resetCalls = 0;
    const router = loadAuthRouter({
        prisma,
        email: {
            sendVerificationEmail: async () => {},
            sendPasswordResetEmail: async () => {
                resetCalls += 1;
            },
        },
    });

    await withServer(router, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/auth/forgot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "toad@example.com" }),
        });
        const data = await res.json();
        assert.equal(res.status, 200);
        assert.equal(data.ok, true);
    });

    assert.equal(resetCalls, 1);
    assert.ok(users[0].resetTokenHash);
    assert.ok(users[0].resetTokenExpiresAt);
});
