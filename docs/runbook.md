# Runbook

Operational playbooks for OpenPizzaMap. Each entry: symptom → root cause →
fix that's already in place → recovery steps if the fix fails → how to
validate.

---

## Hostinger SSH layout (read this first)

After SSH'ing in, the layout is **not** what `public_html` suggests:

- `~/domains/openpizzamap.com/nodejs/` — **the actual Node.js app**
  (package.json, src/, prisma/, node_modules/, scripts/). All `npm`,
  `node`, and `prisma` commands run from here.
- `~/domains/openpizzamap.com/public_html/` — static-only mount, **no**
  package.json. Don't try to run Node commands from this directory.
- `~/domains/openpizzamap.com/DO_NOT_UPLOAD_HERE/` — exactly what it says.
- `~/opm.log` — app log file at the home dir level.

Node binary: `/opt/alt/alt-nodejs20/root/bin/node` (and `npm`). Always use
the absolute path; the default `node` on `$PATH` may not match.

Recovery one-liner for the Prisma chmod issue (see next section):
```sh
cd ~/domains/openpizzamap.com/nodejs && /opt/alt/alt-nodejs20/root/bin/npm run postinstall
```

---

## Prisma engine panics on every query (Hostinger chmod / deploy)

### Symptom

- Card click on `/place/:id` returns **500 Internal Server Error**.
- `GET /api/health` returns **503** with body
  `{"ok":false,"status":"unhealthy","errName":"PrismaClientRustPanicError"}`.
- `/api/places/markers`, `/api/places?limit=...`, and any other
  DB-touching route also return 500 / 503.
- Static-render routes (`/`, `/map`, `/about`) keep returning **200**
  — so the Node worker itself is alive; only the Prisma engine is broken.

If the symptom is "all routes 503" instead of "DB routes 500 + static
200", that's a different failure (worker dead) — see the Hostinger
hPanel "Restart" button or [docs/api-keys.md](api-keys.md) for SSH.

### Root cause

Hostinger's git auto-deploy strips the executable bit when it copies
files into the live tree. After `npm install` runs `prisma generate`,
the regenerated query-engine binaries land in
`node_modules/.prisma/client/` with mode `0644`. The `@prisma/client`
runtime tries to launch the engine, the OS refuses (no exec bit), the
engine subprocess dies, and the client surfaces it as
`PrismaClientRustPanicError` on every subsequent query. Worker stays
alive, but Prisma is unusable until restart.

