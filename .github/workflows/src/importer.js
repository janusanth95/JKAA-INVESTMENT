import express from 'express';
import argon2 from 'argon2';

import { query, withTransaction } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { ensureSalaryAdvanceSchema } from './salary-advance.js';
import { ensureDailyClosingSchema } from './daily-closing.js';

export const importerRouter = express.Router();
importerRouter.use(requireAuth);

function businessError(message) {
  const error = new Error(message);
  error.code = 'P0001';
  return error;
}

function normalizeMethod(value) {
  const v = String(value || 'CASH').trim().toUpperCase();
  if (v === 'CASH') return 'CASH';
  if (v === 'BANK') return 'BANK';
  if (v === 'MOBILE') return 'MOBILE';
  return 'OTHER';
}

function normalizeLoanType(value) {
  const v = String(value || 'WEEKLY').trim().toUpperCase();
  if (v === 'DAILY') return 'DAILY';
  if (v === 'MONTHLY') return 'MONTHLY';
  return 'WEEKLY';
}

function isoDow(day) {
  const v = String(day || '').trim().toLowerCase();
  return {
    monday:1,tuesday:2,wednesday:3,thursday:4,
    friday:5,saturday:6,sunday:7
  }[v] || null;
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const CURRENT_EXPORT_APP = 'JK Investment PostgreSQL Export';
const FULL_BACKUP_APP = 'JK Investment Production Backup';

const CURRENT_EXPORT_KEYS = [
  'centers','groups','customers','loans','guarantors','schedule','payments',
  'allocations','charges','expenses','investors','investorTransactions','cashLedger'
];

const EXTENDED_EXPORT_KEYS = [
  'salaryMonthLimits','salaryAdvances','salaryPayments','dailyClosings','cashTransfers'
];

function normalizeCurrentExport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw businessError('Invalid JSON backup file.');
  }

  let backup = input;
  let sourceApp = input.app;

  if (input.app === FULL_BACKUP_APP) {
    if (!input.restoreData || typeof input.restoreData !== 'object' || Array.isArray(input.restoreData)) {
      throw businessError(
        'This Full Backup was created before restore-ready backups were enabled. Use a newer Full Backup or a PostgreSQL Export file.'
      );
    }
    backup = {
      ...input.restoreData,
      app: CURRENT_EXPORT_APP,
      exportedAt: input.generatedAt || input.restoreData.exportedAt || null
    };
    sourceApp = FULL_BACKUP_APP;
  }

  if (backup.app !== CURRENT_EXPORT_APP) {
    throw businessError('This is not a supported JK Investment restore file.');
  }

  const normalized = { ...backup };
  const missingExtended = EXTENDED_EXPORT_KEYS.filter(
    key => !Array.isArray(normalized[key])
  );

  normalized.__sourceApp = sourceApp;
  normalized.__missingExtended = missingExtended;

  return normalized;
}

function validateCurrentExport(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw businessError('Invalid JSON backup file.');
  }
  if (backup.app !== CURRENT_EXPORT_APP) {
    throw businessError('This is not a JK Investment PostgreSQL Export file.');
  }
  for (const key of CURRENT_EXPORT_KEYS) {
    if (!Array.isArray(backup[key])) {
      throw businessError(`Backup section is missing or invalid: ${key}`);
    }
  }
  for (const key of EXTENDED_EXPORT_KEYS) {
    if (backup[key] !== undefined && !Array.isArray(backup[key])) {
      throw businessError(`Backup section is invalid: ${key}`);
    }
  }
  if (!backup.centers.length || !backup.customers.length || !backup.loans.length) {
    throw businessError('Backup must contain centers, customers and loans.');
  }

  const ids = key => new Set(backup[key].map(row => String(row.id || '')));
  const centerIds=ids('centers'), groupIds=ids('groups'), customerIds=ids('customers');
  const loanIds=ids('loans'), scheduleIds=ids('schedule'), paymentIds=ids('payments');
  const investorIds=ids('investors');
  const unique = (key, field) => {
    const seen = new Set();
    for (const row of backup[key]) {
      const value=String(row[field] || '');
      if (!value || seen.has(value)) throw businessError(`Invalid or duplicate ${key}.${field}`);
      seen.add(value);
    }
  };
  for (const key of CURRENT_EXPORT_KEYS) unique(key,'id');
  for (const key of EXTENDED_EXPORT_KEYS) {
    if (Array.isArray(backup[key])) unique(key,'id');
  }
  for (const row of backup.groups) if (!centerIds.has(String(row.center_id))) throw businessError('Group has an unknown center.');
  for (const row of backup.customers) {
    if (!centerIds.has(String(row.center_id)) || !groupIds.has(String(row.group_id))) throw businessError('Customer has an unknown center or group.');
  }
  for (const row of backup.loans) {
    if (!customerIds.has(String(row.customer_id)) || !centerIds.has(String(row.center_id)) || !groupIds.has(String(row.group_id))) throw businessError('Loan has an unknown customer, center or group.');
  }
  for (const row of backup.guarantors) if (!loanIds.has(String(row.loan_id))) throw businessError('Guarantor has an unknown loan.');
  for (const row of backup.schedule) if (!loanIds.has(String(row.loan_id))) throw businessError('Schedule has an unknown loan.');
  for (const row of backup.payments) if (!loanIds.has(String(row.loan_id)) || !customerIds.has(String(row.customer_id)) || !centerIds.has(String(row.center_id))) throw businessError('Payment has an unknown loan, customer or center.');
  for (const row of backup.allocations) if (!paymentIds.has(String(row.payment_id)) || !scheduleIds.has(String(row.schedule_id))) throw businessError('Allocation has an unknown payment or schedule.');
  for (const row of backup.charges) if (!loanIds.has(String(row.loan_id))) throw businessError('Charge has an unknown loan.');
  for (const row of backup.investorTransactions) if (!investorIds.has(String(row.investor_id))) throw businessError('Investor transaction has an unknown investor.');
  return true;
}

