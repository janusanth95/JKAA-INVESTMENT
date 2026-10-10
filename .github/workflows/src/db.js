import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { config } from './config.js';

const { Pool, types } = pg;

// Keep NUMERIC/DECIMAL as strings: never use JS floats for money.
types.setTypeParser(1700, (value) => value);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 10000,
  statement_timeout: 20000,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true
});

attachDatabasePool(pool);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error', err);
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(actorUserId, work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (actorUserId) {
      await client.query(
        `SELECT set_config('app.user_id', $1, true)`,
        [String(actorUserId)]
      );
    }

    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

// All backup reads use one connection and one committed database snapshot.
export async function withReadSnapshot(work, dbPool = pool) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await work(client.query.bind(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
