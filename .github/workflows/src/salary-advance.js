
import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';

export const salaryAdvanceRouter = express.Router();
salaryAdvanceRouter.use(requireAuth);

let salarySchemaPromise = null;

function businessError(message) {
  const error = new Error(message);
  error.code = 'P0001';
  return error;
}

export async function ensureSalaryAdvanceSchema() {
  if (!salarySchemaPromise) {
    salarySchemaPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS salary_month_limits (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          salary_month DATE NOT NULL UNIQUE,
          salary_limit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (salary_limit >= 0),
          updated_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (salary_month = date_trunc('month', salary_month)::date)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS salary_advances (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          advance_no TEXT NOT NULL UNIQUE,
          salary_month DATE NOT NULL,
          advance_date DATE NOT NULL,
          amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
          payment_method TEXT NOT NULL DEFAULT 'CASH'
            CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'POSTED'
            CHECK (status IN ('POSTED','VOIDED')),
          entered_by UUID REFERENCES users(id),
          voided_by UUID REFERENCES users(id),
          voided_at TIMESTAMPTZ,
          void_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (salary_month = date_trunc('month', salary_month)::date),
          CHECK (advance_date >= salary_month),
          CHECK (advance_date < salary_month + INTERVAL '1 month')
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS salary_payments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          payment_no TEXT NOT NULL UNIQUE,
          salary_month DATE NOT NULL,
          payment_date DATE NOT NULL,
          amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
          payment_method TEXT NOT NULL DEFAULT 'CASH'
            CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'POSTED'
            CHECK (status IN ('POSTED','VOIDED')),
          entered_by UUID REFERENCES users(id),
          voided_by UUID REFERENCES users(id),
          voided_at TIMESTAMPTZ,
          void_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (salary_month = date_trunc('month', salary_month)::date),
          CHECK (payment_date >= salary_month),
          CHECK (payment_date < salary_month + INTERVAL '1 month')
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_salary_advances_month
        ON salary_advances(salary_month, status, advance_date)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_salary_payments_month
        ON salary_payments(salary_month, status, payment_date)
      `);

      await query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_salary_month_limits_audit'
              AND tgrelid='salary_month_limits'::regclass
          ) THEN
            CREATE TRIGGER trg_salary_month_limits_audit
            AFTER INSERT OR UPDATE OR DELETE ON salary_month_limits
            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_salary_advances_audit'
              AND tgrelid='salary_advances'::regclass
          ) THEN
            CREATE TRIGGER trg_salary_advances_audit
            AFTER INSERT OR UPDATE OR DELETE ON salary_advances
            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_no_delete_salary_month_limits'
              AND tgrelid='salary_month_limits'::regclass
          ) THEN
            CREATE TRIGGER trg_no_delete_salary_month_limits
            BEFORE DELETE ON salary_month_limits
            FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_no_delete_salary_advances'
              AND tgrelid='salary_advances'::regclass
          ) THEN
            CREATE TRIGGER trg_no_delete_salary_advances
            BEFORE DELETE ON salary_advances
            FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_salary_payments_audit'
              AND tgrelid='salary_payments'::regclass
          ) THEN
            CREATE TRIGGER trg_salary_payments_audit
            AFTER INSERT OR UPDATE OR DELETE ON salary_payments
            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname='trg_no_delete_salary_payments'
              AND tgrelid='salary_payments'::regclass
          ) THEN
            CREATE TRIGGER trg_no_delete_salary_payments
            BEFORE DELETE ON salary_payments
            FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();
          END IF;
        END $$
      `);
    })();
  }

  try {
    await salarySchemaPromise;
  } catch (error) {
    salarySchemaPromise = null;
    throw error;
  }
}

async function getColomboToday(client = null) {
  const runner = client || { query };
  const result = await runner.query(
    `(SELECT (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today)`
  );
  return result.rows[0].today;
}

function monthStart(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}$/.test(text)) throw businessError('Invalid salary month.');
  return `${text}-01`;
}

