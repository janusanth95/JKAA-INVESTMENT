# JK Investment Vercel Route Fix v4

Upload these files to the ROOT of the existing GitHub repository:

- index.js
- package.json

Allow GitHub to replace package.json.

After commit, Vercel should automatically create a new deployment.

Then test:
https://YOUR-VERCEL-DOMAIN/health

Expected response includes:
{
  "ok": true,
  "service": "jk-investment-backend",
  "database": "neondb"
}

Do not change Neon or the current Vercel environment variables for this fix.
