import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@localhost:1/test';
const { withReadSnapshot } = await import('../src/db.js');
const { drainWhatsAppJobs } = await import('../src/payment-whatsapp.js');

test('backup reads use one repeatable-read client, commit and release', async () => {
  const calls = [];
  const client = { query: async sql => { calls.push(sql); return { rows: [{ value: 7 }] }; }, release: () => calls.push('release') };
  const value = await withReadSnapshot(async read => (await read('SELECT 7')).rows[0].value, { connect: async () => client });
  assert.equal(value, 7);
  assert.deepEqual(calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL statement_timeout = '60s'", 'SELECT 7', 'COMMIT', 'release']);
});
test('backup failures rollback and release without committing', async () => {
  const calls = [];
  const client = { query: async sql => calls.push(sql), release: () => calls.push('release') };
  await assert.rejects(withReadSnapshot(async () => { throw new Error('failed'); }, { connect: async () => client }), /failed/);
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'release']);
  assert.ok(!calls.includes('COMMIT'));
});
function fixture(payment = { status: 'POSTED', id: 'p', amount: '25', mobile: '0771234567' }) {
  let claimed = false;
  const writes = [];
  const sqlCalls = [];
  const run = async (sql, params) => {
    sqlCalls.push(sql);
    if (sql.startsWith('WITH ready')) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: [{ payment_id: 'p', attempts: 1 }] };
    }
    if (sql.startsWith('SELECT p.*')) return { rows: [payment] };
    if (sql.startsWith('WITH marked')) writes.push(params);
    return { rows: [] };
  };
  return { run, writes, sqlCalls };
}
test('notification sends outside transactions and marks receipt atomically', async () => {
  const f = fixture(); let sends = 0;
  await drainWhatsAppJobs({ run: f.run, send: async () => { sends++; return { sent: true, messageId: 'meta-id' }; } });
  assert.equal(sends, 1);
  assert.deepEqual(f.writes, [['p', 'SENT', null, 'meta-id']]);
  assert.ok(!f.sqlCalls.some(sql => /^BEGIN|FOR UPDATE OF p/.test(sql)));
});
test('already-marked receipt does not send twice', async () => {
  const f = fixture({ status: 'POSTED', whatsapp_sent_at: '2026-01-01' });
  await drainWhatsAppJobs({ run: f.run, send: async () => { throw new Error('must not send'); } });
  assert.equal(f.writes[0][1], 'SENT');
  assert.equal(f.writes[0][2], 'ALREADY_SENT');
});
test('ambiguous delivery is flagged for review instead of automatic resend', async () => {
  const f = fixture();
  await drainWhatsAppJobs({ run: f.run, send: async () => { throw new Error('timeout'); } });
  assert.equal(f.writes[0][1], 'REVIEW');
});
test('confirmed API rejection stays queued for retry', async () => {
  const f = fixture();
  await drainWhatsAppJobs({ run: f.run, send: async () => ({ sent: false, reason: 'WHATSAPP_API_ERROR' }) });
  assert.equal(f.writes[0][1], 'PENDING');
});
test('voided payment is skipped', async () => {
  const f = fixture({ status: 'VOIDED' });
  await drainWhatsAppJobs({ run: f.run, send: async () => { throw new Error('must not send'); } });
  assert.equal(f.writes[0][1], 'SKIPPED');
});