export function calculateSalaryFigures({
  salaryLimit,
  advanceTaken,
  previousBalance,
  salaryPaid,
  dueReleased
}) {
  const currentSalaryBalance = Math.max(0, Number(salaryLimit || 0) - Number(advanceTaken || 0));
  const grossPayable = Math.max(0, Number(previousBalance || 0)) + (dueReleased ? currentSalaryBalance : 0);
  const closingRaw = grossPayable - Number(salaryPaid || 0);
  const closingBalance = Math.max(0, closingRaw);

  let paymentStatus = 'UPCOMING';
  if (dueReleased || Number(previousBalance || 0) > 0) {
    if (closingBalance <= 0.005) paymentStatus = 'PAID';
    else if (Number(salaryPaid || 0) > 0) paymentStatus = 'PARTIALLY_PAID';
    else paymentStatus = 'UNPAID';
  }

  return {
    currentSalaryBalance,
    grossPayable,
    closingBalance,
    overpaidAmount: Math.max(0, -closingRaw),
    paymentStatus
  };
}

async function effectiveLimit(client, salaryMonth) {
  const exact = await client.query(
    `SELECT id,salary_month,salary_limit,updated_at FROM salary_month_limits WHERE salary_month=$1`,
    [salaryMonth]
  );
  if (exact.rowCount) return { ...exact.rows[0], inherited: false };

  const previous = await client.query(
    `
    SELECT id,salary_month,salary_limit,updated_at
    FROM salary_month_limits
    WHERE salary_month < $1
    ORDER BY salary_month DESC
    LIMIT 1
    `,
    [salaryMonth]
  );

  if (previous.rowCount) {
    return {
      id: null,
      salary_month: salaryMonth,
      salary_limit: previous.rows[0].salary_limit,
      updated_at: previous.rows[0].updated_at,
      inherited: true
    };
  }

  return {
    id: null,
    salary_month: salaryMonth,
    salary_limit: '0.00',
    updated_at: null,
    inherited: true
  };
}

async function ensureMonthRow(client, salaryMonth, userId) {
  const inherited = await effectiveLimit(client, salaryMonth);
  await client.query(
    `
    INSERT INTO salary_month_limits(salary_month,salary_limit,updated_by)
    VALUES($1,$2,$3)
    ON CONFLICT(salary_month) DO NOTHING
    `,
    [salaryMonth, inherited.salary_limit, userId]
  );

  const locked = await client.query(
    `SELECT * FROM salary_month_limits WHERE salary_month=$1 FOR UPDATE`,
    [salaryMonth]
  );
  return locked.rows[0];
}

