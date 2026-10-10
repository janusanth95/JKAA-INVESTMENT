# JK Investment — Backup & Restore Checklist

Use this checklist for every quarterly restore test and after major financial-system changes.

## Before the test

- [ ] Confirm production is operating normally.
- [ ] Download a fresh **Full Backup** ZIP.
- [ ] Confirm the ZIP opens and contains `Full_Backup.json` plus spreadsheet files.
- [ ] Confirm the most recent Google Drive backup status.
- [ ] Record the backup filename, date, size, and SHA-256 checksum if shown.
- [ ] Create/use a **separate staging database**. Never test restore directly on production.

## Google Drive configuration

In Vercel Production, confirm the names exist (do not expose values):

- [ ] `GOOGLE_OAUTH_CLIENT_ID`
- [ ] `GOOGLE_OAUTH_CLIENT_SECRET`
- [ ] `GOOGLE_OAUTH_REFRESH_TOKEN`
- [ ] `GOOGLE_DRIVE_FOLDER_ID`
- [ ] `CRON_SECRET`

Google Cloud:

- [ ] OAuth consent app is **In Production**.
- [ ] Connected Google account still has access to the backup folder.
- [ ] Manual **Backup Now** succeeds.
- [ ] Weekly automatic backup has a recent SUCCESS record.

## Restore validation

After restoring to staging, compare production backup counts/totals with staging:

- [ ] Centers
- [ ] Groups
- [ ] Customers
- [ ] Loans
- [ ] Loan guarantors
- [ ] Repayment schedules
- [ ] Payments / receipts
- [ ] Payment allocations
- [ ] DOC / INS / Service charges
- [ ] Expenses
- [ ] Investors / investor transactions
- [ ] Cash ledger
- [ ] Salary limits / advances / payments
- [ ] Daily closings
- [ ] Cash transfers

## Functional checks

- [ ] Admin login works on staging.
- [ ] Customer detail opens.
- [ ] Loan detail opens.
- [ ] Sample loan balance equals the backup/source value.
- [ ] Sample payment history matches.
- [ ] Arrears/advance matches.
- [ ] Collection report opens.
- [ ] Repayment sheet/PDF opens.
- [ ] Cash Book totals are reasonable.
- [ ] Daily Closing page opens.
- [ ] Backup page/status opens.

## Result

Record:

- Test date:
- Backup filename:
- Backup generated date:
- Staging database:
- Tested by:
- Result: PASS / FAIL
- Differences found:
- Corrective action:
- Next test date:

## Do not do

- Do not paste secrets into chat, tickets, GitHub issues, or screenshots.
- Do not overwrite production during a restore test.
- Do not delete a failed backup record before documenting the cause.
- Do not rely on only one Google Drive or one laptop copy.
