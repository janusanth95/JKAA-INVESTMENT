import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const loansRouter = express.Router();
loansRouter.use(requireAuth);

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
          SELECT center_id, group_id
          FROM customers
          WHERE id = $1 AND status = 'ACTIVE'
          FOR UPDATE
          `,
          [body.customer_id]
        );

        if (customerResult.rowCount !== 1) {
          const err = new Error('Active customer not found');
          err.code = 'P0001';
          throw err;
        }

        const customer = customerResult.rows[0];

        // The customer row lock above serializes concurrent create requests.
        // Read after acquiring it so a waiting request sees the committed loan.
        const existingLoan = await client.query(
          `
          SELECT loan_id, loan_code, operational_status, balance
          FROM v_loan_financials
          WHERE customer_id = $1
            AND (lifecycle_status = 'PENDING'
              OR (lifecycle_status = 'DISBURSED' AND balance > 0))
          ORDER BY loan_code
          LIMIT 1
          `,
          [body.customer_id]
        );

        if (existingLoan.rowCount) {
          const existing = existingLoan.rows[0];
          const err = new Error(
            `This customer already has an open loan (${existing.loan_code}, ${existing.operational_status}). Close the existing loan, or cancel it if pending, before creating another.`
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

// The edit form submits the same terms as creation, without changing the borrower.
const updatePendingLoanSchema = createLoanSchema.omit({ customer_id: true });

loansRouter.put(
  '/:id',
  requirePermission('LOAN_EDIT'),
  async (req, res, next) => {
    try {
      const body = updatePendingLoanSchema.parse(req.body);
      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `SELECT id, lifecycle_status FROM loans WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );
        if (current.rowCount !== 1) {
          const error = new Error('Loan not found');
          error.code = 'P0001';
          throw error;
        }
        if (current.rows[0].lifecycle_status !== 'PENDING') {
          const error = new Error('Only pending loans can have their financial terms edited.');
          error.code = 'P0001';
          throw error;
        }
        // Database validation retains center-day rules and calculated totals.
        const updated = await client.query(
          `UPDATE loans
           SET principal=$2, interest_rate=$3, loan_type=$4,
               installment_count=$5, repayment_start_date=$6,
               updated_by=$7, updated_at=now()
           WHERE id=$1 AND lifecycle_status='PENDING'
           RETURNING *`,
          [req.params.id, body.principal, body.interest_rate, body.loan_type,
            body.installment_count, body.repayment_start_date, req.auth.user_id]
        );
        await client.query(`DELETE FROM loan_guarantors WHERE loan_id=$1`, [req.params.id]);
        for (let i = 0; i < body.guarantors.length; i += 1) {
          const g = body.guarantors[i];
          await client.query(
            `INSERT INTO loan_guarantors(
               loan_id,guarantor_order,customer_id,guarantor_name,nic,mobile,note
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [req.params.id, i + 1, g.customer_id || null, g.name, g.nic,
              g.mobile || null, g.note || null]
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
  reason: z.string().trim().min(2).max(500)
});

loansRouter.post(
  '/:id/cancel',
  requirePermission('LOAN_EDIT'),
  async (req, res, next) => {
    try {
      const body = cancelLoanSchema.parse(req.body);

      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `
          SELECT id, loan_code, lifecycle_status
          FROM loans
          WHERE id = $1
          FOR UPDATE
          `,
          [req.params.id]
        );

        if (current.rowCount !== 1) {
          const error = new Error('Loan not found');
          error.code = 'P0001';
          throw error;
        }

        if (current.rows[0].lifecycle_status !== 'PENDING') {
          const error = new Error('Only pending loans can be cancelled');
          error.code = 'P0001';
          throw error;
        }

        const cancelled = await client.query(
          `
          UPDATE loans
          SET lifecycle_status = 'CANCELLED',
              cancellation_reason = $2,
              updated_by = $3,
              updated_at = now()
          WHERE id = $1
            AND lifecycle_status = 'PENDING'
          RETURNING id, loan_code, lifecycle_status, cancellation_reason
          `,
          [req.params.id, body.reason, req.auth.user_id]
        );

        return cancelled.rows[0];
      });

      res.json({
        ok: true,
        message: 'Pending loan cancelled.',
        loan
      });
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
        await client.query(
          `SELECT disburse_loan($1,$2,$3,$4)`,
          [
            req.params.id,
            body.disbursed_date,
            body.payment_method,
            req.auth.user_id
          ]
        );

        // A disbursement receives DOCUMENT, INSURANCE and SERVICE charges
        // at the counter. Keep each charge as its own record and collect all
        // of them in the same transaction so income can never be missed.
        const charges = await client.query(
          `
          SELECT id, charge_type, amount
          FROM loan_charges
          WHERE loan_id=$1
            AND status='DUE'
            AND charge_type IN ('DOCUMENT','INSURANCE','SERVICE')
          FOR UPDATE
          `,
          [req.params.id]
        );

        for (const charge of charges.rows) {
          await client.query(
            `
            UPDATE loan_charges
            SET status='COLLECTED',
                collected_date=$2,
                payment_method=$3,
                notes=COALESCE(notes,'Automatically collected at loan disbursement'),
                updated_at=now()
            WHERE id=$1
            `,
            [charge.id, body.disbursed_date, body.payment_method]
          );

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
              `${charge.charge_type} charge collected at disbursement`,
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

const disbursedEditSchema = z.object({
  disbursed_date: z.iso.date(),
  repayment_start_date: z.iso.date(),
  guarantors: z.array(guarantorSchema).max(2).optional().default([])
});

loansRouter.put(
  '/:id/disbursed-details',
  requirePermission('LOAN_DISBURSE'),
  async (req, res, next) => {
    try {
      const body = disbursedEditSchema.parse(req.body);

      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `
          SELECT
            l.id,l.lifecycle_status,l.loan_type,l.disbursed_date,
            to_char(l.repayment_start_date,'YYYY-MM-DD') AS repayment_start_date_iso,
            ce.collection_isodow
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

        if (current.rows[0].lifecycle_status !== 'DISBURSED') {
          const error = new Error('Only disbursed loans can be edited here');
          error.code = 'P0001';
          throw error;
        }

        const existing = current.rows[0];
        const repaymentDateChanged =
          existing.repayment_start_date_iso !== body.repayment_start_date;

        if (new Date(body.repayment_start_date) < new Date(body.disbursed_date)) {
          const error = new Error('Repayment date cannot be before the disbursed date.');
          error.code = 'P0001';
          throw error;
        }

        if (repaymentDateChanged) {
          const dayCheck = await client.query(
            `SELECT EXTRACT(ISODOW FROM $1::date)::int AS repayment_isodow`,
            [body.repayment_start_date]
          );

          if (Number(dayCheck.rows[0].repayment_isodow) !==
              Number(existing.collection_isodow)) {
            const error = new Error(
              'Repayment date must match the Center collection day.'
            );
            error.code = 'P0001';
            throw error;
          }

          const paymentCheck = await client.query(
            `
            SELECT EXISTS(
              SELECT 1 FROM payments
              WHERE loan_id=$1 AND status='POSTED'
            ) AS has_payments
            `,
            [req.params.id]
          );

          if (paymentCheck.rows[0].has_payments) {
            const error = new Error(
              'Repayment date cannot be changed after a payment has been recorded.'
            );
            error.code = 'P0001';
            throw error;
          }

          await client.query(
            `
            UPDATE loan_schedule
            SET due_date = CASE $2
              WHEN 'DAILY' THEN
                $3::date + (installment_no - 1)
              WHEN 'WEEKLY' THEN
                $3::date + ((installment_no - 1) * 7)
              WHEN 'MONTHLY' THEN
                ($3::date + make_interval(months => installment_no - 1))::date
              ELSE due_date
            END
            WHERE loan_id=$1
            `,
            [req.params.id, existing.loan_type, body.repayment_start_date]
          );
        }

        const updated = await client.query(
          `
          UPDATE loans
          SET disbursed_date=$2,
              repayment_start_date=$3,
              updated_by=$4,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            body.disbursed_date,
            body.repayment_start_date,
            req.auth.user_id
          ]
        );

        await client.query(
          `DELETE FROM loan_guarantors WHERE loan_id=$1`,
          [req.params.id]
        );

        for (let i = 0; i < body.guarantors.length; i += 1) {
          const guarantor = body.guarantors[i];
          await client.query(
            `
            INSERT INTO loan_guarantors(
              loan_id,guarantor_order,customer_id,
              guarantor_name,nic,mobile,note
            )
            VALUES($1,$2,$3,$4,$5,$6,$7)
            `,
            [
              req.params.id,
              i + 1,
              guarantor.customer_id || null,
              guarantor.name,
              guarantor.nic,
              guarantor.mobile || null,
              guarantor.note || null
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

loansRouter.delete(
  '/:id',
  requirePermission('LOAN_DISBURSE'),
  async (req, res, next) => {
    try {
      const loan = await withTransaction(req.auth.user_id, async (client) => {
        const current = await client.query(
          `
          SELECT id,loan_code,lifecycle_status
          FROM loans
          WHERE id=$1
          FOR UPDATE
          `,
          [req.params.id]
        );

        if (current.rowCount !== 1) {
          const error = new Error('Loan not found');
          error.code = 'P0001';
          throw error;
        }

        if (current.rows[0].lifecycle_status !== 'DISBURSED') {
          const error = new Error('Only disbursed loans can be removed here');
          error.code = 'P0001';
          throw error;
        }

        const activity = await client.query(
          `
          SELECT
            EXISTS(
              SELECT 1 FROM payments
              WHERE loan_id=$1 AND status='POSTED'
            ) AS has_payments,
            EXISTS(
              SELECT 1 FROM loan_charges
              WHERE loan_id=$1 AND status='COLLECTED'
            ) AS has_collected_charges
          `,
          [req.params.id]
        );

        if (activity.rows[0].has_payments || activity.rows[0].has_collected_charges) {
          const error = new Error(
            'Delete blocked: this loan already has payments or collected charges.'
          );
          error.code = 'P0001';
          throw error;
        }

        const cancelled = await client.query(
          `
          UPDATE loans
          SET lifecycle_status='CANCELLED',
              cancellation_reason='Removed from Disbursed Loans by admin',
              updated_by=$2,
              updated_at=now()
          WHERE id=$1
          RETURNING id,loan_code,lifecycle_status
          `,
          [req.params.id, req.auth.user_id]
        );

        return cancelled.rows[0];
      });

      res.json({
        ok: true,
        message: 'Disbursed loan removed safely.',
        loan
      });
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

