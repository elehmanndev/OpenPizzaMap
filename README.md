# OpenPizzaMap

Community-submitted pizza places with moderation, map + search.

## Tech
- Node.js + Express
- Prisma
- MariaDB (Hostinger)
- EJS frontend
- Leaflet + OpenStreetMap tiles

## Local setup
1. Install Node.js LTS
2. Create a MariaDB database (local or remote)
3. Create `.env.local` for localhost (and `.env` for production) with `DATABASE_URL` and `SESSION_SECRET`. For sign-in, also set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `BASE_URL` (or `GOOGLE_CALLBACK_URL`) — without them the app runs but Google sign-in is disabled.

Install deps:
```bash
npm install
```

Generate Prisma client:
```bash
npm run prisma:generate
```

Build sitemap (manual, when needed):
```bash
npm run sitemap:build
```

Run migrations:
```bash
npm run prisma:migrate:dev
```

Seed:
```bash
npm run prisma:seed
```

Run:
```bash
npm run dev
```

Open: http://localhost:3000

## Admin access
Auth is Google-only — no admin user is seeded (`prisma/seed.js` is a no-op).
To grant yourself admin:
1. Sign in once with Google to create your `User` row.
2. Promote it: `UPDATE User SET role = 'admin' WHERE email = '<you>@gmail.com';`

## Hostinger deployment notes
Use Hostinger “Node.js Web App”

Set env vars in Hostinger panel:
- `DATABASE_URL`
- `SESSION_SECRET`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL`
- `PORT` (Hostinger may provide it)

Start command: `npm start`

Run migrations on deploy: `npm run prisma:migrate`

(If needed) run seed only once: `npm run prisma:seed`

## Moderation flow
1. Logged-in users submit places → Submission record (pending)
2. Admin approves → Place created and submission marked approved
3. Admin rejects → submission marked rejected with a reason