async function monthSummary(client, salaryMonth, asOfDate = null) {
  const limit = await effectiveLimit(client, salaryMonth);
  const totals = await client.query(
    `
    SELECT
      COALESCE(sum(amount) FILTER (WHERE status='POSTED'),0)::numeric(15,2) AS advance_taken,
      count(*) FILTER (WHERE status='POSTED')::integer AS posted_count,
      count(*) FILTER (WHERE status='VOIDED')::integer AS voided_count
    FROM salary_advances
    WHERE salary_month=$1
    `,
    [salaryMonth]
  );

  const paymentTotals = await client.query(
    `
    SELECT
      COALESCE(sum(amount) FILTER (WHERE status='POSTED'),0)::numeric(15,2) AS salary_paid,
      count(*) FILTER (WHERE status='POSTED')::integer AS posted_count,
      count(*) FILTER (WHERE status='VOIDED')::integer AS voided_count
    FROM salary_payments
    WHERE salary_month=$1
    `,
    [salaryMonth]
  );

  const today = asOfDate || await getColomboToday(client);
  const dueDate = `${salaryMonth.slice(0,7)}-25`;

  const previous = await client.query(
    `
    WITH bounds AS (
      SELECT LEAST(
        COALESCE((SELECT min(salary_month) FROM salary_month_limits), $1::date),
        COALESCE((SELECT min(salary_month) FROM salary_advances WHERE status='POSTED'), $1::date),
        COALESCE((SELECT min(salary_month) FROM salary_payments WHERE status='POSTED'), $1::date),
        $1::date
      )::date AS start_month
    ), months AS (
      SELECT generate_series(start_month, $1::date - INTERVAL '1 month', INTERVAL '1 month')::date AS salary_month
      FROM bounds
      WHERE start_month < $1::date
    ), monthly AS (
      SELECT
        m.salary_month,
        COALESCE((
          SELECT sml.salary_limit
          FROM salary_month_limits sml
          WHERE sml.salary_month <= m.salary_month
          ORDER BY sml.salary_month DESC
          LIMIT 1
        ),0)::numeric(15,2) AS salary_amount,
        COALESCE((
          SELECT sum(sa.amount)
          FROM salary_advances sa
          WHERE sa.salary_month=m.salary_month AND sa.status='POSTED'
        ),0)::numeric(15,2) AS advance_amount,
        COALESCE((
          SELECT sum(sp.amount)
          FROM salary_payments sp
          WHERE sp.salary_month=m.salary_month AND sp.status='POSTED'
        ),0)::numeric(15,2) AS paid_amount
      FROM months m
    )
    SELECT COALESCE(sum(salary_amount - advance_amount - paid_amount),0)::numeric(15,2) AS balance
    FROM monthly
    `,
    [salaryMonth]
  );

  const advanceTaken = Number(totals.rows[0].advance_taken || 0);
  const salaryLimit = Number(limit.salary_limit || 0);
  const salaryPaid = Number(paymentTotals.rows[0].salary_paid || 0);
  const previousBalance = Math.max(0, Number(previous.rows[0].balance || 0));
  const dueReleased = dueDate <= today;
  const figures = calculateSalaryFigures({
    salaryLimit,
    advanceTaken,
    previousBalance,
    salaryPaid,
    dueReleased
  });

  return {
    salary_month: salaryMonth,
    salary_due_day: 25,
    salary_due_date: dueDate,
    due_released: dueReleased,
    salary_limit: salaryLimit.toFixed(2),
    current_month_salary: salaryLimit.toFixed(2),
    advance_taken: advanceTaken.toFixed(2),
    salary_balance: figures.currentSalaryBalance.toFixed(2),
    previous_balance: previousBalance.toFixed(2),
    gross_payable: figures.grossPayable.toFixed(2),
    salary_paid: salaryPaid.toFixed(2),
    total_payable: figures.closingBalance.toFixed(2),
    closing_balance: figures.closingBalance.toFixed(2),
    overpaid_amount: figures.overpaidAmount.toFixed(2),
    payment_status: figures.paymentStatus,
    posted_count: totals.rows[0].posted_count,
    voided_count: totals.rows[0].voided_count,
    payment_posted_count: paymentTotals.rows[0].posted_count,
    payment_voided_count: paymentTotals.rows[0].voided_count,
    limit_inherited: !!limit.inherited
  };
}

salaryAdvanceRouter.get(
  '/',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const today = await getColomboToday();
      const selectedMonth = monthStart(req.query.month || today.slice(0,7));

      if (selectedMonth > `${today.slice(0,7)}-01`) {
        throw businessError('Future salary months are not allowed.');
      }

      const summary = await monthSummary({ query }, selectedMonth, today);
      const entries = await query(
        `
        SELECT
          sa.*,
          COALESCE(u.full_name,u.username,'-') AS entered_by_name,
          COALESCE(v.full_name,v.username,'-') AS voided_by_name
        FROM salary_advances sa
        LEFT JOIN users u ON u.id=sa.entered_by
        LEFT JOIN users v ON v.id=sa.voided_by
        WHERE sa.salary_month=$1
        ORDER BY sa.advance_date DESC,sa.created_at DESC
        `,
        [selectedMonth]
      );

      const payments = await query(
        `
        SELECT
          sp.*,
          COALESCE(u.full_name,u.username,'-') AS entered_by_name,
          COALESCE(v.full_name,v.username,'-') AS voided_by_name
        FROM salary_payments sp
        LEFT JOIN users u ON u.id=sp.entered_by
        LEFT JOIN users v ON v.id=sp.voided_by
        WHERE sp.salary_month=$1
        ORDER BY sp.payment_date DESC,sp.created_at DESC
        `,
        [selectedMonth]
      );

      res.json({ summary, advances: entries.rows, payments: payments.rows, today });
    } catch (error) {
      next(error);
    }
  }
);

const limitSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  salary_limit: z.coerce.number().min(0).max(100000000)
});

