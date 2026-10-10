import 'dotenv/config';
import argon2 from 'argon2';
import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const username = process.env.ADMIN_USERNAME;
const fullName = process.env.ADMIN_NAME || 'JK Administrator';
const password = process.env.ADMIN_PASSWORD;

if (!databaseUrl || !username || !password) {
  console.error('DATABASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD are required.');
  process.exit(1);
}

if (password.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false
});

try {
  const role = await pool.query(
    `SELECT id FROM roles WHERE code='ADMIN'`
  );

  if (role.rowCount !== 1) {
    throw new Error('ADMIN role not found. Run db/schema.sql first.');
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id
  });

  const result = await pool.query(
    `
    INSERT INTO users(username,full_name,password_hash,role_id,status)
    VALUES($1,$2,$3,$4,'ACTIVE')
    ON CONFLICT(username)
    DO UPDATE SET
      full_name=EXCLUDED.full_name,
      password_hash=EXCLUDED.password_hash,
      role_id=EXCLUDED.role_id,
      status='ACTIVE',
      password_changed_at=now()
    RETURNING id, username, full_name
    `,
    [username, fullName, passwordHash, role.rows[0].id]
  );

  console.log('Admin created/updated:', result.rows[0]);
} finally {
  await pool.end();
}
