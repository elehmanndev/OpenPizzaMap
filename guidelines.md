# API Key Guidelines

The API key gate is enforced in code. You should set the keys in Hostinger hPanel
environment variables (or `.env.local` locally) so they can be rotated without
redeploying.

## Admin API
- Protected route group: `/api/admin/*`
- Env var: `ADMIN_API_KEYS`
- Format: comma-separated list of keys
- Example: `ADMIN_API_KEYS=prod_abc123,prod_def456`

## How to Send the Key
Preferred:
- Header `x-api-key: <your-key>`

Also accepted:
- Header `Authorization: Bearer <your-key>`
- Query string `?api_key=<your-key>` (only for quick testing)

## Behavior
- Missing or invalid key returns `404` immediately (no DB access).
- If `ADMIN_API_KEYS` is empty or missing, all `/api/admin/*` requests will return `404`.

## Hostinger hPanel
Set this in hPanel:
1. `Websites` -> your site -> `Advanced` -> `Environment variables`
2. Add `ADMIN_API_KEYS` and paste the key(s)
3. Restart the Node app to apply
