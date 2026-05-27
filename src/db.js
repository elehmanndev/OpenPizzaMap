const { PrismaClient } = require("@prisma/client");

let _instance = null;
let _connectPromise = null;

function getClient() {
    if (!_instance) {
        _instance = new PrismaClient();
        // Eagerly kick off $connect() the first time the client is materialized.
        // The library engine has a tokio race when two requests trigger
        // initialization concurrently — "library already starting" + "PANIC:
        // timer has gone away". Caching this promise lets ensureConnected()
        // serialize all early requests behind one start.
        _connectPromise = _instance.$connect().catch((err) => {
            _connectPromise = null;
            throw err;
        });
    }
    return _instance;
}

async function ensureConnected() {
    getClient();
    if (_connectPromise) await _connectPromise;
}

function resetClient() {
    if (_instance) {
        _instance.$disconnect().catch(() => {});
        _instance = null;
        _connectPromise = null;
    }
}

// Proxy defers `new PrismaClient()` until the first DB call, which happens
// after Passenger forks workers. Without this, the tokio timer threads in
// the parent don't survive the fork, causing "PANIC: timer has gone away"
// on the first query in every worker.
const prisma = new Proxy({}, {
    get(_, prop) { return getClient()[prop]; },
});

module.exports = { prisma, ensureConnected, resetClient };
