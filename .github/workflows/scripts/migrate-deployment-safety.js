import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from '../src/db.js';
try {
  const sql = await fs.readFile(new URL('../db/migrations/001-deployment-safety.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Deployment safety migration applied.');
} finally { await pool.end(); }
