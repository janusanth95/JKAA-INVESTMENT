import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

import { enqueuePaymentWhatsApp, scheduleWhatsAppDrain } from '../payment-whatsapp.js';

export const paymentsRouter = express.Router();
paymentsRouter.use(requireAuth);

const paymentSchema = z.object({
  loan_id: z.string().uuid(),
  amount: z.coerce.number().positive(),
  payment_date: z.iso.date(),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH'),
  notes: z.string().trim().max(500).optional().nullable(),
  idempotency_key: z.string().uuid().optional()
});

paymentsRouter.post(
  '/',
  requirePermission('PAYMENT_CREATE'),
  async (req, res, next) => {
    try {
      const body = paymentSchema.parse(req.body);

      const paymentId = await withTransaction(
        req.auth.user_id,
        async (client) => {
          const result = await client.query(
            `
            SELECT create_payment(
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              COALESCE($7::uuid, gen_random_uuid())
            ) AS payment_id
            `,
            [
              body.loan_id,
              body.amount,
              body.payment_date,
              body.payment_method,
              body.notes || null,
              req.auth.user_id,
              body.idempotency_key || null
            ]
          );

          await enqueuePaymentWhatsApp(client, result.rows[0].payment_id, req.auth.user_id);
          return result.rows[0].payment_id;
        }
      );

      const payment = await query(
        `
        SELECT
          p.*,
          greatest(
            l.total_payable - COALESCE((
              SELECT sum(px.amount)
              FROM payments px
              WHERE px.loan_id=p.loan_id
                AND px.status='POSTED'
            ),0),
            0
          )::numeric(15,2) AS balance_after
        FROM payments p
        JOIN loans l ON l.id=p.loan_id
        WHERE p.id=$1
        `,
        [paymentId]
      );

      const loan = await query(
        `SELECT * FROM v_loan_financials WHERE loan_id = $1`,
        [body.loan_id]
      );

      const whatsapp = { sent: false, queued: true, reason: 'WHATSAPP_QUEUED' };
      scheduleWhatsAppDrain(res);

      res.status(201).json({
        whatsapp,
        payment: payment.rows[0],
        loan: loan.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }
);

const voidSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

paymentsRouter.post(
  '/:id/void',
  requirePermission('PAYMENT_EDIT'),
  async (req, res, next) => {
    try {
      const body = voidSchema.parse(req.body);

      await withTransaction(req.auth.user_id, async (client) => {
        await client.query(
          `SELECT void_payment($1,$2,$3)`,
          [req.params.id, body.reason, req.auth.user_id]
        );
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);
