import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

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
          const loanCheck = await client.query(
            `
            SELECT
              lifecycle_status,
              disbursed_date::text AS disbursed_date,
              (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo
            FROM loans
            WHERE id=$1
            FOR UPDATE
            `,
            [body.loan_id]
          );

          if (loanCheck.rowCount !== 1) {
            const err = new Error('Loan not found');
            err.code = 'P0001';
            throw err;
          }

          const loan = loanCheck.rows[0];

          if (loan.lifecycle_status !== 'DISBURSED') {
            const err = new Error('Payments are allowed only for disbursed active loans.');
            err.code = 'P0001';
            throw err;
          }

          if (body.payment_date > loan.today_colombo) {
            const err = new Error('Future payment dates are not allowed.');
            err.code = 'P0001';
            throw err;
          }

          if (loan.disbursed_date && body.payment_date < loan.disbursed_date) {
            const err = new Error('Payment date cannot be before the loan disbursement date.');
            err.code = 'P0001';
            throw err;
          }

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

          return result.rows[0].payment_id;
        }
      );

      const payment = await query(
        `SELECT * FROM payments WHERE id = $1`,
        [paymentId]
      );

      const loan = await query(
        `SELECT * FROM v_loan_financials WHERE loan_id = $1`,
        [body.loan_id]
      );

      res.status(201).json({
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
        const current = await client.query(
          `SELECT loan_id FROM payments WHERE id=$1 AND status='POSTED' FOR UPDATE`,
          [req.params.id]
        );

        if (current.rowCount !== 1) {
          const error = new Error('Posted payment not found.');
          error.code = 'P0001';
          throw error;
        }

        await client.query(
          `SELECT void_payment($1,$2,$3)`,
          [req.params.id, body.reason, req.auth.user_id]
        );

        await reallocateLoanPayments(client, current.rows[0].loan_id);
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

async function reallocateLoanPayments(client, loanId) {
  await client.query(
    `
    DELETE FROM payment_allocations
    WHERE payment_id IN (
      SELECT id FROM payments WHERE loan_id=$1
    )
    `,
    [loanId]
  );

  const posted = await client.query(
    `
    SELECT id
    FROM payments
    WHERE loan_id=$1 AND status='POSTED'
    ORDER BY payment_date,created_at,id
    `,
    [loanId]
  );

  for (const row of posted.rows) {
    await client.query(`SELECT allocate_payment_fifo($1)`, [row.id]);
  }
}

paymentsRouter.get(
  '/',
  requirePermission('REPORT_VIEW'),
  async (req, res, next) => {
    try {
      const loanId = req.query.loan_id || null;
      const customerId = req.query.customer_id || null;
      const from = req.query.from || null;
      const to = req.query.to || null;
      const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;

      const result = await query(
        `
        SELECT
          p.*,
          l.loan_code,
          c.customer_code,
          c.customer_name,
          c.mobile,
          ce.center_name,
          g.group_name
        FROM payments p
        JOIN loans l ON l.id=p.loan_id
        JOIN customers c ON c.id=p.customer_id
        JOIN centers ce ON ce.id=p.center_id
        JOIN groups g ON g.id=l.group_id
        WHERE ($1::uuid IS NULL OR p.loan_id=$1)
          AND ($2::uuid IS NULL OR p.customer_id=$2)
          AND ($3::date IS NULL OR p.payment_date >= $3::date)
          AND ($4::date IS NULL OR p.payment_date <= $4::date)
          AND ($5::text IS NULL OR p.status=$5)
        ORDER BY p.payment_date DESC,p.created_at DESC
        LIMIT 1000
        `,
        [loanId, customerId, from, to, status]
      );

      res.json({ payments: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const editPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  payment_date: z.iso.date(),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH'),
  notes: z.string().trim().max(500).optional().nullable()
});

paymentsRouter.put(
  '/:id',
  requirePermission('PAYMENT_EDIT'),
  async (req, res, next) => {
    try {
      const body = editPaymentSchema.parse(req.body);

      const payment = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `
          SELECT p.*,l.disbursed_date::text AS disbursed_date,
                 (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo
          FROM payments p
          JOIN loans l ON l.id=p.loan_id
          WHERE p.id=$1
          FOR UPDATE OF p
          `,
          [req.params.id]
        );

        if (current.rowCount !== 1 || current.rows[0].status !== 'POSTED') {
          const error = new Error('Posted payment not found.');
          error.code = 'P0001';
          throw error;
        }

        const old = current.rows[0];

        if (body.payment_date > old.today_colombo) {
          const error = new Error('Future payment dates are not allowed.');
          error.code = 'P0001';
          throw error;
        }

        if (old.disbursed_date && body.payment_date < old.disbursed_date) {
          const error = new Error('Payment date cannot be before loan disbursement.');
          error.code = 'P0001';
          throw error;
        }

        const updated = await client.query(
          `
          UPDATE payments
          SET amount=$2,
              payment_date=$3,
              payment_method=$4,
              notes=$5,
              edited_by=$6,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            body.amount,
            body.payment_date,
            body.payment_method,
            body.notes || null,
            req.auth.user_id
          ]
        );

        await client.query(
          `
          UPDATE cash_ledger
          SET entry_date=$2,
              amount=$3,
              payment_method=$4,
              description='Loan collection payment (edited)'
          WHERE source_table='payments'
            AND source_id=$1
            AND category='COLLECTION'
            AND status='POSTED'
          `,
          [req.params.id, body.payment_date, body.amount, body.payment_method]
        );

        await reallocateLoanPayments(client, old.loan_id);
        return updated.rows[0];
      });

      res.json({ payment });
    } catch (error) {
      next(error);
    }
  }
);