function currentExportPreview(input) {
  const backup = normalizeCurrentExport(input);
  validateCurrentExport(backup);
  const sum=(rows,field)=>rows.reduce((total,row)=>total+num(row[field]),0).toFixed(2);
  const extendedCounts = Object.fromEntries(
    EXTENDED_EXPORT_KEYS.map(key=>[key,Array.isArray(backup[key]) ? backup[key].length : null])
  );

  return {
    app: backup.__sourceApp || backup.app,
    exported_at:backup.exportedAt || null,
    restore_ready:backup.__missingExtended.length===0,
    missing_extended_sections:backup.__missingExtended,
    counts:{
      ...Object.fromEntries(CURRENT_EXPORT_KEYS.map(key=>[key,backup[key].length])),
      ...extendedCounts
    },
    totals:{
      principal:sum(backup.loans,'principal'),
      total_payable:sum(backup.loans,'total_payable'),
      payments:sum(backup.payments.filter(x=>x.status==='POSTED'),'amount'),
      charges:sum(backup.charges.filter(x=>x.status==='COLLECTED'),'amount'),
      expenses:sum(backup.expenses.filter(x=>x.status==='POSTED'),'amount'),
      cash_ledger:backup.cashLedger.filter(x=>x.status==='POSTED').reduce((sum,row)=>sum+(row.direction==='IN'?num(row.amount):-num(row.amount)),0).toFixed(2)
    },
    notes:[
      'Preview only. No live data has been changed.',
      'Full Replace restores exact business record IDs and links.',
      backup.__missingExtended.length
        ? 'This older backup does not include all newer Salary / Daily Closing sections. Full Replace is blocked when newer-module data already exists.'
        : 'Restore-ready backup includes Salary Advance, Salary Payments, Daily Closing and Cash Transfer sections.',
      'Admin accounts, passwords, 2FA, roles and system settings are not replaced.',
      'The import runs in one database transaction and rolls back automatically if any step fails.'
    ]
  };
}

