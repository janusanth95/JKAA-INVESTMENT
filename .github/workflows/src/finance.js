import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { ensureSalaryAdvanceSchema } from './salary-advance.js';

export const financeRouter = express.Router();
financeRouter.use(requireAuth);

const paymentMethodSchema = z.enum(['CASH','BANK','MOBILE','OTHER']);

async function getColomboToday(clientOrPool = null) {
  const runner = clientOrPool || { query };
  const result = await runner.query(
    `(SELECT (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today)`
  );
  return result.rows[0].today;
}

function businessError(message) {
  const error = new Error(message);
  error.code = 'P0001';
  return error;
}

async function reconcileCollectedChargeLedger(userId) {
  return withTransaction(userId, async (client) => {
    const repaired = await client.query(
      `
      INSERT INTO cash_ledger(
        entry_date,direction,category,amount,payment_method,
        source_table,source_id,description,created_by
      )
      SELECT
        COALESCE(lc.collected_date,l.disbursed_date,(now() AT TIME ZONE 'Asia/Colombo')::date),
        'IN',
        'LOAN_CHARGE',
        lc.amount,
        COALESCE(lc.payment_method,disb.payment_method,'CASH'),
        'loan_charges',
        lc.id,
        lc.charge_type || ' charge ledger reconciliation',
        $1
      FROM loan_charges lc
      JOIN loans l ON l.id=lc.loan_id
      LEFT JOIN LATERAL (
        SELECT cl.payment_method
        FROM cash_ledger cl
        WHERE cl.source_table='loans'
          AND cl.source_id=l.id
          AND cl.category='LOAN_DISBURSEMENT'
          AND cl.status='POSTED'
        ORDER BY cl.created_at
        LIMIT 1
      ) disb ON true
      WHERE lc.status='COLLECTED'
        AND lc.amount > 0
        AND NOT EXISTS (
          SELECT 1
          FROM cash_ledger existing
          WHERE existing.source_table='loan_charges'
            AND existing.source_id=lc.id
            AND existing.category='LOAN_CHARGE'
        )
      ON CONFLICT DO NOTHING
      RETURNING amount
      `,
      [userId]
    );

    return {
      repaired_count: repaired.rowCount,
      repaired_amount: repaired.rows
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
        .toFixed(2)
    };
  });
}

async function reconcilePostedSalaryAdvanceLedger(userId) {
  return withTransaction(userId, async (client) => {
    const repaired = await client.query(
      `
      INSERT INTO cash_ledger(
        entry_date,direction,category,amount,payment_method,
        source_table,source_id,description,created_by
      )
      SELECT
        sa.advance_date,
        'OUT',
        'ADJUSTMENT',
        sa.amount,
        sa.payment_method,
        'salary_advances',
        sa.id,
        'Salary Advance - ' || sa.advance_no || ' (ledger reconciliation)',
        $1
      FROM salary_advances sa
      WHERE sa.status='POSTED'
        AND sa.amount > 0
        AND NOT EXISTS (
          SELECT 1
          FROM cash_ledger existing
          WHERE existing.source_table='salary_advances'
            AND existing.source_id=sa.id
            AND existing.category='ADJUSTMENT'
        )
      ON CONFLICT DO NOTHING
      RETURNING amount
      `,
      [userId]
    );

    return {
      repaired_count: repaired.rowCount,
      repaired_amount: repaired.rows
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
        .toFixed(2)
    };
  });
}

async function reconcilePostedSalaryPaymentLedger(userId) {
  return withTransaction(userId, async (client) => {
    const repaired = await client.query(
      `
      INSERT INTO cash_ledger(
        entry_date,direction,category,amount,payment_method,
        source_table,source_id,description,created_by
      )
      SELECT
        sp.payment_date,
        'OUT',
        'ADJUSTMENT',
        sp.amount,
        sp.payment_method,
        'salary_payments',
        sp.id,
        'Salary Payment - ' || sp.payment_no || ' (ledger reconciliation)',
        $1
      FROM salary_payments sp
      WHERE sp.status='POSTED'
        AND sp.amount > 0
        AND NOT EXISTS (
          SELECT 1
          FROM cash_ledger existing
          WHERE existing.source_table='salary_payments'
            AND existing.source_id=sp.id
            AND existing.category='ADJUSTMENT'
        )
      ON CONFLICT DO NOTHING
      RETURNING amount
      `,
      [userId]
    );

    return {
      repaired_count: repaired.rowCount,
      repaired_amount: repaired.rows
        .reduce((sum, row) => sum + Number(row.amount || 0), 0)
        .toFixed(2)
    };
  });
}

