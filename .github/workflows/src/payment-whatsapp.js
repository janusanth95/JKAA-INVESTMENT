import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { query } from './db.js';
import { sendPaymentReceivedWhatsApp } from './whatsapp.js';

// Enqueue inside the payment transaction: either both writes commit or neither does.
export async function enqueuePaymentWhatsApp(client, paymentId, actorUserId) {
  await client.query(`INSERT INTO whatsapp_jobs(payment_id,actor_user_id)
    VALUES($1,$2) ON CONFLICT(payment_id) DO NOTHING`, [paymentId, actorUserId]);
}

export async function drainWhatsAppJobs({ run = query, send = sendPaymentReceivedWhatsApp,
  maxJobs = 100, budgetMs = 220000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let slots = 0;
  // A crashed send may have reached Meta. Do not blindly resend an ambiguous job.
  await run(`UPDATE whatsapp_jobs SET status='REVIEW',last_reason='INTERRUPTED_SEND',updated_at=now()
    WHERE status='SENDING' AND claimed_at < now()-interval '5 minutes'`);
  async function worker() {
    while (slots < maxJobs && Date.now() < deadline - 10000) {
      slots++;
      const claim = await run(`WITH ready AS (
        SELECT payment_id FROM whatsapp_jobs
        WHERE status='PENDING' AND available_at<=now() AND attempts<5
        ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE whatsapp_jobs j SET status='SENDING',claimed_at=now(),attempts=attempts+1,updated_at=now()
        FROM ready WHERE j.payment_id=ready.payment_id RETURNING j.*`);
      const job = claim.rows[0];
      if (!job) return;
      processed++;
      let outcome;
      try {
        const found = await run(`SELECT p.*,p.payment_date::text AS notification_date,
          c.customer_name,c.mobile,greatest(l.total_payable-COALESCE((
            SELECT sum(px.amount) FROM payments px WHERE px.loan_id=p.loan_id AND px.status='POSTED'
          ),0),0)::numeric(15,2) AS balance_after
          FROM payments p JOIN customers c ON c.id=p.customer_id JOIN loans l ON l.id=p.loan_id
          WHERE p.id=$1`, [job.payment_id]);
        const payment = found.rows[0];
        if (!payment || payment.status !== 'POSTED') {
          outcome = { status: 'SKIPPED', reason: 'POSTED_PAYMENT_NOT_FOUND' };
        } else if (payment.whatsapp_sent_at) {
          outcome = { status: 'SENT', reason: 'ALREADY_SENT' };
        } else {
          // No database transaction/row lock is held over the HTTP request.
          const result = await send({ customerName: payment.customer_name, mobile: payment.mobile,
            amount: payment.amount, paymentDate: payment.notification_date,
            paymentMethod: payment.payment_method, balanceAfter: payment.balance_after });
          if (result.sent) outcome = { status: 'SENT', messageId: result.messageId };
          else if (result.reason === 'WHATSAPP_NOT_CONFIGURED') outcome = { status: 'PENDING', reason: result.reason };
          else if (result.skipped) outcome = { status: 'SKIPPED', reason: result.reason };
          else if (result.reason === 'WHATSAPP_INVALID_RESPONSE') outcome = { status: 'REVIEW', reason: result.reason };
          else outcome = { status: job.attempts >= 5 ? 'FAILED' : 'PENDING', reason: result.reason };
        }
      } catch (error) {
        // A timeout can happen after Meta accepted the message. Manual review avoids duplicates.
        outcome = { status: 'REVIEW', reason: 'DELIVERY_UNCERTAIN' };
        console.error('WhatsApp job requires review', { paymentId: job.payment_id, code: error?.code });
      }
      // One atomic SQL statement stores the successful marker and job result.
      await run(`WITH marked AS (
        UPDATE payments SET whatsapp_sent_at=COALESCE(whatsapp_sent_at,now())
        WHERE id=$1 AND $2='SENT' RETURNING id
      ) UPDATE whatsapp_jobs SET status=$2,last_reason=$3,message_id=$4,
        available_at=now()+interval '1 day',updated_at=now(),
        attempts=CASE WHEN $3='WHATSAPP_NOT_CONFIGURED' THEN greatest(attempts-1,0) ELSE attempts END
        WHERE payment_id=$1`, [job.payment_id, outcome.status, outcome.reason || null, outcome.messageId || null]);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { processed: Math.min(processed, maxJobs) };
}

export function scheduleWhatsAppDrain(res) {
  res.once('finish', () => {
    const work = drainWhatsAppJobs().catch(error => {
      console.error('WhatsApp queue drain failed', { code: error?.code });
    });
    waitUntil(work);
  });
}

export async function whatsappCronHandler(req, res) {
  const secret = process.env.CRON_SECRET;
  const expected = secret ? `Bearer ${secret}` : '';
  const provided = req.get('authorization') || '';
  if (!secret || provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).json({ ok: false, message: 'Unauthorized.' });
  }
  try { return res.json({ ok: true, ...await drainWhatsAppJobs() }); }
  catch (error) {
    console.error('WhatsApp cron failed', { code: error?.code });
    return res.status(500).json({ ok: false, message: 'WhatsApp queue processing failed.' });
  }
}
