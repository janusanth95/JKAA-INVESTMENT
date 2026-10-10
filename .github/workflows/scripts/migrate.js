import 'dotenv/config';
import fs from 'fs/promises';
import pg from 'pg';

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const ssl = process.env.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: false }
  : false;

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl
});

try {
  const sql = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');

  console.log('Connecting to PostgreSQL...');
  await client.connect();

  console.log('Applying JK Investment database schema...');
  await client.query(sql);

  const result = await client.query(`
    SELECT
      current_database() AS database_name,
      current_timestamp AS migrated_at,
      (SELECT count(*) FROM information_schema.tables
       WHERE table_schema='public') AS public_table_count
  `);

  console.log('Migration complete:', result.rows[0]);
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
