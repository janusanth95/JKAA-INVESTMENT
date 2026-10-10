import { config } from './config.js';
import { pool } from './db.js';
import './dashboard-classic-v2.js';
import './center-repayment-download-patch.js';
import app from './index.js';

const server = app.listen(config.PORT, () => {
  console.log(`JK Investment API listening on port ${config.PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
