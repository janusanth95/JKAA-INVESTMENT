import express from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';

import { query, withTransaction } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';

export const dailyClosingRouter = express.Router();
dailyClosingRouter.use(requireAuth);

function businessError(message) {
  const error = new Error(message);
  error.code = 'P0001';
  return error;
}

async function run(executor, sql, params = []) {
  if (executor && typeof executor.query === 'function') return executor.query(sql, params);
  return query(sql, params);
}

export async function ensureDailyClosingSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS daily_closing_config (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      activation_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO daily_closing_config(id, activation_date)
    VALUES (1, (now() AT TIME ZONE 'Asia/Colombo')::date)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS daily_closings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      closing_date DATE NOT NULL UNIQUE,
      opening_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      collection_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      charges_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      investor_in_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      other_in_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      bank_withdrawal NUMERIC(15,2) NOT NULL DEFAULT 0,
      loan_disbursed_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      expenses_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      salary_advance_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      salary_payment_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      investor_out_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      other_out_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      bank_deposit NUMERIC(15,2) NOT NULL DEFAULT 0,
      expected_cash NUMERIC(15,2) NOT NULL DEFAULT 0,
      actual_cash NUMERIC(15,2),
      difference NUMERIC(15,2),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
      notes TEXT,
      closed_by UUID REFERENCES users(id),
      closed_at TIMESTAMPTZ,
      reopened_by UUID REFERENCES users(id),
      reopened_at TIMESTAMPTZ,
      reopen_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_daily_closings_date_status
      ON daily_closings(closing_date DESC, status);

    CREATE SEQUENCE IF NOT EXISTS seq_cash_transfer_no START 1;

    CREATE TABLE IF NOT EXISTS cash_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      transfer_no TEXT NOT NULL UNIQUE DEFAULT
        ('JK-TRF-' || lpad(nextval('seq_cash_transfer_no')::text, 7, '0')),
      transfer_date DATE NOT NULL,
      transfer_type TEXT NOT NULL CHECK (transfer_type IN ('CASH_TO_BANK','BANK_TO_CASH')),
      amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
      entered_by UUID REFERENCES users(id),
      voided_by UUID REFERENCES users(id),
      voided_at TIMESTAMPTZ,
      void_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_cash_transfers_date_status
      ON cash_transfers(transfer_date DESC, status);

    CREATE OR REPLACE FUNCTION jk_block_closed_cash_ledger_day()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_old_date DATE;
      v_new_date DATE;
      v_blocked DATE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        v_old_date := OLD.entry_date;
      ELSIF TG_OP = 'INSERT' THEN
        v_new_date := NEW.entry_date;
      ELSE
        v_old_date := OLD.entry_date;
        v_new_date := NEW.entry_date;
      END IF;

      SELECT dc.closing_date INTO v_blocked
      FROM daily_closings dc
      WHERE dc.status='CLOSED'
        AND dc.closing_date IN (v_old_date, v_new_date)
      ORDER BY dc.closing_date DESC
      LIMIT 1;

      IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION
          'Business day % is closed. Re-open the day before changing financial transactions.',
          v_blocked;
      END IF;

      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_block_closed_cash_ledger_day ON cash_ledger;
    CREATE TRIGGER trg_block_closed_cash_ledger_day
    BEFORE INSERT OR UPDATE OR DELETE ON cash_ledger
    FOR EACH ROW EXECUTE FUNCTION jk_block_closed_cash_ledger_day();

    CREATE OR REPLACE FUNCTION jk_block_closed_cash_transfer_day()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_old_date DATE;
      v_new_date DATE;
      v_blocked DATE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        v_old_date := OLD.transfer_date;
      ELSIF TG_OP = 'INSERT' THEN
        v_new_date := NEW.transfer_date;
      ELSE
        v_old_date := OLD.transfer_date;
        v_new_date := NEW.transfer_date;
      END IF;

      SELECT dc.closing_date INTO v_blocked
      FROM daily_closings dc
      WHERE dc.status='CLOSED'
        AND dc.closing_date IN (v_old_date, v_new_date)
      ORDER BY dc.closing_date DESC
      LIMIT 1;

      IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION
          'Business day % is closed. Re-open the day before changing bank/cash transfers.',
          v_blocked;
      END IF;

      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS trg_block_closed_cash_transfer_day ON cash_transfers;
    CREATE TRIGGER trg_block_closed_cash_transfer_day
    BEFORE INSERT OR UPDATE OR DELETE ON cash_transfers
    FOR EACH ROW EXECUTE FUNCTION jk_block_closed_cash_transfer_day();
  `);
}

async function getSystemDates(executor = null) {
  const result = await run(executor, `
    SELECT
      (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today,
      (SELECT activation_date::text FROM daily_closing_config WHERE id=1) AS activation_date
  `);
  return result.rows[0];
}

async function getDailySummary(date, executor = null) {
  const result = await run(executor, `
    WITH prev AS (
      SELECT closing_date, actual_cash
      FROM daily_closings
      WHERE status='CLOSED' AND closing_date < $1::date
      ORDER BY closing_date DESC
      LIMIT 1
    ),
    ledger_before AS (
      SELECT COALESCE(sum(
        CASE WHEN cl.direction='IN' THEN cl.amount ELSE -cl.amount END
      ),0)::numeric(15,2) AS net
      FROM cash_ledger cl
      LEFT JOIN prev p ON true
      WHERE cl.status='POSTED'
        AND cl.payment_method='CASH'
        AND cl.entry_date < $1::date
        AND (p.closing_date IS NULL OR cl.entry_date > p.closing_date)
        AND NOT (
          cl.category='ADJUSTMENT' AND cl.description ILIKE 'Legacy opening cash%'
        )
    ),
    transfer_before AS (
      SELECT COALESCE(sum(
        CASE WHEN ct.transfer_type='BANK_TO_CASH' THEN ct.amount ELSE -ct.amount END
      ),0)::numeric(15,2) AS net
      FROM cash_transfers ct
      LEFT JOIN prev p ON true
      WHERE ct.status='POSTED'
        AND ct.transfer_date < $1::date
        AND (p.closing_date IS NULL OR ct.transfer_date > p.closing_date)
    ),
    movement AS (
      SELECT
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='IN' AND cl.category='COLLECTION'
        ),0)::numeric(15,2) AS collection_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='IN' AND cl.category='LOAN_CHARGE'
        ),0)::numeric(15,2) AS charges_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='IN' AND cl.category='INVESTOR_DEPOSIT'
        ),0)::numeric(15,2) AS investor_in_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='IN'
            AND cl.category NOT IN ('COLLECTION','LOAN_CHARGE','INVESTOR_DEPOSIT')
        ),0)::numeric(15,2) AS other_in_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT' AND cl.category='LOAN_DISBURSEMENT'
        ),0)::numeric(15,2) AS loan_disbursed_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT' AND cl.category='EXPENSE'
        ),0)::numeric(15,2) AS expenses_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT'
            AND cl.category='ADJUSTMENT'
            AND cl.source_table='salary_advances'
        ),0)::numeric(15,2) AS salary_advance_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT'
            AND cl.category='ADJUSTMENT'
            AND cl.source_table='salary_payments'
        ),0)::numeric(15,2) AS salary_payment_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT' AND cl.category='INVESTOR_WITHDRAWAL'
        ),0)::numeric(15,2) AS investor_out_cash,
        COALESCE(sum(cl.amount) FILTER (
          WHERE cl.direction='OUT'
            AND NOT (
              cl.category IN ('LOAN_DISBURSEMENT','EXPENSE','INVESTOR_WITHDRAWAL')
              OR (
                cl.category='ADJUSTMENT'
                AND cl.source_table IN ('salary_advances','salary_payments')
              )
            )
        ),0)::numeric(15,2) AS other_out_cash
      FROM cash_ledger cl
      WHERE cl.status='POSTED'
        AND cl.payment_method='CASH'
        AND cl.entry_date=$1::date
        AND NOT (
          cl.category='ADJUSTMENT' AND cl.description ILIKE 'Legacy opening cash%'
        )
    ),
    transfers_today AS (
      SELECT
        COALESCE(sum(ct.amount) FILTER (
          WHERE ct.transfer_type='BANK_TO_CASH'
        ),0)::numeric(15,2) AS bank_withdrawal,
        COALESCE(sum(ct.amount) FILTER (
          WHERE ct.transfer_type='CASH_TO_BANK'
        ),0)::numeric(15,2) AS bank_deposit
      FROM cash_transfers ct
      WHERE ct.status='POSTED' AND ct.transfer_date=$1::date
    ),
    values AS (
      SELECT
        (
          COALESCE((SELECT actual_cash FROM prev),0)
          + (SELECT net FROM ledger_before)
          + (SELECT net FROM transfer_before)
        )::numeric(15,2) AS opening_cash,
        m.collection_cash,
        m.charges_cash,
        m.investor_in_cash,
        m.other_in_cash,
        t.bank_withdrawal,
        m.loan_disbursed_cash,
        m.expenses_cash,
        m.salary_advance_cash,
        m.salary_payment_cash,
        m.investor_out_cash,
        m.other_out_cash,
        t.bank_deposit
      FROM movement m
      CROSS JOIN transfers_today t
    )
    SELECT
      *,
      (
        opening_cash
        + collection_cash
        + charges_cash
        + investor_in_cash
        + other_in_cash
        + bank_withdrawal
        - loan_disbursed_cash
        - expenses_cash
        - salary_advance_cash
        - salary_payment_cash
        - investor_out_cash
        - other_out_cash
        - bank_deposit
      )::numeric(15,2) AS expected_cash
    FROM values
  `, [date]);
  return result.rows[0];
}

async function getClosing(date) {
  const result = await query(`
    SELECT dc.*, u.full_name AS closed_by_name, ru.full_name AS reopened_by_name
    FROM daily_closings dc
    LEFT JOIN users u ON u.id=dc.closed_by
    LEFT JOIN users ru ON ru.id=dc.reopened_by
    WHERE dc.closing_date=$1::date
  `, [date]);
  return result.rows[0] || null;
}

function money(value) {
  return Number(value || 0).toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

dailyClosingRouter.get('/day', requirePermission('FINANCE_VIEW'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const dates = await getSystemDates();
    const date = String(req.query.date || dates.today);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw businessError('Invalid closing date.');
    if (date > dates.today) throw businessError('Future dates cannot be closed.');
    if (date < dates.activation_date) {
      throw businessError(
        'Daily Closing starts from '+dates.activation_date+'. Historical dates remain unchanged.'
      );
    }

    const saved = await getClosing(date);
    const live = await getDailySummary(date);
    const transfers = await query(`
      SELECT *
      FROM cash_transfers
      WHERE transfer_date=$1::date
      ORDER BY created_at DESC
    `, [date]);

    res.json({
      date,
      today: dates.today,
      activation_date: dates.activation_date,
      status: saved?.status || 'OPEN',
      summary: saved?.status === 'CLOSED' ? saved : live,
      live_summary: live,
      closing: saved,
      transfers: transfers.rows
    });
  } catch (error) {
    next(error);
  }
});

dailyClosingRouter.get('/history', requirePermission('FINANCE_VIEW'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const result = await query(`
      SELECT dc.*, u.full_name AS closed_by_name
      FROM daily_closings dc
      LEFT JOIN users u ON u.id=dc.closed_by
      ORDER BY dc.closing_date DESC
      LIMIT 120
    `);
    res.json({ closings: result.rows });
  } catch (error) {
    next(error);
  }
});

const transferSchema = z.object({
  transfer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transfer_type: z.enum(['CASH_TO_BANK','BANK_TO_CASH']),
  amount: z.coerce.number().positive().max(1000000000),
  notes: z.string().trim().max(500).optional()
});

dailyClosingRouter.post('/transfer', requirePermission('SETTINGS_MANAGE'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const body = transferSchema.parse(req.body);
    const dates = await getSystemDates();

    if (body.transfer_date > dates.today) throw businessError('Future transfer dates are not allowed.');
    if (body.transfer_date < dates.activation_date) {
      throw businessError('Cash transfers can be entered only from '+dates.activation_date+'.');
    }

    const result = await withTransaction(req.auth.user_id, async (client) => {
      const closed = await client.query(
        `SELECT 1 FROM daily_closings WHERE closing_date=$1::date AND status='CLOSED'`,
        [body.transfer_date]
      );
      if (closed.rowCount) {
        throw businessError('This business day is closed. Re-open it before adding a transfer.');
      }

      const inserted = await client.query(`
        INSERT INTO cash_transfers(
          transfer_date,transfer_type,amount,notes,entered_by
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING *
      `, [
        body.transfer_date,
        body.transfer_type,
        body.amount,
        body.notes || null,
        req.auth.user_id
      ]);
      return inserted.rows[0];
    });

    res.status(201).json({ transfer: result });
  } catch (error) {
    next(error);
  }
});

const reasonSchema = z.object({
  reason: z.string().trim().min(2).max(500)
});

dailyClosingRouter.post('/transfer/:id/void', requirePermission('SETTINGS_MANAGE'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const body = reasonSchema.parse(req.body);

    const result = await withTransaction(req.auth.user_id, async (client) => {
      const updated = await client.query(`
        UPDATE cash_transfers
        SET status='VOIDED',
            voided_by=$2,
            voided_at=now(),
            void_reason=$3,
            updated_at=now()
        WHERE id=$1 AND status='POSTED'
        RETURNING *
      `, [req.params.id, req.auth.user_id, body.reason]);

      if (updated.rowCount !== 1) throw businessError('Posted transfer not found.');
      return updated.rows[0];
    });

    res.json({ transfer: result });
  } catch (error) {
    next(error);
  }
});

const closeSchema = z.object({
  closing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actual_cash: z.coerce.number().min(0).max(10000000000),
  notes: z.string().trim().max(1000).optional()
});

dailyClosingRouter.post('/close', requirePermission('SETTINGS_MANAGE'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const body = closeSchema.parse(req.body);

    const closed = await withTransaction(req.auth.user_id, async (client) => {
      const dates = await getSystemDates(client);

      if (body.closing_date > dates.today) throw businessError('Future dates cannot be closed.');
      if (body.closing_date < dates.activation_date) {
        throw businessError(
          'Daily Closing starts from '+dates.activation_date+'. Historical data is not changed.'
        );
      }

      const existing = await client.query(
        `SELECT * FROM daily_closings WHERE closing_date=$1::date FOR UPDATE`,
        [body.closing_date]
      );
      if (existing.rows[0]?.status === 'CLOSED') {
        throw businessError('This business day is already closed.');
      }

      const s = await getDailySummary(body.closing_date, client);
      const difference = (
        Number(body.actual_cash) - Number(s.expected_cash || 0)
      ).toFixed(2);

      const saved = await client.query(`
        INSERT INTO daily_closings(
          closing_date,opening_cash,collection_cash,charges_cash,
          investor_in_cash,other_in_cash,bank_withdrawal,
          loan_disbursed_cash,expenses_cash,salary_advance_cash,
          salary_payment_cash,investor_out_cash,other_out_cash,
          bank_deposit,expected_cash,actual_cash,difference,status,
          notes,closed_by,closed_at,reopened_by,reopened_at,reopen_reason,updated_at
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          'CLOSED',$18,$19,now(),NULL,NULL,NULL,now()
        )
        ON CONFLICT (closing_date)
        DO UPDATE SET
          opening_cash=EXCLUDED.opening_cash,
          collection_cash=EXCLUDED.collection_cash,
          charges_cash=EXCLUDED.charges_cash,
          investor_in_cash=EXCLUDED.investor_in_cash,
          other_in_cash=EXCLUDED.other_in_cash,
          bank_withdrawal=EXCLUDED.bank_withdrawal,
          loan_disbursed_cash=EXCLUDED.loan_disbursed_cash,
          expenses_cash=EXCLUDED.expenses_cash,
          salary_advance_cash=EXCLUDED.salary_advance_cash,
          salary_payment_cash=EXCLUDED.salary_payment_cash,
          investor_out_cash=EXCLUDED.investor_out_cash,
          other_out_cash=EXCLUDED.other_out_cash,
          bank_deposit=EXCLUDED.bank_deposit,
          expected_cash=EXCLUDED.expected_cash,
          actual_cash=EXCLUDED.actual_cash,
          difference=EXCLUDED.difference,
          status='CLOSED',
          notes=EXCLUDED.notes,
          closed_by=EXCLUDED.closed_by,
          closed_at=now(),
          reopened_by=NULL,
          reopened_at=NULL,
          reopen_reason=NULL,
          updated_at=now()
        RETURNING *
      `, [
        body.closing_date,
        s.opening_cash,
        s.collection_cash,
        s.charges_cash,
        s.investor_in_cash,
        s.other_in_cash,
        s.bank_withdrawal,
        s.loan_disbursed_cash,
        s.expenses_cash,
        s.salary_advance_cash,
        s.salary_payment_cash,
        s.investor_out_cash,
        s.other_out_cash,
        s.bank_deposit,
        s.expected_cash,
        body.actual_cash,
        difference,
        body.notes || null,
        req.auth.user_id
      ]);

      return saved.rows[0];
    });

    res.json({ ok:true, message:'Business day closed successfully.', closing:closed });
  } catch (error) {
    next(error);
  }
});

dailyClosingRouter.post('/:date/reopen', requirePermission('SETTINGS_MANAGE'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const body = reasonSchema.parse(req.body);

    const reopened = await withTransaction(req.auth.user_id, async (client) => {
      const newerClosed = await client.query(`
        SELECT closing_date::text AS closing_date
        FROM daily_closings
        WHERE status='CLOSED' AND closing_date > $1::date
        ORDER BY closing_date DESC
        LIMIT 1
      `, [req.params.date]);

      if (newerClosed.rowCount) {
        throw businessError(
          'Re-open newer closed days first. Latest closed day is '+newerClosed.rows[0].closing_date+'.'
        );
      }

      const updated = await client.query(`
        UPDATE daily_closings
        SET status='OPEN',
            actual_cash=NULL,
            difference=NULL,
            reopened_by=$2,
            reopened_at=now(),
            reopen_reason=$3,
            updated_at=now()
        WHERE closing_date=$1::date AND status='CLOSED'
        RETURNING *
      `, [req.params.date, req.auth.user_id, body.reason]);

      if (updated.rowCount !== 1) throw businessError('Closed business day not found.');
      return updated.rows[0];
    });

    res.json({ ok:true, message:'Business day re-opened.', closing:reopened });
  } catch (error) {
    next(error);
  }
});

dailyClosingRouter.get('/:date/pdf', requirePermission('FINANCE_VIEW'), async (req, res, next) => {
  try {
    await ensureDailyClosingSchema();
    const date = String(req.params.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw businessError('Invalid closing date.');

    const closing = await getClosing(date);
    const summary = closing?.status === 'CLOSED' ? closing : await getDailySummary(date);

    const doc = new PDFDocument({
      size:'A4',
      margin:38,
      info:{ Title:'JK Investment Daily Closing '+date }
    });

    res.setHeader('Content-Type','application/pdf');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="JK_Daily_Closing_'+date+'.pdf"'
    );
    doc.pipe(res);

    const row = (label, value, bold=false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(10).fillColor('#111111')
        .text(label,45,doc.y,{continued:true,width:250})
        .text('Rs. '+money(value),{align:'right',width:250});
      doc.moveDown(0.45);
    };

    doc.font('Helvetica-Bold').fontSize(19).text('JK INVESTMENT',{align:'center'});
    doc.font('Helvetica-Bold').fontSize(14).text('Daily Business Closing',{align:'center'});
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).text('Date: '+date,{align:'center'});
    doc.moveDown(1.2);

    doc.font('Helvetica-Bold').fontSize(11).text('Opening & Cash In');
    doc.moveDown(0.5);
    row('Opening Cash',summary.opening_cash);
    row('Customer Collections',summary.collection_cash);
    row('DOC + INS + Service',summary.charges_cash);
    row('Investor Cash In',summary.investor_in_cash);
    row('Other Cash In',summary.other_in_cash);
    row('Bank Withdrawal',summary.bank_withdrawal);

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(11).text('Cash Out');
    doc.moveDown(0.5);
    row('Loan Disbursed',summary.loan_disbursed_cash);
    row('Expenses',summary.expenses_cash);
    row('Salary Advance',summary.salary_advance_cash);
    row('Salary Payment',summary.salary_payment_cash);
    row('Investor Cash Out',summary.investor_out_cash);
    row('Other Cash Out',summary.other_out_cash);
    row('Bank Deposit',summary.bank_deposit);

    doc.moveDown(0.7);
    doc.moveTo(45,doc.y).lineTo(550,doc.y).strokeColor('#888888').stroke();
    doc.moveDown(0.7);
    row('Expected Hand Cash',summary.expected_cash,true);

    if (closing?.status === 'CLOSED') {
      row('Actual Hand Cash',closing.actual_cash,true);
      row('Difference (Short / Excess)',closing.difference,true);
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').fontSize(10).text('Status: CLOSED');
      if (closing.notes) {
        doc.font('Helvetica').fontSize(9).text('Notes: '+String(closing.notes));
      }
    } else {
      doc.font('Helvetica-Bold').fontSize(10).text('Status: OPEN');
    }

    doc.moveDown(2);
    doc.font('Helvetica').fontSize(9).text(
      'Prepared from JK Investment posted CASH ledger entries and recorded bank/cash transfers.'
    );
    doc.end();
  } catch (error) {
    next(error);
  }
});
