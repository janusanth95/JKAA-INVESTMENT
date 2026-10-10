import express from 'express';

import { query } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { ensureSalaryAdvanceSchema } from '../salary-advance.js';

export const dashboardRouter = express.Router();

dashboardRouter.get(
  '/',
  requireAuth,
  requirePermission('REPORT_VIEW'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      const result = await query(
        `
        SELECT
          (SELECT count(*) FROM customers WHERE status='ACTIVE') AS active_customers,

          (SELECT count(*) FROM v_loan_financials WHERE operational_status='ACTIVE') AS active_loans,
          (SELECT count(*) FROM v_loan_financials WHERE operational_status='OC') AS oc_loans,
          (SELECT count(*) FROM v_loan_financials WHERE operational_status='CLOSED') AS closed_loans,

          (
            SELECT COALESCE(sum(principal),0)
            FROM loans
            WHERE lifecycle_status='DISBURSED'
          ) AS total_principal_disbursed,

          (
            SELECT COALESCE(sum(balance),0)
            FROM v_loan_financials
            WHERE lifecycle_status='DISBURSED'
          ) AS total_balance,

          (
            SELECT COALESCE(sum(arrears),0)
            FROM v_loan_financials
            WHERE lifecycle_status='DISBURSED'
          ) AS total_arrears,

          (
            SELECT COALESCE(sum(amount),0)
            FROM payments
            WHERE status='POSTED'
              AND payment_date=(now() AT TIME ZONE 'Asia/Colombo')::date
          ) AS today_collection,

          (
            SELECT COALESCE(sum(amount),0)
            FROM payments
            WHERE status='POSTED'
              AND date_trunc('month',payment_date)
                  = date_trunc('month',(now() AT TIME ZONE 'Asia/Colombo')::date)
          ) AS month_collection,

          (SELECT count(*) FROM v_not_paid_today) AS not_paid_today,

          (
            SELECT COALESCE(
              sum(CASE WHEN direction='IN' THEN amount ELSE -amount END),
              0
            )
            FROM cash_ledger
            WHERE status='POSTED'
              AND payment_method='CASH'
          ) AS cash_in_hand
        `
      );

      const [centerCollections, monthTrend, profit] = await Promise.all([
        query(`
          SELECT ce.id AS center_id, ce.center_name,
                 COALESCE(sum(p.amount),0)::numeric(15,2) AS collection
          FROM centers ce
          LEFT JOIN payments p
            ON p.center_id=ce.id
           AND p.status='POSTED'
           AND p.payment_date=(now() AT TIME ZONE 'Asia/Colombo')::date
          GROUP BY ce.id,ce.center_name
          ORDER BY ce.center_name
        `),
        query(`
          SELECT day::date AS date,
                 COALESCE(sum(p.amount),0)::numeric(15,2) AS collection
          FROM generate_series(
            date_trunc('month',(now() AT TIME ZONE 'Asia/Colombo')::date)::date,
            (now() AT TIME ZONE 'Asia/Colombo')::date,
            interval '1 day'
          ) day
          LEFT JOIN payments p
            ON p.payment_date=day::date
           AND p.status='POSTED'
          GROUP BY day
          ORDER BY day
        `),
        query(`
          SELECT
            COALESCE(sum(
              p.amount * GREATEST(l.total_payable-l.principal,0)
              / NULLIF(l.total_payable,0)
            ),0)::numeric(15,2) AS month_interest_income,
            COALESCE((
              SELECT sum(lc.amount)
              FROM loan_charges lc
              WHERE lc.status='COLLECTED'
                AND lc.charge_type IN ('DOCUMENT','INSURANCE','SERVICE')
                AND date_trunc('month',lc.collected_date)
                    =date_trunc('month',(now() AT TIME ZONE 'Asia/Colombo')::date)
            ),0)::numeric(15,2) AS month_charge_income,
            COALESCE((
              SELECT sum(e.amount)
              FROM expenses e
              WHERE e.status='POSTED'
                AND date_trunc('month',e.expense_date)
                    =date_trunc('month',(now() AT TIME ZONE 'Asia/Colombo')::date)
            ),0)::numeric(15,2) AS month_expenses,
            COALESCE((
              SELECT sum(sp.amount)
              FROM salary_payments sp
              WHERE sp.status='POSTED'
                AND date_trunc('month',sp.payment_date)
                    = date_trunc(
                        'month',
                        (now() AT TIME ZONE 'Asia/Colombo')::date
                      )
            ),0)::numeric(15,2) AS month_salary_paid
          FROM payments p
          JOIN loans l ON l.id=p.loan_id
          WHERE p.status='POSTED'
            AND date_trunc('month',p.payment_date)
                =date_trunc('month',(now() AT TIME ZONE 'Asia/Colombo')::date)
        `)
      ]);

      const profitRow=profit.rows[0]||{};
      const monthOperatingExpenses=Number(profitRow.month_expenses||0);
      const monthSalaryPaid=Number(profitRow.month_salary_paid||0);
      const monthTotalExpenses=monthOperatingExpenses+monthSalaryPaid;
      const netProfit=
        Number(profitRow.month_interest_income||0)+
        Number(profitRow.month_charge_income||0)-
        monthTotalExpenses;
      const profitStatus=netProfit>0?'PROFIT':netProfit<0?'CRITICAL':'AVERAGE';

      res.json({
        as_of: new Date().toISOString(),
        dashboard: {
          ...result.rows[0],
          center_today_collection: centerCollections.rows,
          month_collection_trend: monthTrend.rows,
          month_interest_income: profitRow.month_interest_income||0,
          month_charge_income: profitRow.month_charge_income||0,
          month_total_income: (
            Number(profitRow.month_interest_income||0)+
            Number(profitRow.month_charge_income||0)
          ).toFixed(2),
          month_operating_expenses: monthOperatingExpenses.toFixed(2),
          month_salary_paid: monthSalaryPaid.toFixed(2),
          month_salary_expense: monthSalaryPaid.toFixed(2),
          month_expenses: monthOperatingExpenses.toFixed(2),
          month_total_expenses: monthTotalExpenses.toFixed(2),
          month_net_profit: netProfit.toFixed(2),
          profit_status: profitStatus
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
