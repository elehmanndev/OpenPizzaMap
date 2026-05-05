const { PrismaClient } = require("@prisma/client");

let _instance = null;

function getClient() {
    if (!_instance) _instance = new PrismaClient();
    return _instance;
}

function resetClient() {
    if (_instance) {
        _instance.$disconnect().catch(() => {});
        _instance = null;
    }
}

// Proxy defers `new PrismaClient()` until the first DB call, which happens
// after Passenger forks workers. Without this, the tokio timer threads in
// the parent don't survive the fork, causing "PANIC: timer has gone away"
// on the first query in every worker.
const prisma = new Proxy({}, {
    get(_, prop) { return getClient()[prop]; },
});

module.exports = { prisma, resetClient };