async function insertRows(client, table, columns, rows, actorId, actorColumns=[]) {
  for (const row of rows) {
    const values=columns.map(column=>actorColumns.includes(column) ? (row[column] ? actorId : null) : (row[column] ?? null));
    const placeholders=columns.map((_,i)=>`$${i+1}`).join(',');
    await client.query(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES(${placeholders})`,
      values
    );
  }
}

function isOpeningCompanyFundType(value) {
  const v = String(value || '').trim().toUpperCase();
  return (
    v.includes('OPENING FUND') ||
    v.includes('ADDED FUND') ||
    v.includes('ADD FUND') ||
    v.includes('COMPANY FUND')
  );
}

function inferDisbursedDate(backup, loan) {
  const charge = asArray(backup.loanCharges)
    .find(x => String(x.loanCode) === String(loan.code) && x.chargedOn);
  if (charge?.chargedOn) return String(charge.chargedOn).slice(0,10);

  const paymentDates = asArray(backup.collections)
    .filter(x => String(x.loanCode) === String(loan.code) && x.collectedOn)
    .map(x => String(x.collectedOn).slice(0,10))
    .sort();

  if (paymentDates.length) return paymentDates[0];

  const firstDue = String(loan.firstDue || '').slice(0,10);
  if (!firstDue) return null;

  const d = new Date(firstDue + 'T00:00:00Z');
  if (String(loan.repaymentType || '').toUpperCase() === 'DAILY') {
    d.setUTCDate(d.getUTCDate() - 1);
  } else if (String(loan.repaymentType || '').toUpperCase() === 'MONTHLY') {
    d.setUTCMonth(d.getUTCMonth() - 1);
  } else {
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return d.toISOString().slice(0,10);
}

function validateBackup(backup) {
  if (!backup || typeof backup !== 'object') {
    throw businessError('Invalid backup file.');
  }

  if (backup.app !== 'JK Investment Loan System') {
    throw businessError('This is not a JK Investment backup file.');
  }

  const customers = asArray(backup.customers);
  const loans = asArray(backup.loans);
  const centers = asArray(backup.centers);
  const groups = asArray(backup.groups);

  if (!customers.length) throw businessError('Backup has no customers.');
  if (!loans.length) throw businessError('Backup has no loans.');
  if (!centers.length) throw businessError('Backup has no centers.');

  const centerNames = new Set(centers.map(x => String(x.name || '').trim().toUpperCase()));
  for (const g of groups) {
    if (!centerNames.has(String(g.centerName || '').trim().toUpperCase())) {
      throw businessError(`Group center not found: ${g.centerName || g.name || 'Unknown'}`);
    }
  }

  const customerCodes = new Set(customers.map(x => String(x.code || '')));
  for (const l of loans) {
    if (!customerCodes.has(String(l.customerCode || ''))) {
      throw businessError(`Loan customer not found: ${l.code || 'Unknown loan'}`);
    }
    if (!l.firstDue) throw businessError(`Loan ${l.code} has no first due date.`);
  }

  return true;
}

function backupPreview(backup) {
  validateBackup(backup);

  const customers = asArray(backup.customers);
  const loans = asArray(backup.loans);
  const collections = asArray(backup.collections);
  const charges = asArray(backup.loanCharges);
  const expenses = asArray(backup.expenses);
  const centers = asArray(backup.centers);
  const groups = asArray(backup.groups);
  const capital = asArray(backup.capitalEntries);
  const cashBooks = asArray(backup.cashBooks);

  return {
    app: backup.app,
    version: backup.version ?? null,
    exported_at: backup.exportedAt || null,
    counts: {
      centers: centers.length,
      groups: groups.length,
      customers: customers.length,
      loans: loans.length,
      collections: collections.length,
      loan_charges: charges.length,
      expenses: expenses.length,
      capital_entries: capital.length,
      cash_books: cashBooks.length
    },
    totals: {
      principal: loans.reduce((s,x)=>s+num(x.principal),0).toFixed(2),
      total_payable: loans.reduce((s,x)=>s+num(x.totalDue),0).toFixed(2),
      legacy_balance: loans.reduce((s,x)=>s+num(x.balance),0).toFixed(2),
      collections: collections.reduce((s,x)=>s+num(x.amount),0).toFixed(2),
      doc_ins_income: charges.reduce(
        (s,x)=>s+num(x.docCharge)+num(x.insCharge),0
      ).toFixed(2),
      service_charge: charges.reduce(
        (s,x)=>s+num(x.serviceCharge),0
      ).toFixed(2),
      expenses: expenses.reduce((s,x)=>s+num(x.amount),0).toFixed(2),
      opening_added_fund: capital
        .filter(x=>isOpeningCompanyFundType(x.type))
        .reduce((s,x)=>s+num(x.amount),0).toFixed(2),
      investor_capital: capital
        .filter(x=>!isOpeningCompanyFundType(x.type))
        .reduce((s,x)=>s+num(x.amount),0).toFixed(2),
      legacy_cashbook_opening_snapshot: cashBooks.reduce(
        (s,x)=>s+num(x.openingCash),0
      ).toFixed(2)
    },
    notes: [
      'Current live records are imported; old deleted-history audit logs are not replayed.',
      'Legacy customer / loan / receipt codes are preserved where possible.',
      'Current new-system DOC/INS default settings are kept unchanged.',
      'Old Cash Book opening-balance snapshots are NOT imported as new cash.',
      'Opening / Added Fund stays company fund; it is not converted into investor capital.',
      'Legacy Service Charge is preserved as a charge record but is not included in old-side DOC & INS income.'
    ]
  };
}

importerRouter.post(
  '/preview',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      res.json({ preview: backupPreview(req.body) });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.post(
  '/current-preview',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      res.json({ preview: currentExportPreview(req.body) });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.post(
  '/restore-dry-run',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      await ensureDailyClosingSchema();

      const normalized = normalizeCurrentExport(req.body?.backup ?? req.body);
      validateCurrentExport(normalized);
      const preview = currentExportPreview(normalized);

      const existingExtended = await query(`
        SELECT
          (SELECT count(*)::int FROM salary_month_limits) AS salary_month_limits,
          (SELECT count(*)::int FROM salary_advances) AS salary_advances,
          (SELECT count(*)::int FROM salary_payments) AS salary_payments,
          (SELECT count(*)::int FROM daily_closings) AS daily_closings,
          (SELECT count(*)::int FROM cash_transfers) AS cash_transfers
      `);

      const blockers = [];
      if (normalized.__missingExtended.length) {
        const existingCount = Object.values(existingExtended.rows[0] || {})
          .reduce((sum,value)=>sum+Number(value || 0),0);
        if (existingCount > 0) {
          blockers.push(
            'Backup is missing newer Salary / Daily Closing sections while the current system already has data in those modules.'
          );
        }
      }

      res.json({
        ok: blockers.length === 0,
        dry_run: true,
        production_data_changed: false,
        preview,
        blockers
      });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.post(
  '/current-replace',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const { confirmation, password, safety_backup_confirmed, backup } = req.body || {};
      if (confirmation !== 'RESTORE JK BACKUP') throw businessError('Confirmation text is incorrect.');
      if (safety_backup_confirmed !== true) throw businessError('Download the current safety backup first.');
      if (!password) throw businessError('Admin password is required.');

      const userResult=await query(
        `SELECT password_hash,status FROM users WHERE id=$1`,
        [req.auth.user_id]
      );
      const user=userResult.rows[0];
      if (!user || user.status !== 'ACTIVE' || !(await argon2.verify(user.password_hash,password))) {
        throw businessError('Admin password is incorrect.');
      }

      await ensureSalaryAdvanceSchema();
      await ensureDailyClosingSchema();

      const restoreBackup = normalizeCurrentExport(backup);
      validateCurrentExport(restoreBackup);
      const preview=currentExportPreview(restoreBackup);

      const missingExtended = restoreBackup.__missingExtended;
      if (missingExtended.length) {
        const existingExtended = await query(`
          SELECT
            (SELECT count(*)::int FROM salary_month_limits) AS salary_month_limits,
            (SELECT count(*)::int FROM salary_advances) AS salary_advances,
            (SELECT count(*)::int FROM salary_payments) AS salary_payments,
            (SELECT count(*)::int FROM daily_closings) AS daily_closings,
            (SELECT count(*)::int FROM cash_transfers) AS cash_transfers
        `);
        const existingCount = Object.values(existingExtended.rows[0] || {})
          .reduce((sum,value)=>sum+Number(value || 0),0);

        if (existingCount > 0) {
          throw businessError(
            'This older backup does not include Salary Advance / Salary Payments / Daily Closing / Cash Transfer data. Use a newer restore-ready backup. No data was changed.'
          );
        }
      }

      const restoreExtended = missingExtended.length === 0;
      const imported=await withTransaction(req.auth.user_id, async client=>{
        const truncateTables = [
          'payment_allocations','payments','loan_charges','loan_guarantors','loan_schedule',
          'cash_ledger','expenses','investor_transactions','investors','loans','customers','groups','centers'
        ];
        if (restoreExtended) {
          truncateTables.unshift(
            'daily_closings','cash_transfers','salary_payments','salary_advances','salary_month_limits'
          );
        }
        await client.query(
          'TRUNCATE TABLE ' + truncateTables.join(',') + ' RESTART IDENTITY'
        );

        await insertRows(client,'centers',
          ['id','center_code','center_name','address','collection_isodow','status','created_by','created_at','updated_at'],
          restoreBackup.centers,req.auth.user_id,['created_by']);
        await insertRows(client,'groups',
          ['id','group_code','center_id','group_name','members_count','status','created_by','created_at','updated_at'],
          restoreBackup.groups,req.auth.user_id,['created_by']);
        await insertRows(client,'customers',
          ['id','customer_code','center_id','group_id','customer_name','nic','mobile','address','default_guarantor_name','default_guarantor_nic','default_guarantor_mobile','status','created_by','updated_by','created_at','updated_at'],
          restoreBackup.customers,req.auth.user_id,['created_by','updated_by']);
        await insertRows(client,'loans',
          ['id','loan_code','customer_id','center_id','group_id','principal','interest_rate','loan_type','installment_count','repayment_start_date','lifecycle_status','disbursed_date','cancelled_at','cancellation_reason','created_by','updated_by','created_at','updated_at'],
          restoreBackup.loans,req.auth.user_id,['created_by','updated_by']);
        await insertRows(client,'loan_guarantors',
          ['id','loan_id','guarantor_order','customer_id','guarantor_name','nic','mobile','note','created_at'],
          restoreBackup.guarantors,req.auth.user_id);
        await insertRows(client,'loan_schedule',
          ['id','loan_id','installment_no','due_date','due_amount','created_at'],
          restoreBackup.schedule,req.auth.user_id);
        await insertRows(client,'payments',
          ['id','receipt_no','idempotency_key','loan_id','customer_id','center_id','payment_date','amount','payment_method','reference_no','notes','status','whatsapp_sent_at','voided_at','voided_by','void_reason','entered_by','edited_by','created_at','updated_at'],
          restoreBackup.payments,req.auth.user_id,['voided_by','entered_by','edited_by']);
        await insertRows(client,'payment_allocations',
          ['id','payment_id','schedule_id','allocated_amount','created_at'],
          restoreBackup.allocations,req.auth.user_id);
        await insertRows(client,'loan_charges',
          ['id','loan_id','charge_type','amount','status','collected_date','payment_method','notes','created_by','created_at','updated_at'],
          restoreBackup.charges,req.auth.user_id,['created_by']);
        await insertRows(client,'expenses',
          ['id','expense_no','expense_date','category','description','amount','payment_method','status','voided_at','voided_by','void_reason','entered_by','created_at','updated_at'],
          restoreBackup.expenses,req.auth.user_id,['voided_by','entered_by']);
        await insertRows(client,'investors',
          ['id','investor_name','mobile','nic','status','notes','created_by','created_at','updated_at'],
          restoreBackup.investors,req.auth.user_id,['created_by']);
        await insertRows(client,'investor_transactions',
          ['id','transaction_no','investor_id','transaction_date','transaction_type','amount','payment_method','notes','status','voided_at','voided_by','void_reason','entered_by','created_at'],
          restoreBackup.investorTransactions,req.auth.user_id,['voided_by','entered_by']);
        await insertRows(client,'cash_ledger',
          ['id','entry_date','direction','category','amount','payment_method','source_table','source_id','description','status','created_by','created_at'],
          restoreBackup.cashLedger,req.auth.user_id,['created_by']);

        if (restoreExtended) {
          await insertRows(client,'salary_month_limits',
            ['id','salary_month','salary_limit','updated_by','created_at','updated_at'],
            restoreBackup.salaryMonthLimits,req.auth.user_id,['updated_by']);
          await insertRows(client,'salary_advances',
            ['id','advance_no','salary_month','advance_date','amount','payment_method','notes','status','entered_by','voided_by','voided_at','void_reason','created_at','updated_at'],
            restoreBackup.salaryAdvances,req.auth.user_id,['entered_by','voided_by']);
          await insertRows(client,'salary_payments',
            ['id','payment_no','salary_month','payment_date','amount','payment_method','notes','status','entered_by','voided_by','voided_at','void_reason','created_at','updated_at'],
            restoreBackup.salaryPayments,req.auth.user_id,['entered_by','voided_by']);

          // Cash transfers are inserted before daily closings so closed-day
          // protection triggers do not block replaying historical transfers.
          await insertRows(client,'cash_transfers',
            ['id','transfer_no','transfer_date','transfer_type','amount','notes','status','entered_by','voided_by','voided_at','void_reason','created_at','updated_at'],
            restoreBackup.cashTransfers,req.auth.user_id,['entered_by','voided_by']);

          // Daily closings are deliberately restored last.
          await insertRows(client,'daily_closings',
            ['id','closing_date','opening_cash','collection_cash','charges_cash','investor_in_cash','other_in_cash','bank_withdrawal','loan_disbursed_cash','expenses_cash','salary_advance_cash','salary_payment_cash','investor_out_cash','other_out_cash','bank_deposit','expected_cash','actual_cash','difference','status','notes','closed_by','closed_at','reopened_by','reopened_at','reopen_reason','created_at','updated_at'],
            restoreBackup.dailyClosings,req.auth.user_id,['closed_by','reopened_by']);
        }

        const sequenceSources=[
          ['seq_center_code','centers','center_code'],
          ['seq_group_code','groups','group_code'],
          ['seq_customer_code','customers','customer_code'],
          ['seq_loan_code','loans','loan_code'],
          ['seq_receipt_no','payments','receipt_no'],
          ['seq_expense_no','expenses','expense_no'],
          ['seq_investor_txn_no','investor_transactions','transaction_no'],
          ['seq_cash_transfer_no','cash_transfers','transfer_no']
        ];
        for (const [sequence,table,column] of sequenceSources) {
          await client.query(`SELECT setval('${sequence}',GREATEST(COALESCE((SELECT MAX((regexp_match(${column},'([0-9]+)$'))[1]::bigint) FROM ${table}),0),1),true)`);
        }

        const check=await client.query(`SELECT
          (SELECT count(*)::int FROM centers) centers,
          (SELECT count(*)::int FROM groups) groups,
          (SELECT count(*)::int FROM customers) customers,
          (SELECT count(*)::int FROM loans) loans,
          (SELECT count(*)::int FROM payments) payments,
          (SELECT count(*)::int FROM payment_allocations) allocations,
          (SELECT count(*)::int FROM loan_charges) charges,
          (SELECT count(*)::int FROM cash_ledger) cash_ledger,
          (SELECT count(*)::int FROM salary_month_limits) salary_month_limits,
          (SELECT count(*)::int FROM salary_advances) salary_advances,
          (SELECT count(*)::int FROM salary_payments) salary_payments,
          (SELECT count(*)::int FROM daily_closings) daily_closings,
          (SELECT count(*)::int FROM cash_transfers) cash_transfers`);
        const expected={
          centers:restoreBackup.centers.length,
          groups:restoreBackup.groups.length,
          customers:restoreBackup.customers.length,
          loans:restoreBackup.loans.length,
          payments:restoreBackup.payments.length,
          allocations:restoreBackup.allocations.length,
          charges:restoreBackup.charges.length,
          cash_ledger:restoreBackup.cashLedger.length,
          ...(restoreExtended ? {
            salary_month_limits:restoreBackup.salaryMonthLimits.length,
            salary_advances:restoreBackup.salaryAdvances.length,
            salary_payments:restoreBackup.salaryPayments.length,
            daily_closings:restoreBackup.dailyClosings.length,
            cash_transfers:restoreBackup.cashTransfers.length
          } : {})
        };
        for (const [key,value] of Object.entries(expected)) {
          if (Number(check.rows[0][key]) !== value) throw businessError(`Restore reconciliation failed: ${key}`);
        }
        return check.rows[0];
      });

      res.json({ok:true,message:'JK Investment backup restored successfully.',imported,source_preview:preview});
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.get(
  '/current-summary',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const result = await query(`
        SELECT
          (SELECT count(*)::int FROM centers) AS centers,
          (SELECT count(*)::int FROM groups) AS groups,
          (SELECT count(*)::int FROM customers) AS customers,
          (SELECT count(*)::int FROM loans WHERE lifecycle_status <> 'CANCELLED') AS loans,
          (SELECT count(*)::int FROM payments WHERE status='POSTED') AS payments,
          (SELECT count(*)::int FROM expenses WHERE status='POSTED') AS expenses,
          (SELECT count(*)::int FROM investors WHERE status='ACTIVE') AS investors,
          (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='POSTED')::numeric(15,2) AS payment_total,
          (SELECT COALESCE(sum(principal),0) FROM loans WHERE lifecycle_status='DISBURSED')::numeric(15,2) AS disbursed_principal
      `);
      res.json({ current: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.get(
  '/export-current',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      await ensureSalaryAdvanceSchema();
      await ensureDailyClosingSchema();

      const [
        centers, groups, customers, loans, guarantors, schedule,
        payments, allocations, charges, expenses, investors,
        investorTransactions, cashLedger,
        salaryMonthLimits, salaryAdvances, salaryPayments, dailyClosings, cashTransfers
      ] = await Promise.all([
        query(`SELECT * FROM centers ORDER BY created_at`),
        query(`SELECT * FROM groups ORDER BY created_at`),
        query(`SELECT * FROM customers ORDER BY created_at`),
        query(`SELECT * FROM loans ORDER BY created_at`),
        query(`SELECT * FROM loan_guarantors ORDER BY created_at`),
        query(`SELECT * FROM loan_schedule ORDER BY loan_id,installment_no`),
        query(`SELECT * FROM payments ORDER BY payment_date,created_at`),
        query(`SELECT * FROM payment_allocations ORDER BY created_at`),
        query(`SELECT * FROM loan_charges ORDER BY created_at`),
        query(`SELECT * FROM expenses ORDER BY expense_date,created_at`),
        query(`SELECT * FROM investors ORDER BY created_at`),
        query(`SELECT * FROM investor_transactions ORDER BY transaction_date,created_at`),
        query(`SELECT * FROM cash_ledger ORDER BY entry_date,created_at`),
        query(`SELECT * FROM salary_month_limits ORDER BY salary_month`),
        query(`SELECT * FROM salary_advances ORDER BY salary_month,advance_date,created_at`),
        query(`SELECT * FROM salary_payments ORDER BY salary_month,payment_date,created_at`),
        query(`SELECT * FROM daily_closings ORDER BY closing_date,created_at`),
        query(`SELECT * FROM cash_transfers ORDER BY transfer_date,created_at`)
      ]);

      const payload = {
        app: 'JK Investment PostgreSQL Export',
        exportedAt: new Date().toISOString(),
        centers: centers.rows,
        groups: groups.rows,
        customers: customers.rows,
        loans: loans.rows,
        guarantors: guarantors.rows,
        schedule: schedule.rows,
        payments: payments.rows,
        allocations: allocations.rows,
        charges: charges.rows,
        expenses: expenses.rows,
        investors: investors.rows,
        investorTransactions: investorTransactions.rows,
        cashLedger: cashLedger.rows,
        salaryMonthLimits: salaryMonthLimits.rows,
        salaryAdvances: salaryAdvances.rows,
        salaryPayments: salaryPayments.rows,
        dailyClosings: dailyClosings.rows,
        cashTransfers: cashTransfers.rows
      };

      const stamp = new Date().toISOString().slice(0,10);
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="jk-new-system-before-import-${stamp}.json"`);
      res.send(JSON.stringify(payload,null,2));
    } catch (error) {
      next(error);
    }
  }
);


