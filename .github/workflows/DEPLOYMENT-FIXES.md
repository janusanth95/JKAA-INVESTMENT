# JK Investment deployment fixes

## முதலில் செய்ய வேண்டியது

இந்த ZIP code changes மட்டுமே. Live Vercel / Neon database மாற்றப்படவில்லை.

1. தற்போதைய database backup எடுத்து வைத்துக்கொள்ளுங்கள்.
2. Staging database-ல் முதலில் `db/migrations/001-deployment-safety.sql` உள்ள SQL-ஐ Neon SQL Editor-ல் run செய்யுங்கள். Existing database-க்கு முழு `db/schema.sql`-ஐ மீண்டும் run செய்ய வேண்டாம்.
3. புதிய code-ஐ GitHub repo root-ல் upload செய்யுங்கள். ZIP extract செய்த folder-ன் **உள்ளே இருக்கும் files/folders** upload செய்ய வேண்டும்; extra parent folder வேண்டாம். `package-lock.json` சேர்க்க வேண்டும்.
4. Vercel environment-ல் DATABASE_URL, TWO_FACTOR_ENCRYPTION_KEY, CORS_ORIGINS, NODE_ENV=production, CRON_SECRET சரியாக இருக்க வேண்டும். CRON_SECRET ஏற்கனவே இருந்தால் அதையே பயன்படுத்தலாம். Tokens / passwords-ஐ chat அல்லது GitHub-ல் போட வேண்டாம்.
5. WhatsApp-க்கு WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_PAYMENT_TEMPLATE, WHATSAPP_TEMPLATE_LANGUAGE தேவை. Approved template-க்கு code அனுப்பும் 5 body parameters பொருந்த வேண்டும்.
6. Google Drive backup-க்கு GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID தேவை.
7. Staging-ல் login, single collection, group collection, duplicate retry, backup download, Drive upload, backup restore ஆகியவற்றை dummy data-வில் test செய்யுங்கள். பின்னர் production migration மற்றும் deployment செய்யுங்கள்.

CLI கிடைத்தால், private environment configured ஆன terminal-ல்:

```sh
npm ci
npm run migrate:deployment-safety
npm run check:production
npm run test:deployment-safety
npm run test:backup-routes
```

Migration must run before deploying the new application. A fresh database also requires the normal schema setup first, followed by this additive migration.

## What changed

- Payment transactions atomically add a durable database notification job. API responses return `whatsapp: {sent:false, queued:true, reason:'WHATSAPP_QUEUED'}`; this is queued, not proof of delivery.
- After the response finishes, Vercel `waitUntil` processes up to 100 jobs with three workers and a 220-second budget. Daily cron recovers pending jobs. Existing sent markers prevent known duplicate deliveries.
- No payment transaction or payment row lock is held while waiting for Meta. Workers claim jobs atomically with SKIP LOCKED.
- Definitive API rejection retries up to five attempts, at least one day apart. Missing configuration remains pending without using up attempts.
- Ambiguous timeout, invalid accepted response, or interrupted send goes to REVIEW rather than being blindly resent. Meta send plus PostgreSQL update cannot be an exactly-once atomic transaction. Inspect provider delivery status before retrying REVIEW jobs.
- Backup reads share one repeatable-read, read-only PostgreSQL snapshot. Tables have a 50,000-row guard, cumulative JSON reads a 32 MiB guard, and cloud archives a 64 MiB guard. Larger databases need a managed PostgreSQL backup/export. These are deliberate safety limits, not unlimited streaming database exports.
- Drive authentication/upload have 15/60-second network timeouts; backup queries have a 60-second statement timeout. ZIP downloads stream in chunks; ZIP construction still uses bounded memory.
- Payment HTTP endpoints no longer execute ALTER TABLE. A separate additive migration handles the receipt marker and queue table.
- Pool lifecycle integrates with Vercel Fluid Compute; normal SQL statements have a 20-second timeout. Review this limit if an existing large report legitimately takes longer.
- Dependency versions are locked. Root Express entrypoint is retained; function duration is explicitly 300 seconds.
- Production checker verifies the queue migration and CRON_SECRET.

## Schedule and operational limits

Existing weekly backup schedule is unchanged: Sunday 18:00 UTC (23:30 Sri Lanka).
Notification recovery is daily 18:05 UTC (23:35 Sri Lanka), chosen to work with daily-only cron plans. For faster recovery, configure a supported paid-plan schedule after checking the actual Vercel plan. A large backlog can need multiple recovery runs. Cron runs on production; preview staging requires an authenticated manual invocation to test cron endpoints.

Useful operational queries (run in your database console):

```sql
SELECT status, count(*) FROM whatsapp_jobs GROUP BY status;
SELECT payment_id, status, attempts, last_reason, updated_at
FROM whatsapp_jobs WHERE status IN ('REVIEW', 'FAILED') ORDER BY updated_at;
```

Do not blindly reset REVIEW jobs: a message may already have reached the customer. Reconcile with Meta first. No historical payment notifications are automatically backfilled. Restored backups should not automatically replay customer notifications; recreate the queue schema using the additive migration after a full restore.

## Validation performed

- Seven deployment-safety tests passed under Node 22 and Node 24: snapshot commit/rollback/release, notification success, existing marker, uncertain delivery, API rejection and voided payment.
- Backup and notification cron route authorization tests passed.
- Existing salary carry-forward, pending loan edit, duplicate-loan UI tests passed; four loan eligibility tests passed.
- All 48 application/script JavaScript files passed syntax checks.

Live PostgreSQL migration, concurrent worker SQL against PostgreSQL, actual Meta delivery, Drive upload/restore and deployed Vercel streaming were not executable here because no live credentials/project access were available. Test these in staging before release. The previous FUNCTION_INVOCATION_FAILED error still needs runtime logs to establish its actual cause.
