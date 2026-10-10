import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

const failures = [];
const required = [
  'DATABASE_URL',
  'TWO_FACTOR_ENCRYPTION_KEY'
];

for (const key of required) {
  if (!process.env[key]) failures.push(`Missing ${key}`);
}

if ((process.env.NODE_ENV || '') !== 'production') {
  failures.push('NODE_ENV should be production');
}

if (!process.env.CORS_ORIGINS || process.env.CORS_ORIGINS.includes('*')) {
  failures.push('CORS_ORIGINS must be an explicit allow-list; "*" is not allowed');
}

const key = Buffer.from(process.env.TWO_FACTOR_ENCRYPTION_KEY || '', 'base64');
if (key.length !== 32) {
  failures.push('TWO_FACTOR_ENCRYPTION_KEY must decode to exactly 32 bytes');
}

if (failures.length) {
  console.error('Production configuration failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false
});

try {
  await client.connect();

  const result = await client.query(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      current_setting('server_version') AS postgres_version,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='customers'
      ) AS customers_table,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='loans'
      ) AS loans_table,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='payments'
      ) AS payments_table
  `);

  const row = result.rows[0];

  if (!row.customers_table || !row.loans_table || !row.payments_table) {
    throw new Error('Core database tables are missing. Run npm run migrate.');
  }

  const deploymentSchema = await client.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='whatsapp_sent_at') AS receipt_marker,
    to_regclass('public.whatsapp_jobs') IS NOT NULL AS queue_table`);
  if (!deploymentSchema.rows[0].receipt_marker || !deploymentSchema.rows[0].queue_table) {
    throw new Error('Deployment safety migration missing. Run npm run migrate:deployment-safety before deploying.');
  }
  if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET is required for scheduled backups and notification retries.');
  console.log('Production check PASSED');
  console.log({
    database_name: row.database_name,
    database_user: row.database_user,
    postgres_version: row.postgres_version,
    core_tables: 'OK'
  });
} finally {
  await client.end().catch(() => {});
}
