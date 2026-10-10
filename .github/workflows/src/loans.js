import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';


export const loansRouter = express.Router();
loansRouter.use(requireAuth);

function isoWeekday(dateString) {
  const d = new Date(`${dateString}T00:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

function addDaysIso(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonthClampedIso(dateString) {
  const [y, m, day] = dateString.split('-').map(Number);
  const nextMonthStart = new Date(Date.UTC(y, m, 1));
  const nextY = nextMonthStart.getUTCFullYear();
  const nextM = nextMonthStart.getUTCMonth();
  const lastDay = new Date(Date.UTC(nextY, nextM + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return new Date(Date.UTC(nextY, nextM, targetDay)).toISOString().slice(0, 10);
}

function adjustedRepaymentStart(startDate, disbursedDate, loanType) {
  if (startDate >= disbursedDate) return startDate;

  let current = startDate;
  let guard = 0;

  while (current < disbursedDate && guard < 2000) {
    if (loanType === 'DAILY') {
      current = addDaysIso(current, 1);
    } else if (loanType === 'WEEKLY') {
      current = addDaysIso(current, 7);
    } else {
      current = addMonthClampedIso(current);
    }
    guard += 1;
  }

  return current;
}

loansRouter.get(
  '/',
  requirePermission('LOAN_VIEW'),
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string'
        ? req.query.status.toUpperCase()
        : null;
      const centerId = req.query.center_id || null;

      const result = await query(
        `
        SELECT
          vf.*,
          c.customer_code,
          c.customer_name,
          c.nic,
          c.mobile,
          c.default_guarantor_name,
          c.default_guarantor_nic,
          c.default_guarantor_mobile,
          COALESCE(
            (
              SELECT lg.guarantor_name
              FROM loan_guarantors lg
              WHERE lg.loan_id=l.id
              ORDER BY lg.guarantor_order
              LIMIT 1
            ),
            c.default_guarantor_name
          ) AS guarantor_name,
          COALESCE(
            (
              SELECT lg.nic
              FROM loan_guarantors lg
              WHERE lg.loan_id=l.id
              ORDER BY lg.guarantor_order
              LIMIT 1
            ),
            c.default_guarantor_nic
          ) AS guarantor_nic,
          COALESCE(
            (
              SELECT lg.mobile
              FROM loan_guarantors lg
              WHERE lg.loan_id=l.id
              ORDER BY lg.guarantor_order
              LIMIT 1
            ),
            c.default_guarantor_mobile
          ) AS guarantor_mobile,
          ce.center_name,
          g.group_name,
          l.loan_type,
          l.installment_count,
          l.disbursed_date
        FROM v_loan_financials vf
        JOIN loans l ON l.id = vf.loan_id
        JOIN customers c ON c.id = vf.customer_id
        JOIN centers ce ON ce.id = vf.center_id
        JOIN groups g ON g.id = vf.group_id
        WHERE ($1::text IS NULL OR vf.operational_status = $1)
          AND ($2::uuid IS NULL OR vf.center_id = $2)
        ORDER BY l.created_at DESC
        LIMIT 1000
        `,
        [status, centerId]
      );

      res.json({ loans: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const guarantorSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(2).max(200),
  nic: z.string().trim().min(5).max(50),
  mobile: z.string().trim().max(30).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable()
});

const createLoanSchema = z.object({
  customer_id: z.string().uuid(),
  principal: z.coerce.number().positive(),
  interest_rate: z.coerce.number().min(0).max(1000),
  loan_type: z.enum(['DAILY','WEEKLY','MONTHLY']),
  installment_count: z.coerce.number().int().positive().max(1000),
  repayment_start_date: z.iso.date(),
  guarantors: z.array(guarantorSchema).max(2).optional().default([])
});

loansRouter.post(
  '/',
  requirePermission('LOAN_CREATE'),
  async (req, res, next) => {
    try {
      const body = createLoanSchema.parse(req.body);

      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const customerResult = await client.query(
          `
          SELECT c.center_id, c.group_id, ce.collection_isodow
          FROM customers c
          JOIN centers ce ON ce.id = c.center_id
          WHERE c.id = $1 AND c.status = 'ACTIVE'
          `,
          [body.customer_id]
        );

        if (customerResult.rowCount !== 1) {
          const err = new Error('Active customer not found');
          err.code = 'P0001';
          throw err;
        }

        const customer = customerResult.rows[0];

        if (
          body.loan_type === 'WEEKLY' &&
          isoWeekday(body.repayment_start_date) !== Number(customer.collection_isodow)
        ) {
          const err = new Error(
            'Repayment start date must match the selected center collection day.'
          );
          err.code = 'P0001';
          throw err;
        }

        const loanResult = await client.query(
          `
          INSERT INTO loans(
            customer_id,
            center_id,
            group_id,
            principal,
            interest_rate,
            loan_type,
            installment_count,
            repayment_start_date,
            lifecycle_status,
            created_by,
            updated_by
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$9)
          RETURNING *
          `,
          [
            body.customer_id,
            customer.center_id,
            customer.group_id,
            body.principal,
            body.interest_rate,
            body.loan_type,
            body.installment_count,
            body.repayment_start_date,
            req.auth.user_id
          ]
        );

        const newLoan = loanResult.rows[0];

        for (let i = 0; i < body.guarantors.length; i += 1) {
          const g = body.guarantors[i];

          await client.query(
            `
            INSERT INTO loan_guarantors(
              loan_id,
              guarantor_order,
              customer_id,
              guarantor_name,
              nic,
              mobile,
              note
            )
            VALUES($1,$2,$3,$4,$5,$6,$7)
            `,
            [
              newLoan.id,
              i + 1,
              g.customer_id || null,
              g.name,
              g.nic,
              g.mobile || null,
              g.note || null
            ]
          );
        }

        return newLoan;
      });

      res.status(201).json({ loan });
    } catch (error) {
      next(error);
    }
  }
);

const disburseSchema = z.object({
  disbursed_date: z.iso.date(),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH')
});

loansRouter.post(
  '/:id/disburse',
  requirePermission('LOAN_DISBURSE'),
  async (req, res, next) => {
    try {
      const body = disburseSchema.parse(req.body);

      await withTransaction(req.auth.user_id, async (client) => {
        const loanCheck = await client.query(
          `
          SELECT
            lifecycle_status,
            loan_type,
            repayment_start_date::text AS repayment_start_date,
            (created_at AT TIME ZONE 'Asia/Colombo')::date::text AS created_date,
            (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo
          FROM loans
          WHERE id=$1
          FOR UPDATE
          `,
          [req.params.id]
        );

        if (loanCheck.rowCount !== 1) {
          const err = new Error('Loan not found');
          err.code = 'P0001';
          throw err;
        }

        const loan = loanCheck.rows[0];

        if (loan.lifecycle_status !== 'PENDING') {
          const err = new Error('Only PENDING loans can be disbursed');
          err.code = 'P0001';
          throw err;
        }

        if (body.disbursed_date > loan.today_colombo) {
          const err = new Error('Future disbursement dates are not allowed.');
          err.code = 'P0001';
          throw err;
        }

        if (body.disbursed_date < loan.created_date) {
          const err = new Error('Disbursement date cannot be before the loan creation date.');
          err.code = 'P0001';
          throw err;
        }

        const shiftedStart = adjustedRepaymentStart(
          loan.repayment_start_date,
          body.disbursed_date,
          loan.loan_type
        );

        if (shiftedStart !== loan.repayment_start_date) {
          await client.query(
            `
            UPDATE loans
            SET repayment_start_date=$2,
                updated_by=$3
            WHERE id=$1
            `,
            [req.params.id, shiftedStart, req.auth.user_id]
          );
        }

        await client.query(
          `SELECT disburse_loan($1,$2,$3,$4)`,
          [
            req.params.id,
            body.disbursed_date,
            body.payment_method,
            req.auth.user_id
          ]
        );


        // JK Investment rule:
        // Document / Insurance / Service charges are collected automatically
        // when the loan is disbursed. They remain separate income and are NOT
        // part of repayment collection.
        const chargeResult = await client.query(
          `
          UPDATE loan_charges
          SET status='COLLECTED',
              collected_date=$2,
              payment_method=$3,
              notes=COALESCE(notes,'Auto-collected at loan disbursement'),
              updated_at=now()
          WHERE loan_id=$1
            AND status='DUE'
          RETURNING id,charge_type,amount
          `,
          [req.params.id, body.disbursed_date, body.payment_method]
        );

        for (const charge of chargeResult.rows) {
          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            SELECT
              $2,'IN','LOAN_CHARGE',$3,$4,
              'loan_charges',$1,$5,$6
            WHERE NOT EXISTS (
              SELECT 1
              FROM cash_ledger
              WHERE source_table='loan_charges'
                AND source_id=$1
                AND category='LOAN_CHARGE'
                AND status='POSTED'
            )
            `,
            [
              charge.id,
              body.disbursed_date,
              charge.amount,
              body.payment_method,
              `${charge.charge_type} charge auto-collected at disbursement`,
              req.auth.user_id
            ]
          );
        }
      });

      const result = await query(
        `
        SELECT *
        FROM v_loan_financials
        WHERE loan_id = $1
        `,
        [req.params.id]
      );

      res.json({ loan: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

loansRouter.get(
  '/:id',
  requirePermission('LOAN_VIEW'),
  async (req, res, next) => {
    try {
      const financial = await query(
        `
        SELECT
          vf.*,
          l.loan_type,
          l.installment_count,
          l.disbursed_date,
          c.customer_code,
          c.customer_name,
          c.nic,
          c.mobile,
          ce.center_name,
          g.group_name
        FROM v_loan_financials vf
        JOIN loans l ON l.id = vf.loan_id
        JOIN customers c ON c.id = vf.customer_id
        JOIN centers ce ON ce.id = vf.center_id
        JOIN groups g ON g.id = vf.group_id
        WHERE vf.loan_id = $1
        `,
        [req.params.id]
      );

      if (financial.rowCount !== 1) {
        return res.status(404).json({ error: 'LOAN_NOT_FOUND' });
      }

      const [schedule, payments, guarantors, charges] = await Promise.all([
        query(
          `SELECT * FROM v_schedule_status WHERE loan_id = $1 ORDER BY installment_no`,
          [req.params.id]
        ),
        query(
          `
          SELECT *
          FROM payments
          WHERE loan_id = $1
          ORDER BY payment_date DESC, created_at DESC
          `,
          [req.params.id]
        ),
        query(
          `SELECT * FROM loan_guarantors WHERE loan_id = $1 ORDER BY guarantor_order`,
          [req.params.id]
        ),
        query(
          `SELECT * FROM loan_charges WHERE loan_id = $1 ORDER BY charge_type`,
          [req.params.id]
        )
      ]);

      res.json({
        loan: financial.rows[0],
        schedule: schedule.rows,
        payments: payments.rows,
        guarantors: guarantors.rows,
        charges: charges.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

const updatePendingLoanSchema = z.object({
  principal: z.coerce.number().positive(),
  interest_rate: z.coerce.number().min(0).max(1000),
  loan_type: z.enum(['DAILY','WEEKLY','MONTHLY']),
  installment_count: z.coerce.number().int().positive().max(1000),
  repayment_start_date: z.iso.date(),
  guarantors: z.array(guarantorSchema).max(2).optional().default([])
});

loansRouter.put(
  '/:id',
  requirePermission('LOAN_EDIT'),
  async (req, res, next) => {
    try {
      const body = updatePendingLoanSchema.parse(req.body);

      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `
          SELECT l.*,ce.collection_isodow
          FROM loans l
          JOIN centers ce ON ce.id=l.center_id
          WHERE l.id=$1
          FOR UPDATE OF l
          `,
          [req.params.id]
        );

        if (current.rowCount !== 1) {
          const error = new Error('Loan not found');
          error.code = 'P0001';
          throw error;
        }

        if (current.rows[0].lifecycle_status !== 'PENDING') {
          const error = new Error('Only PENDING loans can be edited.');
          error.code = 'P0001';
          throw error;
        }

        if (
          body.loan_type === 'WEEKLY' &&
          isoWeekday(body.repayment_start_date) !== Number(current.rows[0].collection_isodow)
        ) {
          const error = new Error('Repayment start date must match the selected center collection day.');
          error.code = 'P0001';
          throw error;
        }

        const updated = await client.query(
          `
          UPDATE loans
          SET principal=$2,
              interest_rate=$3,
              loan_type=$4,
              installment_count=$5,
              repayment_start_date=$6,
              updated_by=$7,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            body.principal,
            body.interest_rate,
            body.loan_type,
            body.installment_count,
            body.repayment_start_date,
            req.auth.user_id
          ]
        );

        await client.query(`DELETE FROM loan_guarantors WHERE loan_id=$1`, [req.params.id]);

        for (let i = 0; i < body.guarantors.length; i += 1) {
          const g = body.guarantors[i];
          await client.query(
            `
            INSERT INTO loan_guarantors(
              loan_id,guarantor_order,customer_id,guarantor_name,nic,mobile,note
            )
            VALUES($1,$2,$3,$4,$5,$6,$7)
            `,
            [
              req.params.id,
              i + 1,
              g.customer_id || null,
              g.name,
              g.nic,
              g.mobile || null,
              g.note || null
            ]
          );
        }

        return updated.rows[0];
      });

      res.json({ loan });
    } catch (error) {
      next(error);
    }
  }
);

const cancelLoanSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

loansRouter.post(
  '/:id/cancel',
  requirePermission('LOAN_EDIT'),
  async (req, res, next) => {
    try {
      const body = cancelLoanSchema.parse(req.body);

      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          UPDATE loans
          SET lifecycle_status='CANCELLED',
              cancelled_at=now(),
              cancellation_reason=$2,
              updated_by=$3,
              updated_at=now()
          WHERE id=$1
            AND lifecycle_status='PENDING'
          RETURNING *
          `,
          [req.params.id, body.reason, req.auth.user_id]
        );

        if (result.rowCount !== 1) {
          const error = new Error('Only PENDING loans can be cancelled.');
          error.code = 'P0001';
          throw error;
        }

        return result.rows[0];
      });

      res.json({ loan });
    } catch (error) {
      next(error);
    }
  }
);
