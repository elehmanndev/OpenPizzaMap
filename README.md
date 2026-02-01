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
3. Copy `.env.example` → `.env` and set `DATABASE_URL` and `SESSION_SECRET`

Install deps:
```bash
npm install
```

Generate Prisma client:
```bash
npm run prisma:generate
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

## Admin (local seed)
Seed creates:
- Email: `admin@openpizzamap.local`
- Password: `admin123!ChangeMe`

Change these for any real deployment.

## Hostinger deployment notes
Use Hostinger “Node.js Web App”

Set env vars in Hostinger panel:
- `DATABASE_URL`
- `SESSION_SECRET`
- `PORT` (Hostinger may provide it)

Start command: `npm start`

Run migrations on deploy: `npm run prisma:migrate`

(If needed) run seed only once: `npm run prisma:seed`

## Moderation flow
1. Logged-in users submit places → Submission record (pending)
2. Admin approves → Place created and submission marked approved
3. Admin rejects → submission marked rejected with a reason
