import assert from 'node:assert/strict';

// This test only verifies route registration. Authentication intentionally
// stops each request before a database or Google Drive call is attempted.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgres://route-test:route-test@127.0.0.1:1/route-test';
process.env.DATABASE_SSL = 'false';

const { default: app } = await import('../index.js');

const server = app.listen(0);

try {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const manual = await fetch(`${origin}/api/backup/cloud-now`, { method: 'POST' });
  assert.equal(manual.status, 401, 'manual cloud backup route must exist and require auth');
  assert.deepEqual(await manual.json(), { error: 'AUTH_REQUIRED' });

  const configStatus = await fetch(`${origin}/api/backup/config-status`);
  assert.equal(configStatus.status, 401, 'backup config status must require auth');
  assert.deepEqual(await configStatus.json(), { error: 'AUTH_REQUIRED' });

  const cron = await fetch(`${origin}/api/cron/backup`);
  assert.equal(cron.status, 401, 'cron backup route must exist and require CRON_SECRET');
  assert.deepEqual(await cron.json(), { ok: false, message: 'Unauthorized.' });

  const legacyCron = await fetch(`${origin}/api/backup/cloud-daily`);
  assert.equal(legacyCron.status, 401, 'legacy cron endpoint must remain compatible');

  const notificationCron = await fetch(`${origin}/api/cron/whatsapp`);
  assert.equal(notificationCron.status, 401, 'notification cron requires CRON_SECRET');

  console.log('Backup and notification route registration tests passed.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