// ------------------------------------------------------------
// SUMMARY
// ------------------------------------------------------------
financeRouter.get(
  '/summary',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const chargeLedgerReconciliation = await reconcileCollectedChargeLedger(req.auth.user_id);
      const salaryAdvanceLedgerReconciliation = await reconcilePostedSalaryAdvanceLedger(req.auth.user_id);
      const salaryPaymentLedgerReconciliation = await reconcilePostedSalaryPaymentLedger(req.auth.user_id);
      const result = await query(`
        WITH values AS (
          SELECT
            -- --------------------------------------------------
            -- LOAN CHARGES
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(amount),0)
              FROM loan_charges
              WHERE status='COLLECTED'
                AND charge_type='DOCUMENT'
            )::numeric(15,2) AS document_income,

            (
              SELECT COALESCE(sum(amount),0)
              FROM loan_charges
              WHERE status='COLLECTED'
                AND charge_type='INSURANCE'
            )::numeric(15,2) AS insurance_income,

            (
              SELECT COALESCE(sum(amount),0)
              FROM loan_charges
              WHERE status='COLLECTED'
                AND charge_type='SERVICE'
            )::numeric(15,2) AS service_income,

            -- --------------------------------------------------
            -- ACTUAL CUSTOMER COLLECTIONS
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(amount),0)
              FROM payments
              WHERE status='POSTED'
            )::numeric(15,2) AS collection_income,

            -- --------------------------------------------------
            -- ACTUAL LOAN PRINCIPAL DISBURSED
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(principal),0)
              FROM loans
              WHERE lifecycle_status='DISBURSED'
                AND disbursed_date IS NOT NULL
            )::numeric(15,2) AS loan_disbursed,

            -- --------------------------------------------------
            -- EXPENSES
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(amount),0)
              FROM expenses
              WHERE status='POSTED'
            )::numeric(15,2) AS total_expenses,

            (
              SELECT COALESCE(sum(amount),0)
              FROM expenses
              WHERE status='POSTED'
                AND date_trunc('month',expense_date)
                    = date_trunc(
                        'month',
                        (now() AT TIME ZONE 'Asia/Colombo')::date
                      )
            )::numeric(15,2) AS month_expenses,

            -- --------------------------------------------------
            -- SALARY ADVANCE (POSTED ONLY)
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(amount),0)
              FROM salary_advances
              WHERE status='POSTED'
            )::numeric(15,2) AS salary_advance_total,

            -- --------------------------------------------------
            -- SALARY PAYMENTS (POSTED ONLY)
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(amount),0)
              FROM salary_payments
              WHERE status='POSTED'
            )::numeric(15,2) AS salary_payment_total,

            -- --------------------------------------------------
            -- TRUE INVESTOR CAPITAL ONLY
            -- Legacy Opening / Added Fund is NOT investor capital.
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(
                CASE
                  WHEN t.transaction_type IN ('DEPOSIT','ADJUSTMENT')
                    THEN t.amount
                  WHEN t.transaction_type IN ('WITHDRAWAL','INTEREST_PAID')
                    THEN -t.amount
                  ELSE 0
                END
              ),0)
              FROM investor_transactions t
              JOIN investors i ON i.id=t.investor_id
              WHERE t.status='POSTED'
                AND NOT (
                  i.notes='Imported from old JK Investment backup'
                  AND (
                    upper(COALESCE(t.notes,'')) LIKE 'OPENING FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'ADDED FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'ADD FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'COMPANY FUND%'
                  )
                )
            )::numeric(15,2) AS investor_capital,

            -- --------------------------------------------------
            -- OPENING / ADDED COMPANY FUND
            -- Supports BOTH states:
            -- 1) old importer: stored as legacy investor transaction
            -- 2) corrected importer: stored as Company Fund ADJUSTMENT
            --
            -- Only POSTED rows are counted, so converted/voided rows
            -- cannot be double-counted.
            -- --------------------------------------------------
            (
              COALESCE((
                SELECT sum(
                  CASE
                    WHEN t.transaction_type IN ('DEPOSIT','ADJUSTMENT')
                      THEN t.amount
                    WHEN t.transaction_type IN ('WITHDRAWAL','INTEREST_PAID')
                      THEN -t.amount
                    ELSE 0
                  END
                )
                FROM investor_transactions t
                JOIN investors i ON i.id=t.investor_id
                WHERE t.status='POSTED'
                  AND i.notes='Imported from old JK Investment backup'
                  AND (
                    upper(COALESCE(t.notes,'')) LIKE 'OPENING FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'ADDED FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'ADD FUND%'
                    OR upper(COALESCE(t.notes,'')) LIKE 'COMPANY FUND%'
                  )
              ),0)
              +
              COALESCE((
                SELECT sum(amount)
                FROM cash_ledger
                WHERE status='POSTED'
                  AND direction='IN'
                  AND category='ADJUSTMENT'
                  AND description ILIKE 'Legacy opening & added fund%'
              ),0)
            )::numeric(15,2) AS opening_added_fund,

            -- --------------------------------------------------
            -- DOC & INS STILL DUE
            -- --------------------------------------------------
            (
              SELECT COALESCE(sum(lc.amount),0)
              FROM loan_charges lc
              JOIN loans l ON l.id=lc.loan_id
              WHERE lc.status='DUE'
                AND lc.charge_type IN ('DOCUMENT','INSURANCE','SERVICE')
                AND l.lifecycle_status='DISBURSED'
                AND l.disbursed_date IS NOT NULL
                AND l.disbursed_date
                    <= (now() AT TIME ZONE 'Asia/Colombo')::date
            )::numeric(15,2) AS doc_ins_due
        )
        SELECT
          *,
          (document_income + insurance_income)::numeric(15,2)
            AS doc_ins_income,

          (document_income + insurance_income + service_income)::numeric(15,2)
            AS total_charge_income,

          -- ==================================================
          -- JK COMPANY CASH / AVAILABLE COMPANY FUND FORMULA
          --
          -- Opening & Added Fund
          -- + True Investor Capital
          -- + Loan Collections
          -- + Document Income
          -- + Insurance Income
          -- + Service Income
          -- - Loan Principal Disbursed
          -- - Expenses
          -- - Salary Advance
          -- - Salary Payment
          --
          -- DOCUMENT + INSURANCE + SERVICE are one charge collection
          -- and all three increase Company Cash.
          -- Legacy cash-book snapshots are NOT used here.
          -- ==================================================
          (
            opening_added_fund
            + investor_capital
            + collection_income
            + document_income
            + insurance_income
            + service_income
            - loan_disbursed
            - total_expenses
            - salary_advance_total
            - salary_payment_total
          )::numeric(15,2) AS cash_in_hand
        FROM values
      `);

      res.json({
        summary: result.rows[0],
        company_cash_formula_version: 'v29.0-salary-carry-forward',
        charge_ledger_reconciliation: chargeLedgerReconciliation,
        salary_advance_ledger_reconciliation: salaryAdvanceLedgerReconciliation,
        salary_payment_ledger_reconciliation: salaryPaymentLedgerReconciliation
      });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// CHARGE DEFAULTS
// ------------------------------------------------------------
financeRouter.get(
  '/charge-defaults',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const result = await query(`
        SELECT charge_type,default_amount,active,updated_at
        FROM charge_defaults
        ORDER BY CASE charge_type
          WHEN 'DOCUMENT' THEN 1
          WHEN 'INSURANCE' THEN 2
          WHEN 'SERVICE' THEN 3
          ELSE 9
        END
      `);

      res.json({ defaults: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const defaultsSchema = z.object({
  DOCUMENT: z.coerce.number().min(0).max(10000000),
  INSURANCE: z.coerce.number().min(0).max(10000000),
  SERVICE: z.coerce.number().min(0).max(10000000)
});

financeRouter.put(
  '/charge-defaults',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = defaultsSchema.parse(req.body);

      const rows = await withTransaction(req.auth.user_id, async (client) => {
        const output = [];

        for (const chargeType of ['DOCUMENT','INSURANCE','SERVICE']) {
          const result = await client.query(
            `
            UPDATE charge_defaults
            SET default_amount=$2,
                updated_by=$3,
                updated_at=now()
            WHERE charge_type=$1
            RETURNING charge_type,default_amount,active,updated_at
            `,
            [chargeType, body[chargeType], req.auth.user_id]
          );

          if (result.rowCount) output.push(result.rows[0]);
        }

        return output;
      });

      res.json({ defaults: rows });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// DOC / INS / SERVICE CHARGES
// ------------------------------------------------------------
financeRouter.get(
  '/charges',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string'
        ? req.query.status.toUpperCase()
        : null;
      const centerId = req.query.center_id || null;
      const chargeType = typeof req.query.charge_type === 'string'
        ? req.query.charge_type.toUpperCase()
        : null;

      const result = await query(
        `
        SELECT
          lc.id,
          lc.loan_id,
          lc.charge_type,
          lc.amount,
          lc.status,
          lc.collected_date,
          lc.payment_method,
          lc.notes,
          l.loan_code,
          l.disbursed_date,
          l.center_id,
          c.customer_code,
          c.customer_name,
          c.mobile,
          ce.center_name,
          g.group_name
        FROM loan_charges lc
        JOIN loans l ON l.id=lc.loan_id
        JOIN customers c ON c.id=l.customer_id
        JOIN centers ce ON ce.id=l.center_id
        JOIN groups g ON g.id=l.group_id
        WHERE ($1::text IS NULL OR lc.status=$1)
          AND ($2::uuid IS NULL OR l.center_id=$2)
          AND ($3::text IS NULL OR lc.charge_type=$3)
        ORDER BY
          CASE lc.status WHEN 'DUE' THEN 1 ELSE 2 END,
          COALESCE(lc.collected_date,l.disbursed_date) DESC,
          l.loan_code DESC
        LIMIT 1000
        `,
        [status, centerId, chargeType]
      );

      res.json({ charges: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

financeRouter.get(
  '/charges/center-summary',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const from = req.query.from || null;
      const to = req.query.to || null;

      const result = await query(
        `
        SELECT
          ce.id AS center_id,
          ce.center_name,
          COALESCE(sum(lc.amount) FILTER (
            WHERE lc.charge_type='DOCUMENT' AND lc.status='COLLECTED'
          ),0)::numeric(15,2) AS document_income,
          COALESCE(sum(lc.amount) FILTER (
            WHERE lc.charge_type='INSURANCE' AND lc.status='COLLECTED'
          ),0)::numeric(15,2) AS insurance_income,
          COALESCE(sum(lc.amount) FILTER (
            WHERE lc.charge_type='SERVICE' AND lc.status='COLLECTED'
          ),0)::numeric(15,2) AS service_income,
          COALESCE(sum(lc.amount) FILTER (
            WHERE lc.charge_type IN ('DOCUMENT','INSURANCE')
              AND lc.status='COLLECTED'
          ),0)::numeric(15,2) AS doc_ins_income
        FROM centers ce
        LEFT JOIN loans l ON l.center_id=ce.id
        LEFT JOIN loan_charges lc ON lc.loan_id=l.id
          AND ($1::date IS NULL OR lc.collected_date >= $1::date)
          AND ($2::date IS NULL OR lc.collected_date <= $2::date)
        GROUP BY ce.id,ce.center_name
        ORDER BY ce.center_name
        `,
        [from, to]
      );

      res.json({ centers: result.rows });
    } catch (error) {
      next(error);
    }
  }
);


// Sync charges from loans that were disbursed before auto-collection was added.
// Future-dated legacy test loans are ignored.
financeRouter.post(
  '/charges/sync-disbursed',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const result = await withTransaction(req.auth.user_id, async (client) => {
        const due = await client.query(
          `
          SELECT
            lc.id,
            lc.charge_type,
            lc.amount,
            l.disbursed_date::text AS disbursed_date,
            COALESCE(disb.payment_method,'CASH') AS payment_method
          FROM loan_charges lc
          JOIN loans l ON l.id=lc.loan_id
          LEFT JOIN LATERAL (
            SELECT cl.payment_method
            FROM cash_ledger cl
            WHERE cl.source_table='loans'
              AND cl.source_id=l.id
              AND cl.category='LOAN_DISBURSEMENT'
              AND cl.status='POSTED'
            ORDER BY cl.created_at ASC
            LIMIT 1
          ) disb ON true
          WHERE lc.status='DUE'
            AND l.lifecycle_status='DISBURSED'
            AND l.disbursed_date IS NOT NULL
            AND l.disbursed_date <= (now() AT TIME ZONE 'Asia/Colombo')::date
          FOR UPDATE OF lc
          `
        );

        let totalAmount = 0;

        for (const charge of due.rows) {
          await client.query(
            `
            UPDATE loan_charges
            SET status='COLLECTED',
                collected_date=$2,
                payment_method=$3,
                notes=COALESCE(notes,'Synced as collected at loan disbursement'),
                updated_at=now()
            WHERE id=$1
            `,
            [charge.id, charge.disbursed_date, charge.payment_method]
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
              charge.disbursed_date,
              charge.amount,
              charge.payment_method,
              `${charge.charge_type} charge synced at disbursement`,
              req.auth.user_id
            ]
          );

          totalAmount += Number(charge.amount || 0);
        }

        return {
          synced_count: due.rowCount,
          synced_amount: totalAmount.toFixed(2)
        };
      });

      res.json({ sync: result });
    } catch (error) {
      next(error);
    }
  }
);

const collectChargeSchema = z.object({
  collected_date: z.iso.date(),
  payment_method: paymentMethodSchema.default('CASH'),
  notes: z.string().trim().max(500).optional().nullable()
});

financeRouter.post(
  '/charges/:id/collect',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = collectChargeSchema.parse(req.body);

      const charge = await withTransaction(req.auth.user_id, async (client) => {
        const lock = await client.query(
          `
          SELECT
            lc.*,
            l.disbursed_date::text AS disbursed_date,
            (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo
          FROM loan_charges lc
          JOIN loans l ON l.id=lc.loan_id
          WHERE lc.id=$1
          FOR UPDATE OF lc
          `,
          [req.params.id]
        );

        if (lock.rowCount !== 1) throw businessError('Loan charge not found.');

        const row = lock.rows[0];

        if (row.status !== 'DUE') {
          throw businessError('Only a DUE charge can be collected.');
        }

        if (body.collected_date > row.today_colombo) {
          throw businessError('Future charge collection dates are not allowed.');
        }

        if (row.disbursed_date && body.collected_date < row.disbursed_date) {
          throw businessError('Charge collection date cannot be before loan disbursement.');
        }

        const updated = await client.query(
          `
          UPDATE loan_charges
          SET status='COLLECTED',
              collected_date=$2,
              payment_method=$3,
              notes=$4,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            body.collected_date,
            body.payment_method,
            body.notes || null
          ]
        );

        const existingLedger = await client.query(
          `
          UPDATE cash_ledger
          SET entry_date=$2,
              direction='IN',
              amount=$3,
              payment_method=$4,
              description=$5,
              status='POSTED'
          WHERE source_table='loan_charges'
            AND source_id=$1
            AND category='LOAN_CHARGE'
          `,
          [
            req.params.id,
            body.collected_date,
            row.amount,
            body.payment_method,
            `${row.charge_type} loan charge`
          ]
        );

        if (existingLedger.rowCount === 0) {
          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            VALUES($1,'IN','LOAN_CHARGE',$2,$3,'loan_charges',$4,$5,$6)
            `,
            [
              body.collected_date,
              row.amount,
              body.payment_method,
              req.params.id,
              `${row.charge_type} loan charge`,
              req.auth.user_id
            ]
          );
        }

        return updated.rows[0];
      });

      res.json({ charge });
    } catch (error) {
      next(error);
    }
  }
);

