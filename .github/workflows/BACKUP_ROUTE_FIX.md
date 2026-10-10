# JK Investment Google Drive Backup Route Fix

## Fixed routes

- Manual backup: `POST /api/backup/cloud-now`
- Nightly Vercel cron: `GET /api/cron/backup`
- Legacy cron compatibility: `GET /api/backup/cloud-daily`

The nightly schedule remains `0 18 * * *` (18:00 UTC), which is 11:30 PM in
Sri Lanka.

## Dashboard correction

The dashboard now calculates `Backup Safe` from Google Drive backup runs only.
A successful local ZIP download can no longer make the Google Drive status look
successful.

## Verification

Run:

```bash
npm install
npm run test:backup-routes
```

Expected output:

```text
Backup route registration tests passed.
```

After deploying to Vercel, sign in to the app and click **Backup Now**. Confirm:

1. The request is not `404 NOT_FOUND`.
2. A new file appears in the configured Google Drive folder.
3. `/api/backup/history` records a `SUCCESS` entry with
   `storage_location: GOOGLE_DRIVE`.

Do not commit service-account JSON or any secret value to GitHub. Keep
`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID`, and `CRON_SECRET` in
Vercel Production environment variables.
