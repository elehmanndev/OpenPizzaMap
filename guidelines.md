# OpenPizzaMap Internal Guidelines (Do Not Commit)

This file is for local reference only. Keep it out of git.

## Quick Overview
- **Runtime**: Node.js + Express (`src/app.js`)
- **Database ORM**: Prisma (`src/db.js`, `prisma/schema.prisma`)
- **Templates**: EJS (`src/views/*`)
- **Maps**: Leaflet + OpenStreetMap tiles (`public/js/map.js`)
- **Email**: Resend (`src/services/email.js`)
- **OAuth**: Google OAuth via Passport (`src/services/googleAuth.js`, `src/routes/api.auth.js`)
- **Sessions**: `express-session` cookies (`src/app.js`)
- **Rate limiting**: `express-rate-limit` (`src/middleware/rateLimit.js`)
- **Sitemap**: generated from DB (`src/services/sitemap.js`)

## Environment Files & Loading Order
Environment variables are loaded in `src/app.js` like this:
1. If `.env.local` exists, it is loaded (and overrides defaults).
2. Otherwise `.env` is loaded.

Use `.env.local` for local overrides. Keep secrets out of git. In production, prefer
runtime env vars from hPanel (do not rely on `.env` files).

Key env vars used:
- `DATABASE_URL` (MySQL/MariaDB connection for Prisma)
- `SESSION_SECRET`
- `BASE_URL` (used for email links and sitemap)
- `PORT`
- `RESEND_API_KEY`, `RESEND_FROM`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `MAINTENANCE_MODE` (`true` to serve maintenance page)
- `NODE_ENV` (currently used for ops/logging; no behavior gates in `src/app.js`)
- `BODY_LIMIT` (not currently enforced; add limits if needed)

## Core Services & How-Tos

### Database (Prisma)
Files:
- Schema: `prisma/schema.prisma`
- Client: `src/db.js`

Commands:
```bash
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:migrate
npm run prisma:seed
```

Notes:
- `autoSeed()` runs at startup if the DB is empty (in `src/app.js`).
- Production deploy uses `npm start` which runs `prisma migrate deploy` first.

### Auth & Sessions
Files:
- Routes: `src/routes/api.auth.js`
- Middleware: `src/middleware/auth.js`
- Google OAuth: `src/services/googleAuth.js`

Auth flows:
- Email/password login, register, reset, verify.
- Google OAuth uses Passport + Prisma user linking.
- If a user signed up with Google, register with the same email redirects to `/set-password`
  so they can add a password for email sign-in.

Sessions:
- Stored in memory by default (good for dev; use a store in prod).
- Cookies are `sameSite: "lax"`, `httpOnly: true`.
- `secure` is currently hard-coded to `false`; change in `src/app.js` for production HTTPS.

### Email (Resend)
File: `src/services/email.js`

Used for:
- Verification emails
- Welcome emails
- Password reset emails

Requirements:
- `RESEND_API_KEY`
- `RESEND_FROM`
- `BASE_URL` for links

### Maps / Places
Files:
- UI: `public/js/map.js`, `src/views/map.ejs`
- API: `src/routes/api.places.js`
- Geo helpers: `src/services/geo.js`

Endpoints:
- `GET /api/places?query=&city=`
- `GET /api/places?lat=&lng=&radius=`

### Submissions & Moderation
Files:
- Submission API: `src/routes/api.submissions.js`
- Admin API: `src/routes/api.admin.js`
- Admin pages: `src/views/admin_submissions.ejs`
- Service: `src/services/submissions.js`

Flow:
- User submits → `Submission` created (pending).
- Admin approves → new or updated Place is created.
- Admin rejects → Submission marked rejected with reason.

### Sitemap
Files:
- `src/services/sitemap.js`
- Endpoints: `/sitemap` and `/sitemap.xml` in `src/routes/pages.js`

Manual rebuild:
```bash
npm run sitemap:build
```

### Security Defaults
Implemented in `src/app.js`:
- `morgan` request logging.
- Default Express headers (no `helmet`).
- `x-powered-by` is enabled by default.
- No custom body size limit.

If you need CSP, disabling `x-powered-by`, or escaping helpers, add them in `src/app.js`.

### Rate Limiting
File: `src/middleware/rateLimit.js`
- Auth routes: 30 requests per 15 minutes
- Submission routes: 20 requests per 10 minutes

## Local Development
```bash
npm install
npm run dev
```
Open: `http://localhost:3000`