financeRouter.post(
  '/charges/:id/uncollect',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const charge = await withTransaction(req.auth.user_id, async (client) => {
        const lock = await client.query(
          `SELECT * FROM loan_charges WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );

        if (lock.rowCount !== 1) throw businessError('Loan charge not found.');
        if (lock.rows[0].status !== 'COLLECTED') {
          throw businessError('Only a collected charge can be reversed.');
        }

        const updated = await client.query(
          `
          UPDATE loan_charges
          SET status='DUE',
              collected_date=NULL,
              payment_method=NULL,
              notes=NULL,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [req.params.id]
        );

        await client.query(
          `
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE source_table='loan_charges'
            AND source_id=$1
            AND category='LOAN_CHARGE'
          `,
          [req.params.id]
        );

        return updated.rows[0];
      });

      res.json({ charge });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// EXPENSES
// ------------------------------------------------------------
financeRouter.get(
  '/expenses',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const from = req.query.from || null;
      const to = req.query.to || null;

      const result = await query(
        `
        SELECT
          e.*,
          u.full_name AS entered_by_name
        FROM expenses e
        LEFT JOIN users u ON u.id=e.entered_by
        WHERE ($1::date IS NULL OR e.expense_date >= $1::date)
          AND ($2::date IS NULL OR e.expense_date <= $2::date)
        ORDER BY e.expense_date DESC,e.created_at DESC
        LIMIT 1000
        `,
        [from, to]
      );

      res.json({ expenses: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const expenseSchema = z.object({
  expense_date: z.iso.date(),
  category: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  amount: z.coerce.number().positive().max(1000000000),
  payment_method: paymentMethodSchema.default('CASH')
});

financeRouter.post(
  '/expenses',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = expenseSchema.parse(req.body);

      const expense = await withTransaction(req.auth.user_id, async (client) => {
        const today = await getColomboToday(client);

        if (body.expense_date > today) {
          throw businessError('Future expense dates are not allowed.');
        }

        const result = await client.query(
          `
          INSERT INTO expenses(
            expense_date,category,description,amount,payment_method,entered_by
          )
          VALUES($1,$2,$3,$4,$5,$6)
          RETURNING *
          `,
          [
            body.expense_date,
            body.category,
            body.description || null,
            body.amount,
            body.payment_method,
            req.auth.user_id
          ]
        );

        const row = result.rows[0];

        await client.query(
          `
          INSERT INTO cash_ledger(
            entry_date,direction,category,amount,payment_method,
            source_table,source_id,description,created_by
          )
          VALUES($1,'OUT','EXPENSE',$2,$3,'expenses',$4,$5,$6)
          `,
          [
            body.expense_date,
            body.amount,
            body.payment_method,
            row.id,
            body.description || body.category,
            req.auth.user_id
          ]
        );

        return row;
      });

      res.status(201).json({ expense });
    } catch (error) {
      next(error);
    }
  }
);

const voidReasonSchema = z.object({
  reason: z.string().trim().min(3).max(500)
});

financeRouter.post(
  '/expenses/:id/void',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = voidReasonSchema.parse(req.body);

      const expense = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          UPDATE expenses
          SET status='VOIDED',
              voided_at=now(),
              voided_by=$2,
              void_reason=$3,
              updated_at=now()
          WHERE id=$1
            AND status='POSTED'
          RETURNING *
          `,
          [req.params.id, req.auth.user_id, body.reason]
        );

        if (result.rowCount !== 1) {
          throw businessError('Posted expense not found.');
        }

        await client.query(
          `
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE source_table='expenses'
            AND source_id=$1
            AND category='EXPENSE'
          `,
          [req.params.id]
        );

        return result.rows[0];
      });

      res.json({ expense });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// INVESTORS
// ------------------------------------------------------------
financeRouter.get(
  '/investors',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const result = await query(`
        SELECT
          i.*,
          COALESCE(v.current_balance,0)::numeric(15,2) AS current_balance,
          (
            i.notes='Imported from old JK Investment backup'
            AND EXISTS (
              SELECT 1
              FROM investor_transactions t
              WHERE t.investor_id=i.id
                AND (
                  upper(COALESCE(t.notes,'')) LIKE 'OPENING FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'ADDED FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'ADD FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'COMPANY FUND%'
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM investor_transactions t
              WHERE t.investor_id=i.id
                AND NOT (
                  upper(COALESCE(t.notes,'')) LIKE 'OPENING FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'ADDED FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'ADD FUND%'
                  OR upper(COALESCE(t.notes,'')) LIKE 'COMPANY FUND%'
                )
            )
          ) AS is_company_fund
        FROM investors i
        LEFT JOIN v_investor_balances v ON v.investor_id=i.id
        ORDER BY i.investor_name
      `);

      res.json({ investors: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const investorSchema = z.object({
  investor_name: z.string().trim().min(2).max(200),
  mobile: z.string().trim().max(30).optional().nullable(),
  nic: z.string().trim().max(50).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable()
});

financeRouter.post(
  '/investors',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = investorSchema.parse(req.body);

      const investor = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          INSERT INTO investors(
            investor_name,mobile,nic,notes,created_by
          )
          VALUES($1,$2,$3,$4,$5)
          RETURNING *
          `,
          [
            body.investor_name,
            body.mobile || null,
            body.nic || null,
            body.notes || null,
            req.auth.user_id
          ]
        );

        return result.rows[0];
      });

      res.status(201).json({ investor });
    } catch (error) {
      next(error);
    }
  }
);

