# JK Investment — Neon + Vercel Staging Deployment

## Status before this step

The PostgreSQL schema has already been installed manually in Neon SQL Editor.

So Vercel only needs to run the backend API and connect to that Neon database.

## Why Vercel-compatible v3 exists

Vercel supports Express directly. This package exports the Express app from:

```text
src/index.js
```

Vercel detects it as one server function.

## GitHub update

Upload/replace the files from this v3 package into your existing private GitHub repository.

Important files:

```text
src/index.js
src/server.js
src/config.js
src/db.js
src/lib/crypto.js
src/middleware/errors.js
vercel.json
VERCEL_ENV.example
package.json
```

The old `render.yaml` may remain in the repository; Vercel ignores it.

## Deploy to Vercel

1. Sign in to Vercel with GitHub.
2. Add New -> Project.
3. Import `jk-investment-production`.
4. Framework should be detected as Express.
5. Before Deploy, add Environment Variables.

### Required staging variables

```text
NODE_ENV=production
DATABASE_URL=<Neon pooled connection string>
DATABASE_SSL=true
DB_POOL_MAX=3
SESSION_HOURS=12
CORS_ORIGINS=https://jk-investment-system.trolley-traces-6o.chatgpt.site
BOOTSTRAP_SECRET=<long random secret>
```

For the first staging deploy, `TWO_FACTOR_ENCRYPTION_KEY` can be left unset.

Do NOT put the Neon database URL in GitHub files.

## Neon DATABASE_URL

In Neon:

```text
Project -> Connect -> Connection string
```

Use the pooled connection string when offered.

Paste the FULL value only into Vercel Environment Variables.

Never post that connection string in chat or screenshots because it contains the database password.

## Verify deployment

After Vercel says Ready:

```text
https://YOUR-VERCEL-DOMAIN/health
```

Expected:

```json
{
  "ok": true,
  "service": "jk-investment-backend",
  "database": "neondb"
}
```

## Create first Admin

The v3 API includes a ONE-TIME bootstrap endpoint.

It works only while the `users` table is empty and only when the correct `BOOTSTRAP_SECRET` is supplied.

After successful admin creation, delete `BOOTSTRAP_SECRET` from Vercel.

Endpoint:

```text
POST /api/bootstrap/admin
```

Required header:

```text
X-Bootstrap-Secret: <your secret>
Content-Type: application/json
```

Body:

```json
{
  "username": "admin",
  "full_name": "JK Administrator",
  "password": "YOUR-OWN-STRONG-PASSWORD"
}
```

Do not send your chosen password to ChatGPT.

## Then test Login

```text
POST /api/auth/login
```

Body:

```json
{
  "username": "admin",
  "password": "YOUR-PASSWORD",
  "device_label": "JK Laptop"
}
```

## 2FA comes after basic login test

Before enabling Authenticator:

1. Generate a random 32-byte Base64 key.
2. Add it to Vercel as `TWO_FACTOR_ENCRYPTION_KEY`.
3. Redeploy.
4. Use `/api/auth/2fa/setup`.
5. Confirm the 6-digit code with `/api/auth/2fa/confirm`.

Do this before real financial data is used.

## Important staging rule

Neon Free + Vercel Free should be treated as staging/testing only.

Do not import real customer financial records until:
- login works,
- balance/arrears calculations are tested,
- payment duplicate behavior is tested,
- audit log is tested,
- production backup plan is ready.
