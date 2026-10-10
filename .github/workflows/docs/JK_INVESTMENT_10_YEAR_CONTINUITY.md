# JK Investment — 10-Year Continuity & Disaster Recovery Plan

Last reviewed: 2026-10-03

## Goal

Keep the JK Investment system recoverable and portable for 10+ years even if a hosting provider, domain, laptop, or individual account changes.

## Production architecture

- **Source code:** GitHub repository `janusanthjanu-jk/jk-investment-production`
- **Application hosting:** Vercel production deployment
- **Database:** PostgreSQL / Neon connection supplied through `DATABASE_URL`
- **Primary domain:** `jkinvestment.com.lk`
- **Cloud backup:** Google Drive using OAuth
- **Local backup:** Admin-downloadable ZIP backup

No single provider is the only copy of the business system.

## Ownership and access

Keep company-controlled recovery access for GitHub, Vercel, database provider, domain registrar, and Google Cloud/Drive.

Required safeguards:

1. Enable MFA / 2-Step Verification on every account.
2. Keep at least two trusted recovery methods for each critical account.
3. Do not store passwords, refresh tokens, database URLs, or API secrets in GitHub.
4. Store emergency account-recovery information in a secure offline location controlled by the business.

## Backup policy

Use a 3-copy approach:

1. **Live PostgreSQL database** — production copy.
2. **Google Drive backup** — automatic weekly copy.
3. **Offline/local ZIP** — monthly copy saved to a laptop plus an external drive.

### Automatic Google Drive backup

Current Vercel cron:

- Schedule: `0 18 * * 0`
- UTC: Sunday 18:00
- Sri Lanka: Sunday 23:30
- Route: `/api/cron/backup`

Required Vercel production environment variables:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_DRIVE_FOLDER_ID`
- `CRON_SECRET`

The Google OAuth consent app should be **In Production**, not Testing, before creating the long-lived refresh token.

### Monthly offline backup

On the first business week of each month:

1. Sign in as an administrator.
2. Use **Full Backup** to download the ZIP.
3. Verify that the ZIP opens.
4. Copy it to a second physical location or external drive.
5. Keep at least 12 monthly copies.

## Backup content

The production backup contains core business data such as centers, groups, customers, loans, schedules, payments, allocations, charges, expenses, investors, cash ledger, salary records, daily closings, and cash transfers.

Security-sensitive authentication material such as password hashes, 2FA secrets, and session tokens must not be treated as business backup data.

## Restore policy

A backup is not considered reliable until restore testing has been performed.

### Quarterly restore test

Every 3 months:

1. Do **not** restore over production.
2. Create or use a separate test/staging PostgreSQL database.
3. Take a new production safety backup first.
4. Restore the selected backup into staging.
5. Verify representative records:
   - Customer count and sample customer details
   - Loan count and sample loan balances
   - Payment/receipt history
   - Arrears/advance values
   - DOC/INS/Service charges
   - Expenses and cash ledger
   - Investor transactions
   - Salary records
   - Daily closing and cash transfer records
6. Confirm application login and key reports work against staging.
7. Record the test date and result.

## Important restore compatibility note

The backup archive preserves more business sections than the current in-app **Full Replace** restore flow restores automatically. Core lending data has an existing restore path, but extension modules such as salary/daily-closing data must be specifically verified during quarterly restore testing.

Do not assume a backup is one-click restorable merely because the ZIP exists. Keep this as a tracked continuity item until every backed-up module has a tested automated restore path.

## Domain continuity

- Keep `jkinvestment.com.lk` auto-renew enabled.
- Maintain a current recovery email and phone number with the registrar.
- Review domain expiry and DNS annually.
- Keep a record of required DNS records so the site can be moved to another host if needed.

## GitHub continuity

- Keep the repository private.
- Keep MFA enabled.
- Once per year, create an offline clone/archive of the repository.
- Keep production deployment instructions and recovery documentation in the repository.
- Do not delete merged history needed to understand financial logic changes.

## Vercel continuity

- Keep the production project linked to GitHub.
- Keep account recovery and billing information current.
- Review supported Node.js runtime and dependencies annually.
- If Vercel is replaced, deploy the same GitHub repository to another Node.js-compatible host and update DNS.

## Database continuity

- Confirm provider-level database backups/point-in-time recovery if available.
- Monitor storage growth.
- Never treat Vercel or GitHub as the database backup.
- Before schema migrations, take a full backup.

## Annual maintenance checklist

Once each year:

- Domain renewal and DNS check
- GitHub MFA/recovery check
- Vercel project/access check
- Database backup/PITR check
- Google OAuth status check
- Google Drive backup test
- Offline source-code archive
- Dependency/security update review
- Quarterly restore-test records review
- Emergency recovery contact review

## Emergency recovery order

If the live site is unavailable:

1. Preserve evidence; do not delete the production project or database.
2. Check domain/DNS and Vercel deployment status.
3. Check database availability.
4. Download or locate the most recent valid backup.
5. If the production database is damaged, restore to a new database first.
6. Point a staging deployment to the restored database and verify totals.
7. Only after verification, promote the recovered environment to production.
8. Update DNS only if hosting has changed.
9. Record the incident, root cause, and recovery actions.

## Recovery objectives

Target operational goals:

- **RPO (maximum acceptable data loss):** 7 days from weekly cloud backup; lower when monthly/manual backups are taken after important changes.
- **RTO (target service recovery):** same business day when accounts, source code, database backups, and domain access are available.

For a finance system, a future improvement should reduce RPO by using provider-level daily/PITR database backups in addition to the weekly application backup.