financeRouter.get(
  '/investor-transactions',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      const investorId = req.query.investor_id || null;

      const result = await query(
        `
        SELECT
          t.*,
          i.investor_name,
          (
            i.notes='Imported from old JK Investment backup'
            AND (
              upper(COALESCE(t.notes,'')) LIKE 'OPENING FUND%'
              OR upper(COALESCE(t.notes,'')) LIKE 'ADDED FUND%'
              OR upper(COALESCE(t.notes,'')) LIKE 'ADD FUND%'
              OR upper(COALESCE(t.notes,'')) LIKE 'COMPANY FUND%'
            )
          ) AS is_company_fund
        FROM investor_transactions t
        JOIN investors i ON i.id=t.investor_id
        WHERE ($1::uuid IS NULL OR t.investor_id=$1)
        ORDER BY t.transaction_date DESC,t.created_at DESC
        LIMIT 1000
        `,
        [investorId]
      );

      res.json({ transactions: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const investorTxnSchema = z.object({
  transaction_date: z.iso.date(),
  transaction_type: z.enum(['DEPOSIT','WITHDRAWAL','INTEREST_PAID']),
  amount: z.coerce.number().positive().max(1000000000),
  payment_method: paymentMethodSchema.default('CASH'),
  notes: z.string().trim().max(500).optional().nullable()
});

financeRouter.post(
  '/investors/:id/transactions',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = investorTxnSchema.parse(req.body);

      const transaction = await withTransaction(req.auth.user_id, async (client) => {
        const today = await getColomboToday(client);

        if (body.transaction_date > today) {
          throw businessError('Future investor transaction dates are not allowed.');
        }

        const investor = await client.query(
          `
          SELECT
            i.*,
            COALESCE(v.current_balance,0)::numeric(15,2) AS current_balance
          FROM investors i
          LEFT JOIN v_investor_balances v ON v.investor_id=i.id
          WHERE i.id=$1
          FOR UPDATE OF i
          `,
          [req.params.id]
        );

        if (investor.rowCount !== 1) throw businessError('Investor not found.');
        if (investor.rows[0].status !== 'ACTIVE') {
          throw businessError('Investor is inactive.');
        }

        if (
          ['WITHDRAWAL','INTEREST_PAID'].includes(body.transaction_type)
          && Number(investor.rows[0].current_balance) < Number(body.amount)
        ) {
          throw businessError('Investor balance is not enough for this transaction.');
        }

        const result = await client.query(
          `
          INSERT INTO investor_transactions(
            investor_id,transaction_date,transaction_type,amount,
            payment_method,notes,entered_by
          )
          VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *
          `,
          [
            req.params.id,
            body.transaction_date,
            body.transaction_type,
            body.amount,
            body.payment_method,
            body.notes || null,
            req.auth.user_id
          ]
        );

        const row = result.rows[0];
        const isDeposit = body.transaction_type === 'DEPOSIT';
        const direction = isDeposit ? 'IN' : 'OUT';
        const category = isDeposit ? 'INVESTOR_DEPOSIT' : 'INVESTOR_WITHDRAWAL';

        await client.query(
          `
          INSERT INTO cash_ledger(
            entry_date,direction,category,amount,payment_method,
            source_table,source_id,description,created_by
          )
          VALUES($1,$2,$3,$4,$5,'investor_transactions',$6,$7,$8)
          `,
          [
            body.transaction_date,
            direction,
            category,
            body.amount,
            body.payment_method,
            row.id,
            `${investor.rows[0].investor_name} - ${body.transaction_type}`,
            req.auth.user_id
          ]
        );

        return row;
      });

      res.status(201).json({ transaction });
    } catch (error) {
      next(error);
    }
  }
);

financeRouter.post(
  '/investor-transactions/:id/void',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = voidReasonSchema.parse(req.body);

      const transaction = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          UPDATE investor_transactions
          SET status='VOIDED',
              voided_at=now(),
              voided_by=$2,
              void_reason=$3
          WHERE id=$1
            AND status='POSTED'
          RETURNING *
          `,
          [req.params.id, req.auth.user_id, body.reason]
        );

        if (result.rowCount !== 1) {
          throw businessError('Posted investor transaction not found.');
        }

        await client.query(
          `
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE source_table='investor_transactions'
            AND source_id=$1
          `,
          [req.params.id]
        );

        return result.rows[0];
      });

      res.json({ transaction });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// CASH BOOK
// ------------------------------------------------------------
financeRouter.get(
  '/cash-book',
  requirePermission('FINANCE_VIEW'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const dateInfo = await query(`
        SELECT
          (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today,
          date_trunc(
            'month',
            (now() AT TIME ZONE 'Asia/Colombo')::date
          )::date::text AS month_start
      `);

      const defaultFrom = dateInfo.rows[0].month_start;
      const defaultTo = dateInfo.rows[0].today;

      const from = String(req.query.from || defaultFrom);
      const to = String(req.query.to || defaultTo);
      const method = String(req.query.payment_method || 'CASH').toUpperCase();

      if (!['ALL','CASH','BANK','MOBILE','OTHER'].includes(method)) {
        throw businessError('Invalid payment method.');
      }

      if (from > to) throw businessError('From date cannot be after To date.');

      const summary = await query(
        `
        SELECT
          COALESCE(sum(
            CASE WHEN cl.direction='IN' THEN cl.amount ELSE -cl.amount END
          ) FILTER (
            WHERE cl.status='POSTED'
              AND cl.entry_date < $1::date
              AND ($3='ALL' OR cl.payment_method=$3)
              AND NOT (
                cl.category='ADJUSTMENT'
                AND cl.description ILIKE 'Legacy opening cash%'
              )
          ),0)::numeric(15,2) AS opening_balance,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.status='POSTED'
              AND cl.direction='IN'
              AND cl.entry_date BETWEEN $1::date AND $2::date
              AND ($3='ALL' OR cl.payment_method=$3)
              AND NOT (
                cl.category='ADJUSTMENT'
                AND cl.description ILIKE 'Legacy opening cash%'
              )
          ),0)::numeric(15,2) AS total_in,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.status='POSTED'
              AND cl.direction='OUT'
              AND cl.entry_date BETWEEN $1::date AND $2::date
              AND ($3='ALL' OR cl.payment_method=$3)
          ),0)::numeric(15,2) AS total_out
        FROM cash_ledger cl
        `,
        [from, to, method]
      );

      const daily = await query(
        `
        SELECT
          cl.entry_date,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='IN'
              AND cl.status='POSTED'
              AND NOT (
                cl.category='ADJUSTMENT'
                AND cl.description ILIKE 'Legacy opening cash%'
              )
          ),0)::numeric(15,2) AS total_in,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT' AND cl.status='POSTED'
          ),0)::numeric(15,2) AS total_out,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='IN'
              AND cl.category='COLLECTION'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS collection,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='IN'
              AND cl.category='LOAN_CHARGE'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS loan_charges,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='IN'
              AND cl.category='INVESTOR_DEPOSIT'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS investor_deposits,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT'
              AND cl.category='LOAN_DISBURSEMENT'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS loan_disbursement,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT'
              AND cl.category='EXPENSE'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS expenses,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT'
              AND cl.category='ADJUSTMENT'
              AND cl.source_table='salary_advances'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS salary_advance,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT'
              AND cl.category='ADJUSTMENT'
              AND cl.source_table='salary_payments'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS salary_payment,

          COALESCE(sum(cl.amount) FILTER (
            WHERE cl.direction='OUT'
              AND cl.category='INVESTOR_WITHDRAWAL'
              AND cl.status='POSTED'
          ),0)::numeric(15,2) AS investor_out

        FROM cash_ledger cl
        WHERE cl.entry_date BETWEEN $1::date AND $2::date
          AND ($3='ALL' OR cl.payment_method=$3)
        GROUP BY cl.entry_date
        ORDER BY cl.entry_date DESC
        `,
        [from, to, method]
      );

      const entries = await query(
        `
        SELECT cl.*
        FROM cash_ledger cl
        WHERE cl.entry_date BETWEEN $1::date AND $2::date
          AND ($3='ALL' OR cl.payment_method=$3)
          AND NOT (
            cl.status='POSTED'
            AND cl.category='ADJUSTMENT'
            AND cl.description ILIKE 'Legacy opening cash%'
          )
        ORDER BY cl.entry_date DESC,cl.created_at DESC
        LIMIT 1000
        `,
        [from, to, method]
      );

      const s = summary.rows[0];
      const closing = (
        Number(s.opening_balance) +
        Number(s.total_in) -
        Number(s.total_out)
      ).toFixed(2);

      res.json({
        filters: { from, to, payment_method: method },
        summary: { ...s, closing_balance: closing },
        daily: daily.rows,
        entries: entries.rows,
        rules: {
          service_income_in_company_cash: true,
          document_insurance_service_are_one_collection: true,
          salary_advance_reduces_company_cash: true,
          salary_payment_reduces_company_cash: true,
          legacy_opening_cash_snapshot_in_company_cash: false
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