importerRouter.get(
  '/legacy-cash-reconcile-preview',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const result = await query(`
        SELECT
          COALESCE((
            SELECT sum(CASE WHEN direction='IN' THEN amount ELSE -amount END)
            FROM cash_ledger
            WHERE status='POSTED'
          ),0)::numeric(15,2) AS current_cash,

          COALESCE((
            SELECT sum(amount)
            FROM cash_ledger
            WHERE status='POSTED'
              AND category='ADJUSTMENT'
              AND description ILIKE 'Legacy opening cash%'
          ),0)::numeric(15,2) AS wrong_opening_cash,

          COALESCE((
            SELECT sum(amount)
            FROM cash_ledger
            WHERE status='POSTED'
              AND category='LOAN_CHARGE'
              AND description ILIKE 'Legacy SERVICE charge%'
          ),0)::numeric(15,2) AS service_cash,

          COALESCE((
            SELECT sum(t.amount)
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
          ),0)::numeric(15,2) AS opening_fund_misclassified_as_investor,

          COALESCE((
            SELECT sum(
              CASE
                WHEN t.status<>'POSTED' THEN 0
                WHEN t.transaction_type IN ('DEPOSIT','ADJUSTMENT') THEN t.amount
                WHEN t.transaction_type IN ('WITHDRAWAL','INTEREST_PAID') THEN -t.amount
                ELSE 0
              END
            )
            FROM investor_transactions t
          ),0)::numeric(15,2) AS current_investor_capital,

          COALESCE((
            SELECT sum(amount)
            FROM cash_ledger
            WHERE status='POSTED'
              AND direction='IN'
              AND category='LOAN_CHARGE'
              AND description NOT ILIKE 'Legacy SERVICE charge%'
          ),0)::numeric(15,2) AS projected_doc_ins_income
      `);

      const r = result.rows[0];
      const projectedCash = (
        Number(r.current_cash)
        - Number(r.wrong_opening_cash)
        - Number(r.service_cash)
      ).toFixed(2);

      const projectedInvestor = (
        Number(r.current_investor_capital)
        - Number(r.opening_fund_misclassified_as_investor)
      ).toFixed(2);

      res.json({
        preview: {
          ...r,
          projected_cash: projectedCash,
          projected_investor_capital: projectedInvestor
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.post(
  '/legacy-cash-reconcile',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      if (req.body?.confirmation !== 'FIX LEGACY CASH') {
        throw businessError('Confirmation text is incorrect.');
      }

      const fixed = await withTransaction(req.auth.user_id, async (client) => {
        const badOpening = await client.query(`
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE status='POSTED'
            AND category='ADJUSTMENT'
            AND description ILIKE 'Legacy opening cash%'
          RETURNING id,amount
        `);

        const serviceRows = await client.query(`
          UPDATE cash_ledger
          SET status='VOIDED'
          WHERE status='POSTED'
            AND category='LOAN_CHARGE'
            AND description ILIKE 'Legacy SERVICE charge%'
          RETURNING id,amount
        `);

        const openingInvestor = await client.query(`
          SELECT
            t.id,
            t.transaction_date,
            t.amount,
            t.payment_method,
            t.notes,
            i.id AS investor_id,
            i.investor_name
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
          ORDER BY t.transaction_date,t.created_at
          FOR UPDATE OF t
        `);

        let convertedFund = 0;

        for (const row of openingInvestor.rows) {
          convertedFund += Number(row.amount);

          await client.query(
            `
            UPDATE investor_transactions
            SET
              status='VOIDED',
              voided_at=now(),
              voided_by=$2,
              void_reason='Legacy migration correction: Opening / Added Fund is company fund, not investor capital'
            WHERE id=$1
            `,
            [row.id, req.auth.user_id]
          );

          await client.query(
            `
            UPDATE cash_ledger
            SET status='VOIDED'
            WHERE status='POSTED'
              AND source_table='investor_transactions'
              AND source_id=$1
            `,
            [row.id]
          );

          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            VALUES(
              $1,'IN','ADJUSTMENT',$2,$3,
              NULL,NULL,$4,$5
            )
            `,
            [
              row.transaction_date,
              row.amount,
              row.payment_method,
              `Legacy opening & added fund - ${row.investor_name}`,
              req.auth.user_id
            ]
          );
        }

        await client.query(`
          UPDATE investors i
          SET status='INACTIVE',updated_at=now()
          WHERE i.notes='Imported from old JK Investment backup'
            AND NOT EXISTS (
              SELECT 1
              FROM investor_transactions t
              WHERE t.investor_id=i.id
                AND t.status='POSTED'
            )
        `);

        const totals = await client.query(`
          SELECT
            COALESCE((
              SELECT sum(CASE WHEN direction='IN' THEN amount ELSE -amount END)
              FROM cash_ledger
              WHERE status='POSTED'
            ),0)::numeric(15,2) AS cash_in_hand,

            COALESCE((
              SELECT sum(amount)
              FROM cash_ledger
              WHERE status='POSTED'
                AND direction='IN'
                AND category='LOAN_CHARGE'
                AND description NOT ILIKE 'Legacy SERVICE charge%'
            ),0)::numeric(15,2) AS doc_ins_income,

            COALESCE((
              SELECT sum(
                CASE
                  WHEN t.status<>'POSTED' THEN 0
                  WHEN t.transaction_type IN ('DEPOSIT','ADJUSTMENT') THEN t.amount
                  WHEN t.transaction_type IN ('WITHDRAWAL','INTEREST_PAID') THEN -t.amount
                  ELSE 0
                END
              )
              FROM investor_transactions t
            ),0)::numeric(15,2) AS investor_capital,

            COALESCE((
              SELECT sum(amount)
              FROM cash_ledger
              WHERE status='POSTED'
                AND direction='IN'
                AND category='ADJUSTMENT'
                AND description ILIKE 'Legacy opening & added fund%'
            ),0)::numeric(15,2) AS opening_added_fund
        `);

        return {
          wrong_opening_cash_voided: badOpening.rows.reduce(
            (s,x)=>s+Number(x.amount),0
          ).toFixed(2),
          service_cash_voided: serviceRows.rows.reduce(
            (s,x)=>s+Number(x.amount),0
          ).toFixed(2),
          opening_fund_converted: convertedFund.toFixed(2),
          ...totals.rows[0]
        };
      });

      res.json({
        ok:true,
        message:'Legacy cash classification corrected successfully.',
        fixed
      });
    } catch (error) {
      next(error);
    }
  }
);

importerRouter.post(
  '/legacy-replace',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const { confirmation, backup } = req.body || {};

      if (confirmation !== 'IMPORT OLD JK DATA') {
        throw businessError('Confirmation text is incorrect.');
      }

      validateBackup(backup);
      const preview = backupPreview(backup);

      const result = await withTransaction(req.auth.user_id, async (client) => {
        // Controlled full replacement of TEST / staging business data.
        //
        // Financial tables intentionally block row-by-row physical DELETE.
        // For an explicitly confirmed legacy migration, truncate the complete
        // business-data graph in ONE transaction instead. PostgreSQL TRUNCATE
        // does not invoke the row-level DELETE protection triggers.
        //
        // Authentication, users, 2FA, roles, permissions, sessions,
        // charge_defaults, audit_logs and environment configuration remain.
        await client.query(`
          TRUNCATE TABLE
            payment_allocations,
            payments,
            loan_charges,
            loan_guarantors,
            loan_schedule,
            cash_ledger,
            expenses,
            investor_transactions,
            investors,
            loans,
            customers,
            groups,
            centers
          RESTART IDENTITY
        `);

        const centerMap = new Map();
        const groupMap = new Map();
        const customerMap = new Map();
        const loanMap = new Map();

        // 1. Centers
        for (const c of asArray(backup.centers)) {
          const day = isoDow(c.collectionDay);
          if (!day) throw businessError(`Invalid collection day for ${c.name}`);

          const inserted = await client.query(
            `
            INSERT INTO centers(center_name,address,collection_isodow,created_by)
            VALUES($1,$2,$3,$4)
            RETURNING id,center_name
            `,
            [
              String(c.name || '').trim(),
              String(c.address || '').trim() || null,
              day,
              req.auth.user_id
            ]
          );

          centerMap.set(
            String(c.name || '').trim().toUpperCase(),
            inserted.rows[0].id
          );
        }

        // 2. Groups
        for (const g of asArray(backup.groups)) {
          const centerId = centerMap.get(
            String(g.centerName || '').trim().toUpperCase()
          );
          if (!centerId) throw businessError(`Center missing for group ${g.name}`);

          const inserted = await client.query(
            `
            INSERT INTO groups(center_id,group_name,members_count,created_by)
            VALUES($1,$2,$3,$4)
            RETURNING id
            `,
            [
              centerId,
              String(g.name || '').trim(),
              Number.isFinite(Number(g.members)) ? Number(g.members) : null,
              req.auth.user_id
            ]
          );

          groupMap.set(
            `${String(g.centerName||'').trim().toUpperCase()}|${String(g.name||'').trim().toUpperCase()}`,
            inserted.rows[0].id
          );
        }

        // 3. Customers
        for (const c of asArray(backup.customers)) {
          const centerKey = String(c.center || '').trim().toUpperCase();
          const groupKey = `${centerKey}|${String(c.groupName || '').trim().toUpperCase()}`;
          const centerId = centerMap.get(centerKey);
          const groupId = groupMap.get(groupKey);

          if (!centerId) throw businessError(`Center missing for customer ${c.code}`);
          if (!groupId) throw businessError(`Group missing for customer ${c.code}`);

          const inserted = await client.query(
            `
            INSERT INTO customers(
              customer_code,center_id,group_id,customer_name,nic,mobile,
              default_guarantor_name,default_guarantor_nic,default_guarantor_mobile,
              status,created_by,updated_by
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
            RETURNING id
            `,
            [
              String(c.code || '').trim(),
              centerId,
              groupId,
              String(c.name || '').trim(),
              String(c.nic || '').trim(),
              String(c.phone || '').trim() || null,
              String(c.guarantor || '').trim() || null,
              String(c.guarantorNic || '').trim() || null,
              String(c.guarantorPhone || '').trim() || null,
              String(c.status || '').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
              req.auth.user_id
            ]
          );

          customerMap.set(String(c.code || ''), {
            id: inserted.rows[0].id,
            center_id: centerId,
            group_id: groupId
          });
        }

        // 4. Loans + schedules + guarantors
        for (const l of asArray(backup.loans)) {
          const customer = customerMap.get(String(l.customerCode || ''));
          if (!customer) throw businessError(`Customer missing for loan ${l.code}`);

          const lifecycle = String(l.status || '').toUpperCase() === 'DISBURSED'
            ? 'DISBURSED'
            : 'PENDING';

          const disbursedDate = lifecycle === 'DISBURSED'
            ? inferDisbursedDate(backup,l)
            : null;

          if (lifecycle === 'DISBURSED' && !disbursedDate) {
            throw businessError(`Could not infer disbursement date for ${l.code}`);
          }

          const inserted = await client.query(
            `
            INSERT INTO loans(
              loan_code,customer_id,center_id,group_id,
              principal,interest_rate,loan_type,installment_count,
              repayment_start_date,lifecycle_status,disbursed_date,
              created_by,updated_by
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
            RETURNING id
            `,
            [
              String(l.code || '').trim(),
              customer.id,
              customer.center_id,
              customer.group_id,
              num(l.principal),
              num(l.interestRate),
              normalizeLoanType(l.repaymentType),
              Math.max(1,Number(l.instalmentCount || 1)),
              String(l.firstDue).slice(0,10),
              lifecycle,
              disbursedDate,
              req.auth.user_id
            ]
          );

          const loanId = inserted.rows[0].id;
          loanMap.set(String(l.code || ''), loanId);

          if (String(l.guarantor || '').trim()) {
            await client.query(
              `
              INSERT INTO loan_guarantors(
                loan_id,guarantor_order,guarantor_name,nic,mobile
              )
              VALUES($1,1,$2,$3,$4)
              `,
              [
                loanId,
                String(l.guarantor || '').trim(),
                String(l.guarantorNic || '').trim() || 'N/A',
                String(l.guarantorPhone || '').trim() || null
              ]
            );
          }

          if (lifecycle === 'DISBURSED') {
            await client.query(`SELECT generate_loan_schedule($1)`,[loanId]);

            await client.query(
              `
              INSERT INTO cash_ledger(
                entry_date,direction,category,amount,payment_method,
                source_table,source_id,description,created_by
              )
              VALUES($1,'OUT','LOAN_DISBURSEMENT',$2,'CASH','loans',$3,$4,$5)
              `,
              [
                disbursedDate,
                num(l.principal),
                loanId,
                `Legacy ${String(l.code)} principal disbursement`,
                req.auth.user_id
              ]
            );
          }
        }

        // 5. Exact legacy DOC / INS / SERVICE charges.
        for (const item of asArray(backup.loanCharges)) {
          const loanId = loanMap.get(String(item.loanCode || ''));
          if (!loanId) throw businessError(`Loan missing for charge ${item.loanCode}`);

          const parts = [
            ['DOCUMENT',num(item.docCharge)],
            ['INSURANCE',num(item.insCharge)],
            ['SERVICE',num(item.serviceCharge)]
          ];

          for (const [chargeType,amount] of parts) {
            const inserted = await client.query(
              `
              INSERT INTO loan_charges(
                loan_id,charge_type,amount,status,collected_date,
                payment_method,notes,created_by
              )
              VALUES($1,$2,$3,'COLLECTED',$4,$5,$6,$7)
              ON CONFLICT (loan_id,charge_type)
              DO UPDATE SET
                amount=EXCLUDED.amount,
                status='COLLECTED',
                collected_date=EXCLUDED.collected_date,
                payment_method=EXCLUDED.payment_method,
                notes=EXCLUDED.notes,
                updated_at=now()
              RETURNING id
              `,
              [
                loanId,
                chargeType,
                amount,
                String(item.chargedOn || '').slice(0,10),
                normalizeMethod(item.mode),
                `Legacy import ${item.receipt || ''} ${item.note || ''}`.trim(),
                req.auth.user_id
              ]
            );

            if (amount > 0 && chargeType !== 'SERVICE') {
              await client.query(
                `
                INSERT INTO cash_ledger(
                  entry_date,direction,category,amount,payment_method,
                  source_table,source_id,description,created_by
                )
                VALUES($1,'IN','LOAN_CHARGE',$2,$3,'loan_charges',$4,$5,$6)
                `,
                [
                  String(item.chargedOn || '').slice(0,10),
                  amount,
                  normalizeMethod(item.mode),
                  inserted.rows[0].id,
                  `Legacy ${chargeType} charge - ${item.loanCode}`,
                  req.auth.user_id
                ]
              );
            }
          }
        }

        // 6. Collections / receipts.
        for (const p of asArray(backup.collections)) {
          const loanId = loanMap.get(String(p.loanCode || ''));
          if (!loanId) throw businessError(`Loan missing for receipt ${p.receipt}`);

          const links = await client.query(
            `SELECT customer_id,center_id FROM loans WHERE id=$1`,
            [loanId]
          );

          const inserted = await client.query(
            `
            INSERT INTO payments(
              receipt_no,loan_id,customer_id,center_id,payment_date,
              amount,payment_method,notes,entered_by
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id
            `,
            [
              String(p.receipt || '').trim(),
              loanId,
              links.rows[0].customer_id,
              links.rows[0].center_id,
              String(p.collectedOn || '').slice(0,10),
              num(p.amount),
              normalizeMethod(p.mode),
              String(p.note || '').trim() || null,
              req.auth.user_id
            ]
          );

          const paymentId = inserted.rows[0].id;
          await client.query(`SELECT allocate_payment_fifo($1)`,[paymentId]);

          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            VALUES($1,'IN','COLLECTION',$2,$3,'payments',$4,$5,$6)
            `,
            [
              String(p.collectedOn || '').slice(0,10),
              num(p.amount),
              normalizeMethod(p.mode),
              paymentId,
              `Legacy collection ${p.receipt || ''}`,
              req.auth.user_id
            ]
          );
        }

        // 7. Expenses.
        for (const e of asArray(backup.expenses)) {
          const inserted = await client.query(
            `
            INSERT INTO expenses(
              expense_no,expense_date,category,description,amount,
              payment_method,entered_by
            )
            VALUES($1,$2,$3,$4,$5,$6,$7)
            RETURNING id
            `,
            [
              String(e.code || '').trim(),
              String(e.spentOn || '').slice(0,10),
              String(e.category || 'Other').trim(),
              String(e.note || '').trim() || null,
              num(e.amount),
              normalizeMethod(e.paymentMode),
              req.auth.user_id
            ]
          );

          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            VALUES($1,'OUT','EXPENSE',$2,$3,'expenses',$4,$5,$6)
            `,
            [
              String(e.spentOn || '').slice(0,10),
              num(e.amount),
              normalizeMethod(e.paymentMode),
              inserted.rows[0].id,
              `Legacy expense ${e.code || ''} - ${e.note || e.category || ''}`,
              req.auth.user_id
            ]
          );
        }

        // 8. Company opening / added fund and true investor capital.
        const investorMap = new Map();

        for (const cap of asArray(backup.capitalEntries)) {
          const capType = String(cap.type || '').trim();

          if (isOpeningCompanyFundType(capType)) {
            await client.query(
              `
              INSERT INTO cash_ledger(
                entry_date,direction,category,amount,payment_method,
                description,created_by
              )
              VALUES($1,'IN','ADJUSTMENT',$2,'CASH',$3,$4)
              `,
              [
                String(cap.date || '').slice(0,10),
                num(cap.amount),
                `Legacy opening & added fund - ${String(cap.investor || capType || 'Company')}`,
                req.auth.user_id
              ]
            );
            continue;
          }

          const key = String(cap.investor || 'Legacy Investor').trim().toUpperCase();
          let investorId = investorMap.get(key);

          if (!investorId) {
            const created = await client.query(
              `
              INSERT INTO investors(investor_name,notes,created_by)
              VALUES($1,$2,$3)
              RETURNING id
              `,
              [
                String(cap.investor || 'Legacy Investor').trim(),
                'Imported from old JK Investment backup',
                req.auth.user_id
              ]
            );
            investorId = created.rows[0].id;
            investorMap.set(key,investorId);
          }

          const txn = await client.query(
            `
            INSERT INTO investor_transactions(
              investor_id,transaction_date,transaction_type,amount,
              payment_method,notes,entered_by
            )
            VALUES($1,$2,'DEPOSIT',$3,'CASH',$4,$5)
            RETURNING id
            `,
            [
              investorId,
              String(cap.date || '').slice(0,10),
              num(cap.amount),
              `${capType || 'Investment'} · ${String(cap.note || '')}`.trim(),
              req.auth.user_id
            ]
          );

          await client.query(
            `
            INSERT INTO cash_ledger(
              entry_date,direction,category,amount,payment_method,
              source_table,source_id,description,created_by
            )
            VALUES($1,'IN','INVESTOR_DEPOSIT',$2,'CASH','investor_transactions',$3,$4,$5)
            `,
            [
              String(cap.date || '').slice(0,10),
              num(cap.amount),
              txn.rows[0].id,
              `Legacy investor capital - ${cap.investor}`,
              req.auth.user_id
            ]
          );
        }

        // 9. Legacy Cash Book opening values are snapshots, not new money.
        // They are intentionally NOT posted into cash_ledger.
        // Cash in hand is rebuilt only from actual transactions.
        // 10. Final reconciliation.
        const reconciliation = await client.query(`
          SELECT
            (SELECT count(*)::int FROM customers) AS customers,
            (SELECT count(*)::int FROM loans) AS loans,
            (SELECT count(*)::int FROM payments WHERE status='POSTED') AS collections,
            (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='POSTED')::numeric(15,2) AS collection_total,
            (SELECT COALESCE(sum(principal),0) FROM loans WHERE lifecycle_status='DISBURSED')::numeric(15,2) AS principal_total,
            (SELECT COALESCE(sum(total_payable),0) FROM loans WHERE lifecycle_status='DISBURSED')::numeric(15,2) AS payable_total,
            (SELECT COALESCE(sum(amount),0) FROM expenses WHERE status='POSTED')::numeric(15,2) AS expense_total,
            (SELECT COALESCE(sum(amount),0)
             FROM cash_ledger
             WHERE status='POSTED'
               AND direction='IN'
               AND category='LOAN_CHARGE')::numeric(15,2) AS doc_ins_income,

            (SELECT COALESCE(sum(
              CASE WHEN transaction_type='DEPOSIT' THEN amount
                   WHEN transaction_type IN ('WITHDRAWAL','INTEREST_PAID') THEN -amount
                   ELSE 0 END
            ),0) FROM investor_transactions WHERE status='POSTED')::numeric(15,2) AS investor_total,

            (SELECT COALESCE(sum(amount),0)
             FROM cash_ledger
             WHERE status='POSTED'
               AND direction='IN'
               AND category='ADJUSTMENT'
               AND description ILIKE 'Legacy opening & added fund%')::numeric(15,2) AS opening_added_fund
        `);

        const r = reconciliation.rows[0];

        if (Number(r.customers) !== preview.counts.customers) {
          throw businessError('Customer count reconciliation failed.');
        }
        if (Number(r.loans) !== preview.counts.loans) {
          throw businessError('Loan count reconciliation failed.');
        }
        if (Number(r.collections) !== preview.counts.collections) {
          throw businessError('Collection count reconciliation failed.');
        }
        if (Number(r.collection_total) !== Number(preview.totals.collections)) {
          throw businessError('Collection total reconciliation failed.');
        }
        if (Number(r.principal_total) !== Number(preview.totals.principal)) {
          throw businessError('Principal total reconciliation failed.');
        }
        if (Number(r.payable_total) !== Number(preview.totals.total_payable)) {
          throw businessError('Total payable reconciliation failed.');
        }
        if (Number(r.expense_total) !== Number(preview.totals.expenses)) {
          throw businessError('Expense total reconciliation failed.');
        }
        if (Number(r.doc_ins_income) !== Number(preview.totals.doc_ins_income)) {
          throw businessError('DOC & INS income reconciliation failed.');
        }
        if (Number(r.investor_total) !== Number(preview.totals.investor_capital)) {
          throw businessError('Investor capital reconciliation failed.');
        }
        if (Number(r.opening_added_fund) !== Number(preview.totals.opening_added_fund)) {
          throw businessError('Opening / added fund reconciliation failed.');
        }

        return r;
      });

      res.json({
        ok: true,
        message: 'Legacy JK Investment data imported successfully.',
        imported: result,
        source_preview: preview
      });
    } catch (error) {
      next(error);
    }
  }
);