## Deployment (Hostinger)
### Golden Rule (Current Working Prod Config - Feb 5, 2026)
- Use **hPanel Node.js app mode** (not Passenger).
- Build command: `npm run build` (or leave blank if hPanel runs `postinstall`).
- Start/Run command: `npm start` (runs Prisma migrate + starts server).
- Set **runtime env vars** in hPanel (not only build-time):
  `DATABASE_URL`, `BASE_URL`, `SESSION_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `RESEND_API_KEY`, `RESEND_FROM`, `NODE_ENV=production`.

Notes:
- Deploys may wipe files outside `public_html`, so do **not** rely on `~/.env` files.
- If you must use `.env`, keep it in `public_html` and ensure dotfiles are not served.

## Troubleshooting
- **Prisma auth errors**: check `DATABASE_URL` and DB user credentials on server.
- **Prisma panic `timer has gone away`**: usually means `DATABASE_URL` is missing at runtime.
- **`prisma: Environment variables not found` in logs**: runtime env isn't loaded; fix hPanel runtime env vars.
- **Google auth failing**: check DB connectivity and `GOOGLE_CLIENT_*` values.
- **Sitemap issues**: verify DB connection; sitemap generation is non-fatal.
- **Session issues in prod**: ensure `SESSION_SECRET` is set and consider a persistent store.
- **express-rate-limit error about `X-Forwarded-For`**: add `app.set("trust proxy", 1);` in `src/app.js`.
- **No application logs in hPanel**: app likely never started. SSH in and run:
```bash
cd ~/domains/openpizzamap.com/public_html
npm start
```
If it exits immediately, the error will print in that SSH session.
Also verify `SESSION_SECRET` exists when `NODE_ENV=production`.
- **`npm: command not found` on server**: Node.js/NPM is not installed or not on PATH in the SSH session.
  - Check: `which node`, `which npm`, `node -v`.
  - On Hostinger, enable the Node.js app in hPanel or install Node via nvm:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
```

## SSH Checks (Is The App Running?)
1. **Check port response locally on the server**
```bash
curl -i http://127.0.0.1:3000/map
```
If `PORT` is not 3000, use the configured port.

2. **Check the external domain**
```bash
curl -I https://openpizzamap.com
```

3. **Check the Node process**
```bash
ps aux | grep node
```

4. **If using a process manager**
- `pm2`: `pm2 status` and `pm2 logs`
- `systemd`: `systemctl status <service>` and `journalctl -u <service> -f`

## Hostinger Passenger Checks (Legacy / Only If Using Passenger)
1. **Confirm Passenger config**
```bash
cat ~/domains/openpizzamap.com/public_html/.htaccess
```

2. **Restart Passenger**
```bash
touch ~/domains/openpizzamap.com/public_html/tmp/restart.txt
```

3. **Check Passenger stderr**
```bash
tail -n 200 ~/domains/openpizzamap.com/public_html/stderr.log
```

4. **Check runtime env availability**
If you see `SESSION_SECRET must be set in production` or Prisma `DATABASE_URL` errors in `stderr.log`,
the runtime env is not loaded. Fix by setting hPanel runtime env vars or creating a real `.env` in `public_html`.

## SSH Logs (How To See App Logs)
If the app is managed by a process manager, use its logs:
- `pm2 logs`
- `journalctl -u <service> -f`

If you start the app manually over SSH, logs print to the console:
```bash
cd ~/domains/openpizzamap.com/public_html
npm start
```

You can also tail common log files if your hosting creates them:
```bash
ls -la ~/logs ~/domains/*/logs 2>/dev/null
tail -f ~/logs/* 2>/dev/null
```

## Runtime Env & Logs (Hostinger)
Runtime env is what the running process sees. Build logs are separate.

Build logs:
- `~/.npm/_logs/*.log` (shows `npm exec prisma generate` etc.)

Runtime logs (Passenger/shared hosting):
- `~/domains/openpizzamap.com/public_html/stderr.log`
- `~/domains/openpizzamap.com/logs/*` (if present)

Find the most recent log:
```bash
find ~/domains/openpizzamap.com -maxdepth 6 -type f -name "*.log" -mmin -10 -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort -r
find ~ -maxdepth 4 -type f -name "*.log" -mmin -10 -printf '%TY-%Tm-%Td %TH:%TM %p\n' | sort -r | head -n 20
```

Confirm runtime env (no secrets):
```bash
ps -u $USER -o pid,cmd | grep -E 'lsnode|node|passenger'
PID=<pick pid>
tr '\0' '\n' < /proc/$PID/environ \
  | grep -E 'DATABASE_URL|NODE_ENV|TRUST_PROXY|PORT|BASE_URL' \
  | sed -E 's/=.*/=***REDACTED***/'
```

Startup log note:
- `src/app.js` prints a safe summary on boot:
  `Startup env: NODE_ENV=... DATABASE_URL=set/unset BASE_URL=set/unset`

If the app works but `stderr.log` still shows old crashes, you are likely reading an older log file.

## Suggested Next Improvements
- Use a persistent session store (Redis/MySQL).
- Add CSP nonce + remove inline scripts for tighter security.
- Add integration tests with a dedicated test DB.