salaryAdvanceRouter.put(
  '/limit',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const body = limitSchema.parse(req.body);
      const salaryMonth = monthStart(body.month);
      const today = await getColomboToday();

      if (salaryMonth > `${today.slice(0,7)}-01`) {
        throw businessError('Future salary months are not allowed.');
      }

      const result = await withTransaction(req.auth.user_id, async (client) => {
        await ensureMonthRow(client, salaryMonth, req.auth.user_id);

        const taken = await client.query(
          `
          SELECT COALESCE(sum(amount),0)::numeric(15,2) AS total
          FROM salary_advances
          WHERE salary_month=$1 AND status='POSTED'
          `,
          [salaryMonth]
        );

        const advanceTaken = Number(taken.rows[0].total || 0);
        if (Number(body.salary_limit) + 0.005 < advanceTaken) {
          throw businessError(
            `Salary Limit cannot be below already taken advance Rs. ${advanceTaken.toFixed(2)}.`
          );
        }

        await client.query(
          `
          UPDATE salary_month_limits
          SET salary_limit=$2,updated_by=$3,updated_at=now()
          WHERE salary_month=$1
          `,
          [salaryMonth, body.salary_limit, req.auth.user_id]
        );

        const summary = await monthSummary(client, salaryMonth, today);
        if (Number(summary.overpaid_amount) > 0.005) {
          throw businessError('Salary Limit cannot be reduced below advances and salary payments already posted.');
        }
        return summary;
      });

      res.json({ ok:true, message:'Salary Limit updated.', summary:await result });
    } catch (error) {
      next(error);
    }
  }
);

const advanceSchema = z.object({
  advance_date: z.iso.date(),
  amount: z.coerce.number().positive().max(100000000),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH'),
  notes: z.string().trim().max(500).optional().nullable()
});

salaryAdvanceRouter.post(
  '/',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const body = advanceSchema.parse(req.body);
      const today = await getColomboToday();

      if (body.advance_date > today) {
        throw businessError('Future Salary Advance dates are not allowed.');
      }

      const salaryMonth = `${body.advance_date.slice(0,7)}-01`;

      const saved = await withTransaction(req.auth.user_id, async (client) => {
        const limitRow = await ensureMonthRow(client, salaryMonth, req.auth.user_id);

        const taken = await client.query(
          `
          SELECT COALESCE(sum(amount),0)::numeric(15,2) AS total
          FROM salary_advances
          WHERE salary_month=$1 AND status='POSTED'
          `,
          [salaryMonth]
        );

        const salaryLimit = Number(limitRow.salary_limit || 0);
        const advanceTaken = Number(taken.rows[0].total || 0);
        const remaining = salaryLimit - advanceTaken;

        if (salaryLimit <= 0) {
          throw businessError('Set the Salary Limit before entering an advance.');
        }

        if (Number(body.amount) > remaining + 0.005) {
          throw businessError(
            `Advance exceeds Salary Balance. Available Rs. ${Math.max(0,remaining).toFixed(2)}.`
          );
        }

        // Month row is locked, so numbering + limit validation is serialized.
        const seq = await client.query(
          `SELECT count(*)::integer + 1 AS next_no FROM salary_advances WHERE salary_month=$1`,
          [salaryMonth]
        );
        const advanceNo = `JK-SA-${salaryMonth.slice(0,7).replace('-','')}-${String(seq.rows[0].next_no).padStart(3,'0')}`;

        const inserted = await client.query(
          `
          INSERT INTO salary_advances(
            advance_no,salary_month,advance_date,amount,payment_method,notes,entered_by
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *
          `,
          [
            advanceNo,
            salaryMonth,
            body.advance_date,
            body.amount,
            body.payment_method,
            body.notes || null,
            req.auth.user_id
          ]
        );

        await client.query(
          `
          INSERT INTO cash_ledger(
            entry_date,direction,category,amount,payment_method,
            source_table,source_id,description,created_by
          )
          VALUES($1,'OUT','ADJUSTMENT',$2,$3,'salary_advances',$4,$5,$6)
          `,
          [
            body.advance_date,
            body.amount,
            body.payment_method,
            inserted.rows[0].id,
            `Salary Advance - ${advanceNo}`,
            req.auth.user_id
          ]
        );

        return inserted.rows[0];
      });

      res.status(201).json({
        ok:true,
        message:'Salary Advance saved successfully.',
        advance:saved
      });
    } catch (error) {
      next(error);
    }
  }
);

const salaryPaymentSchema = z.object({
  payment_date: z.iso.date(),
  amount: z.coerce.number().positive().max(100000000),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH'),
  notes: z.string().trim().max(500).optional().nullable()
});