We hit this on **2026-04-30** (initial outage, [stability audit notes](../notes/sessions/2026-04-30-stability-audit.md))
and again on **2026-05-03** (recurrence — the original chmod fix
didn't cover `.prisma/client`).

### Fix in place

Three commits, all on `main`:

- [`e856a7e`](https://github.com/elehmanndev/OpenPizzaMap/commit/e856a7e)
  — factored chmod into [scripts/deploy/chmod-prisma-engines.js](../scripts/deploy/chmod-prisma-engines.js),
  added `node_modules/.prisma/client` (the actual runtime engine
  location — uncovered before) to its targets, and runs it both before
  and after `prisma generate` from postinstall.
- [`0a14bc3`](https://github.com/elehmanndev/OpenPizzaMap/commit/0a14bc3)
  — postinstall now also writes `tmp/restart.txt` via
  [scripts/deploy/touch-passenger-restart.js](../scripts/deploy/touch-passenger-restart.js)
  so Passenger respawns the worker after deploy.
- [`9ab1681`](https://github.com/elehmanndev/OpenPizzaMap/commit/9ab1681)
  — bumped `src/app.js` mtime once. **Operational note:** on the
  current Hostinger box `tmp/restart.txt` alone wasn't enough to
  trigger the respawn during the 2026-05-03 outage; changing the
  entry-file mtime did. Both mechanisms run from postinstall now,
  belt-and-braces, but if a future Prisma outage doesn't clear after
  a deploy, suspect that `tmp/restart.txt` is being ignored again and
  fall back to bumping `src/app.js`.

### Recovery if it happens again despite the fix

1. **Try the redeploy path first.** Push any commit to `main` (a
   one-character whitespace tweak in `src/app.js` is enough — that
   forces both postinstall to rerun *and* the entry mtime to change).
   Wait 60–120 s. Hit `/api/health`. Expect `{"ok":true,"status":"healthy",...,"uptimeSec":0}`
   — `uptimeSec=0` confirms the worker actually restarted.
2. **If health still 503, SSH and rerun postinstall.** This is the
   sequence that recovered the **2026-05-06** outage (after the OAuth
   fix deploy triggered a worker respawn that hit the chmod bug):
   ```sh
   ssh -p $HOSTINGER_SSH_PORT $HOSTINGER_USER@$HOSTINGER_HOST
   cd ~/domains/openpizzamap.com/nodejs
   export PATH=/opt/alt/alt-nodejs20/root/bin:$PATH   # npm sub-shell needs node on PATH
   npm run postinstall
   ```
   The `npm run postinstall` does the full sequence: chmod the Prisma
   engines, regenerate the client, chmod again, write
   `.builds/asset-version.txt`, and touch `tmp/restart.txt` to force a
   Passenger respawn. Watch for `uptimeSec: 0` on `/api/health` — that
   confirms the worker actually restarted.

   If that fails too, the manual chmod fallback (do **not** forget the
   `cd nodejs`):
   ```sh
   cd ~/domains/openpizzamap.com/nodejs
   chmod -R +x node_modules/.prisma/client/* node_modules/@prisma/engines/* node_modules/.bin/*
   touch tmp/restart.txt
   touch src/app.js
   ```
   Then re-check `/api/health`.
3. **If SSH is denied** (host config drift — happened on 2026-05-03),
   use hPanel → Node.js app → **Restart** button. That force-restarts
   Passenger which picks up whatever the latest deploy wrote.
4. **If hPanel restart doesn't help either**, the Prisma client
   itself is corrupt. SSH and run (from `~/domains/openpizzamap.com/nodejs`):
   ```sh
   cd ~/domains/openpizzamap.com/nodejs
   export PATH=/opt/alt/alt-nodejs20/root/bin:$PATH
   rm -rf node_modules/.prisma/client
   node node_modules/prisma/build/index.js generate
   chmod -R +x node_modules/.prisma/client/*
   touch src/app.js
   ```
   This regenerates from `prisma/schema.prisma` and re-applies exec
   bits.

### How to validate (without touching prod state)

- `curl -s https://openpizzamap.com/api/health` → expect 200 with
  `ok:true`, `status:"healthy"`, integer `counts.places`, `counts.visits`,
  `counts.favorites`, and a numeric `uptimeSec`.
- Hit a known-good place: `curl -s -o /dev/null -w "%{http_code}\n" https://openpizzamap.com/place/178`
  (50 Kalò) → expect **200**.
- Right after a redeploy, `uptimeSec` should be small (< 60 s for the
  first request). If it's a few hours, the worker did *not* restart
  and the chmod fix didn't take effect — escalate to recovery step 2.

### Related artefacts

- Outage incident notes: [notes/sessions/2026-04-30-stability-audit.md](../notes/sessions/2026-04-30-stability-audit.md)
  (initial), [notes/sessions/2026-05-03-admin-ui-styles-descriptions.md](../notes/sessions/2026-05-03-admin-ui-styles-descriptions.md)
  (HEAD before recurrence).
- Health endpoint definition: [src/app.js](../src/app.js) — search for
  `/api/health`. It deliberately pings `prisma.place.count()`,
  `prisma.visit.count()`, `prisma.favorite.count()` — three tables
  picked because they're the ones most likely to drift.
- Migrate gate: [scripts/deploy/migrate.js](../scripts/deploy/migrate.js) is strict
  by default since 2026-04-30 — a failed `prisma migrate deploy` halts
  the boot rather than serving with a stale schema. Override with
  `MIGRATE_LENIENT=true` *only* during explicit recovery.