salaryAdvanceRouter.post(
  '/payment',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const body = salaryPaymentSchema.parse(req.body);
      const today = await getColomboToday();

      if (body.payment_date > today) {
        throw businessError('Future Salary Payment dates are not allowed.');
      }

      const salaryMonth = `${body.payment_date.slice(0,7)}-01`;

      const saved = await withTransaction(req.auth.user_id, async (client) => {
        await ensureMonthRow(client, salaryMonth, req.auth.user_id);

        const summary = await monthSummary(client, salaryMonth, body.payment_date);
        const available = Number(summary.total_payable || 0);

        if (available <= 0.005) {
          if (!summary.due_released && Number(summary.previous_balance || 0) <= 0.005) {
            throw businessError(`Salary becomes payable on ${summary.salary_due_date}.`);
          }
          throw businessError('No unpaid Salary Balance is available.');
        }

        if (Number(body.amount) > available + 0.005) {
          throw businessError(
            `Salary Payment exceeds Total Payable. Available Rs. ${available.toFixed(2)}.`
          );
        }

        const seq = await client.query(
          `SELECT count(*)::integer + 1 AS next_no FROM salary_payments WHERE salary_month=$1`,
          [salaryMonth]
        );
        const paymentNo = `JK-SP-${salaryMonth.slice(0,7).replace('-','')}-${String(seq.rows[0].next_no).padStart(3,'0')}`;

        const inserted = await client.query(
          `
          INSERT INTO salary_payments(
            payment_no,salary_month,payment_date,amount,payment_method,notes,entered_by
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *
          `,
          [
            paymentNo,
            salaryMonth,
            body.payment_date,
            body.amount,
            body.payment_method,
            body.notes || null,
            req.auth.user_id
          ]
        );

        await client.query(
          `
          INSERT INTO cash_ledger(
            entry_date,direction,category,amount,payment_method,
            source_table,source_id,description,created_by
          )
          VALUES($1,'OUT','ADJUSTMENT',$2,$3,'salary_payments',$4,$5,$6)
          `,
          [
            body.payment_date,
            body.amount,
            body.payment_method,
            inserted.rows[0].id,
            `Salary Payment - ${paymentNo}`,
            req.auth.user_id
          ]
        );

        return inserted.rows[0];
      });

      res.status(201).json({
        ok:true,
        message:'Salary Payment saved successfully.',
        payment:saved
      });
    } catch (error) {
      next(error);
    }
  }
);

const voidSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

salaryAdvanceRouter.post(
  '/:id/void',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const body = voidSchema.parse(req.body);

      const result = await withTransaction(req.auth.user_id, async (client) => {
        const found = await client.query(
          `SELECT * FROM salary_advances WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );
        if (found.rowCount !== 1) throw businessError('Salary Advance not found.');
        const row = found.rows[0];
        if (row.status !== 'POSTED') throw businessError('Salary Advance is already voided.');

        await client.query(
          `
          UPDATE salary_advances
          SET status='VOIDED',voided_by=$2,voided_at=now(),void_reason=$3,updated_at=now()
          WHERE id=$1
          `,
          [row.id, req.auth.user_id, body.reason]
        );

        await client.query(
          `
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE source_table='salary_advances'
            AND source_id=$1
            AND status='POSTED'
          `,
          [row.id]
        );

        return row;
      });

      res.json({ ok:true, message:'Salary Advance voided.', advance:result });
    } catch (error) {
      next(error);
    }
  }
);

salaryAdvanceRouter.post(
  '/payment/:id/void',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const body = voidSchema.parse(req.body);

      const result = await withTransaction(req.auth.user_id, async (client) => {
        const found = await client.query(
          `SELECT * FROM salary_payments WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );
        if (found.rowCount !== 1) throw businessError('Salary Payment not found.');
        const row = found.rows[0];
        if (row.status !== 'POSTED') throw businessError('Salary Payment is already voided.');

        await client.query(
          `
          UPDATE salary_payments
          SET status='VOIDED',voided_by=$2,voided_at=now(),void_reason=$3,updated_at=now()
          WHERE id=$1
          `,
          [row.id, req.auth.user_id, body.reason]
        );

        await client.query(
          `
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE source_table='salary_payments'
            AND source_id=$1
            AND status='POSTED'
          `,
          [row.id]
        );

        return row;
      });

      res.json({ ok:true, message:'Salary Payment voided.', payment:result });
    } catch (error) {
      next(error);
    }
  }
);
