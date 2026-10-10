
import express from 'express';
import crypto from 'crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { query, withReadSnapshot } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { ensureSalaryAdvanceSchema } from './salary-advance.js';
import { ensureDailyClosingSchema } from './daily-closing.js';

export const backupRouter = express.Router();

function backupBusinessError(message) {
  const error = new Error(message);
  error.code = 'P0001';
  return error;
}

function backupEnvironmentStatus() {
  return {
    google_oauth_client_id: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID),
    google_oauth_client_secret: Boolean(process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    google_oauth_refresh_token: Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN),
    google_drive_folder_id: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID),
    cron_secret: Boolean(process.env.CRON_SECRET)
  };
}
function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function xmlEscape(value) {
  return safeText(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colName(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ------------------------------------------------------------
// Tiny dependency-free ZIP writer.
// Uses STORE mode (no compression) for maximum compatibility.
// ------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) {
    c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(now.dosTime, 10);
    local.writeUInt16LE(now.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // STORE
    central.writeUInt16LE(now.dosTime, 12);
    central.writeUInt16LE(now.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

// ------------------------------------------------------------
// Minimal XLSX generator (one sheet per file).
// No external npm package required.
// ------------------------------------------------------------
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0B6B57"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD9E2DF"/></left>
      <right style="thin"><color rgb="FFD9E2DF"/></right>
      <top style="thin"><color rgb="FFD9E2DF"/></top>
      <bottom style="thin"><color rgb="FFD9E2DF"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function xlsxCell(ref, value, style = 0, type = 'text') {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}" s="${style}"/>`;
  }

  if (type === 'money' || type === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      const s = type === 'money' ? 2 : 3;
      return `<c r="${ref}" s="${s}" t="n"><v>${n}</v></c>`;
    }
  }

  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function makeXlsx(sheetName, columns, rows) {
  const safeSheetName = safeText(sheetName).slice(0, 31).replace(/[\\/*?:[\]]/g, ' ') || 'Sheet1';
  const lastCol = colName(Math.max(columns.length, 1));
  const lastRow = Math.max(rows.length + 1, 1);

  const colXml = columns.map((c, i) => {
    const width = Math.max(10, Math.min(Number(c.width || 18), 42));
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');

  const headerCells = columns.map((c, i) =>
    xlsxCell(`${colName(i + 1)}1`, c.header, 1, 'text')
  ).join('');

  const dataRows = rows.map((row, rowIndex) => {
    const r = rowIndex + 2;
    const cells = columns.map((c, i) => {
      const raw = typeof c.value === 'function' ? c.value(row) : row[c.key];
      return xlsxCell(`${colName(i + 1)}${r}`, raw, 0, c.type || 'text');
    }).join('');
    return `<row r="${r}" ht="18" customHeight="1">${cells}</row>`;
  }).join('');

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${colXml}</cols>
  <sheetData>
    <row r="1" ht="22" customHeight="1">${headerCells}</row>
    ${dataRows}
  </sheetData>
  <autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const created = new Date().toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>JK Investment Backup - ${xmlEscape(safeSheetName)}</dc:title>
  <dc:creator>JK Investment</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>JK Investment Backup</Application>
</Properties>`;

  return createZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: worksheetXml }
  ]);
}

function isoDayName(value) {
  return ({
    1:'Monday',2:'Tuesday',3:'Wednesday',4:'Thursday',
    5:'Friday',6:'Saturday',7:'Sunday'
  })[Number(value)] || safeText(value);
}

async function loadBackupData(query) {
  const [
    centers, groups, customers, loans, payments, arrears,
    charges, expenses, investors, schedules, guarantors,
    allocations, defaults, cashLedger, auditLogs, users, salaryMonthLimits, salaryAdvances, salaryPayments, salaryRecords,
    dailyClosings, cashTransfers
  ] = await Promise.all([
    query(`
      SELECT id,center_code,center_name,address,collection_isodow,status,created_at,updated_at
      FROM centers ORDER BY center_code
    `),
    query(`
      SELECT g.id,g.group_code,g.group_name,g.members_count,g.status,
             g.center_id,c.center_code,c.center_name,g.created_at,g.updated_at
      FROM groups g JOIN centers c ON c.id=g.center_id
      ORDER BY c.center_name,g.group_name
    `),
    query(`
      SELECT cu.id,cu.customer_code,cu.customer_name,cu.nic,cu.mobile,cu.address,
             cu.default_guarantor_name,cu.default_guarantor_nic,cu.default_guarantor_mobile,
             cu.status,cu.center_id,ce.center_code,ce.center_name,
             cu.group_id,g.group_code,g.group_name,cu.created_at,cu.updated_at
      FROM customers cu
      JOIN centers ce ON ce.id=cu.center_id
      JOIN groups g ON g.id=cu.group_id
      ORDER BY cu.customer_code
    `),
    query(`
      SELECT l.id,l.loan_code,l.customer_id,cu.customer_code,cu.customer_name,
             l.center_id,ce.center_code,ce.center_name,l.group_id,g.group_code,g.group_name,
             l.principal,l.interest_rate,l.interest_amount,l.total_payable,
             l.loan_type,l.installment_count,l.repayment_start_date,l.lifecycle_status,
             l.disbursed_date,l.cancellation_reason,l.created_at,l.updated_at,
             vf.total_paid,vf.balance,vf.arrears,vf.advance,vf.operational_status
      FROM loans l
      JOIN customers cu ON cu.id=l.customer_id
      JOIN centers ce ON ce.id=l.center_id
      JOIN groups g ON g.id=l.group_id
      LEFT JOIN v_loan_financials vf ON vf.loan_id=l.id
      ORDER BY l.loan_code
    `),
    query(`
      SELECT p.id,p.receipt_no,p.payment_date,p.amount,p.payment_method,p.reference_no,
             p.notes,p.status,p.void_reason,p.created_at,p.updated_at,
             p.loan_id,l.loan_code,p.customer_id,cu.customer_code,cu.customer_name,
             p.center_id,ce.center_code,ce.center_name
      FROM payments p
      JOIN loans l ON l.id=p.loan_id
      JOIN customers cu ON cu.id=p.customer_id
      JOIN centers ce ON ce.id=p.center_id
      ORDER BY p.payment_date,p.created_at
    `),
    query(`
      SELECT vf.loan_id,vf.loan_code,cu.customer_code,cu.customer_name,
             ce.center_code,ce.center_name,g.group_code,g.group_name,
             vf.total_payable,vf.total_paid,vf.balance,vf.arrears,vf.advance,
             vf.repayment_start_date,vf.last_due_date,vf.operational_status
      FROM v_loan_financials vf
      JOIN loans l ON l.id=vf.loan_id
      JOIN customers cu ON cu.id=vf.customer_id
      JOIN centers ce ON ce.id=vf.center_id
      JOIN groups g ON g.id=vf.group_id
      WHERE l.lifecycle_status = 'DISBURSED'
        AND vf.balance > 0
      ORDER BY vf.arrears DESC,cu.customer_name
    `),
    query(`
      SELECT lc.id,lc.charge_type,lc.amount,lc.status,lc.collected_date,
             lc.payment_method,lc.notes,lc.created_at,lc.updated_at,
             lc.loan_id,l.loan_code,cu.customer_code,cu.customer_name,
             ce.center_code,ce.center_name
      FROM loan_charges lc
      JOIN loans l ON l.id=lc.loan_id
      JOIN customers cu ON cu.id=l.customer_id
      JOIN centers ce ON ce.id=l.center_id
      ORDER BY COALESCE(lc.collected_date,lc.created_at::date),l.loan_code,lc.charge_type
    `),
    query(`
      SELECT id,expense_no,expense_date,category,description,amount,payment_method,
             status,void_reason,created_at,updated_at
      FROM expenses ORDER BY expense_date,created_at
    `),
    query(`
      SELECT i.id,i.investor_name,i.mobile,i.nic,i.status,i.notes,i.created_at,i.updated_at,
             t.id AS transaction_id,t.transaction_no,t.transaction_date,t.transaction_type,
             t.amount,t.payment_method,t.notes AS transaction_notes,t.status AS transaction_status,
             t.void_reason,t.created_at AS transaction_created_at
      FROM investors i
      LEFT JOIN investor_transactions t ON t.investor_id=i.id
      ORDER BY i.investor_name,t.transaction_date,t.created_at
    `),
    query(`SELECT * FROM loan_schedule ORDER BY loan_id,installment_no`),
    query(`SELECT * FROM loan_guarantors ORDER BY created_at`),
    query(`SELECT * FROM payment_allocations ORDER BY created_at`),
    query(`SELECT * FROM charge_defaults ORDER BY charge_type`),
    query(`SELECT * FROM cash_ledger ORDER BY entry_date,created_at`),
    query(`SELECT * FROM audit_logs ORDER BY created_at`),
    query(`
      SELECT u.id,u.username,u.full_name,u.email,u.mobile,u.status,u.two_factor_enabled,
             u.failed_login_count,u.locked_until,u.password_changed_at,u.last_login_at,
             u.created_at,u.updated_at,r.code AS role_code,r.name AS role_name
      FROM users u JOIN roles r ON r.id=u.role_id
      ORDER BY u.created_at
    `),
    query(`SELECT * FROM salary_month_limits ORDER BY salary_month`),
    query(`SELECT * FROM salary_advances ORDER BY salary_month,advance_date,created_at`),
    query(`SELECT * FROM salary_payments ORDER BY salary_month,payment_date,created_at`),
    query(`
      SELECT
        l.salary_month,l.salary_limit,
        a.advance_no,a.advance_date,a.amount,a.payment_method,a.notes,a.status,
        a.void_reason,a.created_at
      FROM salary_month_limits l
      LEFT JOIN salary_advances a ON a.salary_month=l.salary_month
      ORDER BY l.salary_month,a.advance_date,a.created_at
    `),
    query(`SELECT * FROM daily_closings ORDER BY closing_date,created_at`),
    query(`SELECT * FROM cash_transfers ORDER BY transfer_date,created_at`)
  ]);

  return {
    centers: centers.rows,
    groups: groups.rows,
    customers: customers.rows,
    loans: loans.rows,
    payments: payments.rows,
    arrears: arrears.rows,
    charges: charges.rows,
    expenses: expenses.rows,
    investors: investors.rows,
    schedules: schedules.rows,
    guarantors: guarantors.rows,
    allocations: allocations.rows,
    defaults: defaults.rows,
    cashLedger: cashLedger.rows,
    auditLogs: auditLogs.rows,
    users: users.rows,
    salaryMonthLimits: salaryMonthLimits.rows,
    salaryAdvances: salaryAdvances.rows,
    salaryPayments: salaryPayments.rows,
    salaryRecords: salaryRecords.rows,
    dailyClosings: dailyClosings.rows,
    cashTransfers: cashTransfers.rows
  };
}

async function loadRestoreData(generatedAt, query) {

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

  return {
    app: 'JK Investment PostgreSQL Export',
    exportedAt: generatedAt,
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
}

const excelDefinitions = {
  customers: {
    name: 'Customers.xlsx',
    sheet: 'Customers',
    columns: [
      {header:'Customer ID',key:'customer_code',width:18},
      {header:'Customer Name',key:'customer_name',width:28},
      {header:'NIC',key:'nic',width:18},
      {header:'Mobile',key:'mobile',width:16},
      {header:'Address',key:'address',width:32},
      {header:'Center',key:'center_name',width:22},
      {header:'Group',key:'group_name',width:22},
      {header:'Guarantor Name',key:'default_guarantor_name',width:26},
      {header:'Guarantor NIC',key:'default_guarantor_nic',width:18},
      {header:'Guarantor Mobile',key:'default_guarantor_mobile',width:16},
      {header:'Status',key:'status',width:12},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  loans: {
    name: 'Loans.xlsx',
    sheet: 'Loans',
    columns: [
      {header:'Loan ID',key:'loan_code',width:16},
      {header:'Customer ID',key:'customer_code',width:18},
      {header:'Customer',key:'customer_name',width:28},
      {header:'Center',key:'center_name',width:22},
      {header:'Group',key:'group_name',width:22},
      {header:'Principal',key:'principal',type:'money',width:16},
      {header:'Interest %',key:'interest_rate',type:'number',width:12},
      {header:'Interest Amount',key:'interest_amount',type:'money',width:18},
      {header:'Total Payable',key:'total_payable',type:'money',width:18},
      {header:'Paid',key:'total_paid',type:'money',width:16},
      {header:'Balance',key:'balance',type:'money',width:16},
      {header:'Arrears',key:'arrears',type:'money',width:16},
      {header:'Advance',key:'advance',type:'money',width:16},
      {header:'Loan Type',key:'loan_type',width:12},
      {header:'Installments',key:'installment_count',type:'number',width:12},
      {header:'Repayment Start',key:'repayment_start_date',width:16},
      {header:'Disbursed Date',key:'disbursed_date',width:16},
      {header:'Status',key:'operational_status',width:12},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  payments: {
    name: 'Payments.xlsx',
    sheet: 'Payments',
    columns: [
      {header:'Receipt No',key:'receipt_no',width:18},
      {header:'Date',key:'payment_date',width:14},
      {header:'Customer ID',key:'customer_code',width:18},
      {header:'Customer',key:'customer_name',width:28},
      {header:'Loan ID',key:'loan_code',width:16},
      {header:'Center',key:'center_name',width:22},
      {header:'Amount',key:'amount',type:'money',width:16},
      {header:'Method',key:'payment_method',width:12},
      {header:'Reference',key:'reference_no',width:18},
      {header:'Status',key:'status',width:12},
      {header:'Notes',key:'notes',width:32},
      {header:'Void Reason',key:'void_reason',width:28},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  arrears: {
    name: 'Arrears.xlsx',
    sheet: 'Arrears',
    columns: [
      {header:'Loan ID',key:'loan_code',width:16},
      {header:'Customer ID',key:'customer_code',width:18},
      {header:'Customer',key:'customer_name',width:28},
      {header:'Center',key:'center_name',width:22},
      {header:'Group',key:'group_name',width:22},
      {header:'Total Payable',key:'total_payable',type:'money',width:18},
      {header:'Paid',key:'total_paid',type:'money',width:16},
      {header:'Balance',key:'balance',type:'money',width:16},
      {header:'Arrears',key:'arrears',type:'money',width:16},
      {header:'Advance',key:'advance',type:'money',width:16},
      {header:'Repayment Start',key:'repayment_start_date',width:16},
      {header:'Last Due Date',key:'last_due_date',width:16},
      {header:'Status',key:'operational_status',width:12}
    ]
  },
  charges: {
    name: 'DOC_INS.xlsx',
    sheet: 'DOC_INS',
    columns: [
      {header:'Date',key:'collected_date',width:14},
      {header:'Loan ID',key:'loan_code',width:16},
      {header:'Customer ID',key:'customer_code',width:18},
      {header:'Customer',key:'customer_name',width:28},
      {header:'Center',key:'center_name',width:22},
      {header:'Charge Type',key:'charge_type',width:16},
      {header:'Amount',key:'amount',type:'money',width:16},
      {header:'Status',key:'status',width:12},
      {header:'Method',key:'payment_method',width:12},
      {header:'Notes',key:'notes',width:32},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  expenses: {
    name: 'Expenses.xlsx',
    sheet: 'Expenses',
    columns: [
      {header:'Expense No',key:'expense_no',width:18},
      {header:'Date',key:'expense_date',width:14},
      {header:'Category',key:'category',width:20},
      {header:'Description',key:'description',width:32},
      {header:'Amount',key:'amount',type:'money',width:16},
      {header:'Method',key:'payment_method',width:12},
      {header:'Status',key:'status',width:12},
      {header:'Void Reason',key:'void_reason',width:28},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  investors: {
    name: 'Investors.xlsx',
    sheet: 'Investors',
    columns: [
      {header:'Investor',key:'investor_name',width:28},
      {header:'Mobile',key:'mobile',width:16},
      {header:'NIC',key:'nic',width:18},
      {header:'Investor Status',key:'status',width:14},
      {header:'Transaction No',key:'transaction_no',width:18},
      {header:'Date',key:'transaction_date',width:14},
      {header:'Type',key:'transaction_type',width:18},
      {header:'Amount',key:'amount',type:'money',width:16},
      {header:'Method',key:'payment_method',width:12},
      {header:'Transaction Status',key:'transaction_status',width:16},
      {header:'Notes',key:'transaction_notes',width:32}
    ]
  },
  centers: {
    name: 'Centers.xlsx',
    sheet: 'Centers',
    columns: [
      {header:'Center Code',key:'center_code',width:16},
      {header:'Center Name',key:'center_name',width:26},
      {header:'Address',key:'address',width:32},
      {header:'Collection Day',value:r=>isoDayName(r.collection_isodow),width:16},
      {header:'Status',key:'status',width:12},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  groups: {
    name: 'Groups.xlsx',
    sheet: 'Groups',
    columns: [
      {header:'Group Code',key:'group_code',width:16},
      {header:'Group Name',key:'group_name',width:26},
      {header:'Center Code',key:'center_code',width:16},
      {header:'Center',key:'center_name',width:24},
      {header:'Members Count',key:'members_count',type:'number',width:14},
      {header:'Status',key:'status',width:12},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  salaryRecords: {
    name: 'Salary_Advance.xlsx',
    sheet: 'Salary Advance',
    columns: [
      {header:'Salary Month',key:'salary_month',width:16},
      {header:'Salary Limit',key:'salary_limit',type:'money',width:18},
      {header:'Advance No',key:'advance_no',width:22},
      {header:'Advance Date',key:'advance_date',width:16},
      {header:'Advance Amount',key:'amount',type:'money',width:18},
      {header:'Method',key:'payment_method',width:12},
      {header:'Status',key:'status',width:12},
      {header:'Notes',key:'notes',width:30},
      {header:'Void Reason',key:'void_reason',width:30},
      {header:'Created At',key:'created_at',width:22}
    ]
  },
  salaryPayments: {
    name: 'Salary_Payments.xlsx',
    sheet: 'Salary Payments',
    columns: [
      {header:'Salary Month',key:'salary_month',width:16},
      {header:'Payment No',key:'payment_no',width:22},
      {header:'Payment Date',key:'payment_date',width:16},
      {header:'Salary Paid',key:'amount',type:'money',width:18},
      {header:'Method',key:'payment_method',width:12},
      {header:'Status',key:'status',width:12},
      {header:'Notes',key:'notes',width:30},
      {header:'Void Reason',key:'void_reason',width:30},
      {header:'Created At',key:'created_at',width:22}
    ]
  }
};

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

async function createFullBackupPayload(data, generatedAt, restoreData) {
  const [rawGuarantors, rawSchedule, rawAllocations, rawDefaults, rawCash] = [
    data.guarantors, data.schedules, data.allocations, data.defaults, data.cashLedger
  ];

  const pendingLoans = data.loans.filter(
    row => String(row.lifecycle_status || '').toUpperCase() === 'PENDING'
  );
  const disbursedLoans = data.loans.filter(
    row => String(row.lifecycle_status || '').toUpperCase() === 'DISBURSED'
  );
  const cancelledLoans = data.loans.filter(
    row => String(row.lifecycle_status || '').toUpperCase() === 'CANCELLED'
  );
  const currentLoans = data.loans.filter(
    row => String(row.lifecycle_status || '').toUpperCase() !== 'CANCELLED'
  );

  return {
    app: 'JK Investment Production Backup',
    version: 34,
    generatedAt,
    security: {
      passwordHashesIncluded: false,
      twoFactorSecretsIncluded: false,
      sessionTokensIncluded: false
    },
    counts: {
      centers: data.centers.length,
      groups: data.groups.length,
      customers: data.customers.length,
      loans: currentLoans.length,
      currentLoans: currentLoans.length,
      pendingLoans: pendingLoans.length,
      disbursedLoans: disbursedLoans.length,
      cancelledLoans: cancelledLoans.length,
      totalLoanRecords: data.loans.length,
      payments: data.payments.length,
      loanCharges: data.charges.length,
      expenses: data.expenses.length,
      investorRows: data.investors.length,
      auditLogs: data.auditLogs.length,
      salaryAdvances: data.salaryAdvances.length,
      salaryPayments: data.salaryPayments.length,
      dailyClosings: data.dailyClosings.length,
      cashTransfers: data.cashTransfers.length
    },
    users: jsonSafe(data.users),
    centers: jsonSafe(data.centers),
    groups: jsonSafe(data.groups),
    customers: jsonSafe(data.customers),
    loans: jsonSafe(data.loans),
    loanGuarantors: jsonSafe(rawGuarantors),
    loanSchedule: jsonSafe(rawSchedule),
    payments: jsonSafe(data.payments),
    paymentAllocations: jsonSafe(rawAllocations),
    chargeDefaults: jsonSafe(rawDefaults),
    loanCharges: jsonSafe(data.charges),
    expenses: jsonSafe(data.expenses),
    investors: jsonSafe(data.investors),
    cashLedger: jsonSafe(rawCash),
    auditLogs: jsonSafe(data.auditLogs),
    salaryMonthLimits: jsonSafe(data.salaryMonthLimits),
    salaryAdvances: jsonSafe(data.salaryAdvances),
    salaryPayments: jsonSafe(data.salaryPayments),
    dailyClosings: jsonSafe(data.dailyClosings),
    cashTransfers: jsonSafe(data.cashTransfers),
    restoreData: jsonSafe(restoreData)
  };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function createBackupArchive() {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.slice(0, 10);
  await ensureSalaryAdvanceSchema();
  await ensureDailyClosingSchema();
  const { data, restoreData } = await withReadSnapshot(async (read) => {
    let totalBytes = 0;
    const boundedRead = async (sql, params) => {
      const result = await read(`SELECT * FROM (${sql.trim().replace(/;$/, '')}) AS backup_rows LIMIT 50001`, params);
      if (result.rows.length > 50000) throw backupBusinessError('A backup table exceeds 50,000 rows. Use a managed PostgreSQL export.');
      totalBytes += Buffer.byteLength(JSON.stringify(result.rows));
      if (totalBytes > 32 * 1024 * 1024) throw backupBusinessError('Backup exceeds the safe size. Use a managed PostgreSQL export.');
      return result;
    };
    return { data: await loadBackupData(boundedRead), restoreData: await loadRestoreData(generatedAt, boundedRead) };
  });
  const files = [];

  for (const [key, def] of Object.entries(excelDefinitions)) {
    const rows = key === 'loans'
      ? (data.loans || []).filter(
          row => String(row.lifecycle_status || '').toUpperCase() !== 'CANCELLED'
        )
      : (data[key] || []);

    files.push({
      name: def.name,
      data: makeXlsx(def.sheet, def.columns, rows)
    });
  }

  const cancelledLoanRows = (data.loans || []).filter(
    row => String(row.lifecycle_status || '').toUpperCase() === 'CANCELLED'
  );

  if (cancelledLoanRows.length) {
    const loanDef = excelDefinitions.loans;
    files.push({
      name: 'Cancelled_Loans.xlsx',
      data: makeXlsx('Cancelled Loans', loanDef.columns, cancelledLoanRows)
    });
  }

  const estimatedBytes = Buffer.byteLength(JSON.stringify({ data, restoreData }));
  if (estimatedBytes > 32 * 1024 * 1024) {
    throw backupBusinessError('Backup exceeds the safe in-memory size. Use a managed PostgreSQL backup/export for this database.');
  }

  const fullBackup = await createFullBackupPayload(data, generatedAt, restoreData);
  files.push({
    name: 'Full_Backup.json',
    data: Buffer.from(JSON.stringify(fullBackup, null, 2), 'utf8')
  });
  files.push({
    name: 'Restore_Backup.json',
    data: Buffer.from(JSON.stringify(restoreData, null, 2), 'utf8')
  });

  const archive = createZip(files);
  const checksum = crypto.createHash('sha256').update(archive).digest('hex');

  return {
    archive,
    checksum,
    fileName: `JK-Investment-Backup-${stamp}.zip`
  };
}

async function getGoogleDriveAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw backupBusinessError(
      'Google Drive backup is not fully configured. Check the Google OAuth environment variables in Vercel.'
    );
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const raw = await response.text();
  let details = {};
  try {
    details = raw ? JSON.parse(raw) : {};
  } catch {
    details = {};
  }

  if (!response.ok) {
    const oauthError = String(details?.error || '').toLowerCase();

    if (oauthError === 'invalid_grant') {
      throw backupBusinessError(
        'Google Drive authorization has expired or was revoked. Set the Google OAuth app to In Production, create a new refresh token once, and update GOOGLE_OAUTH_REFRESH_TOKEN in Vercel.'
      );
    }

    if (oauthError === 'invalid_client') {
      throw backupBusinessError(
        'Google OAuth Client ID or Client Secret is invalid. Check the Vercel Google OAuth environment variables.'
      );
    }

    throw backupBusinessError(
      'Google authentication failed. Reconnect Google Drive and try the backup again.'
    );
  }

  if (!details?.access_token) {
    throw backupBusinessError(
      'Google authentication did not return an access token. Reconnect Google Drive and try again.'
    );
  }

  return details.access_token;
}

async function uploadBackupToGoogleDrive(archive, fileName) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderId) {
    throw backupBusinessError(
      'Google Drive backup folder is not configured. Set GOOGLE_DRIVE_FOLDER_ID in Vercel.'
    );
  }

  const accessToken = await getGoogleDriveAccessToken();
  const boundary = `jk_backup_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = Buffer.from(JSON.stringify({
    name: fileName,
    parents: [folderId],
    description: 'JK Investment database backup'
  }), 'utf8');

  if (archive.length > 64 * 1024 * 1024) throw backupBusinessError('Cloud backup exceeds the safe upload size.');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
    archive,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,createdTime,size',
    {
      signal: AbortSignal.timeout(60000),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length)
      },
      body
    }
  );

  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw backupBusinessError(
        'Google Drive backup folder cannot be accessed. Check GOOGLE_DRIVE_FOLDER_ID and make sure the connected Google account can write to that folder.'
      );
    }

    throw backupBusinessError(
      'Google Drive rejected the backup upload. Check the Drive connection and try again.'
    );
  }

  return response.json();
}

async function executeCloudBackup(backupType, initiatedBy = null) {
  let runId = null;

  try {
    const started = await query(
      `
      INSERT INTO backup_runs(backup_type,status,storage_location,initiated_by)
      VALUES($1,'STARTED','GOOGLE_DRIVE',$2)
      RETURNING id
      `,
      [backupType, initiatedBy]
    );
    runId = started.rows[0].id;

    const { archive, checksum, fileName } = await createBackupArchive();
    const driveFile = await uploadBackupToGoogleDrive(archive, fileName);

    await query(
      `
      UPDATE backup_runs
      SET status='SUCCESS',
          checksum=$2,
          size_bytes=$3,
          completed_at=now()
      WHERE id=$1
      `,
      [runId, checksum, archive.length]
    );

    return {
      file: driveFile.name,
      file_id: driveFile.id,
      size_bytes: archive.length,
      checksum
    };
  } catch (error) {
    if (runId) {
      try {
        await query(
          `
          UPDATE backup_runs
          SET status='FAILED',
              error_message=$2,
              completed_at=now()
          WHERE id=$1
          `,
          [runId, String(error?.message || error).slice(0, 1000)]
        );
      } catch (historyError) {
        console.error('Failed to update cloud backup history', historyError);
      }
    }
    throw error;
  }
}

export async function cloudDailyBackupHandler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authorization = req.get('authorization') || '';
    const expected = cronSecret ? `Bearer ${cronSecret}` : '';

    if (!cronSecret || authorization.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
      return res.status(401).json({ ok: false, message: 'Unauthorized.' });
    }

    // Retain the existing database backup_type for compatibility; vercel.json controls the weekly schedule.
    const result = await executeCloudBackup('AUTO_DAILY');

    console.info('Automatic Google Drive backup completed', {
      fileId: result.file_id,
      fileName: result.file,
      size: result.size_bytes,
      checksum: result.checksum
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Automatic Google Drive backup failed', {
      message: error?.message
    });
    return res.status(500).json({
      ok: false,
      message: 'Automatic Google Drive backup failed.'
    });
  }
}

backupRouter.get('/cloud-daily', cloudDailyBackupHandler);

backupRouter.use(requireAuth);

backupRouter.get(
  '/config-status',
  requirePermission('BACKUP_MANAGE'),
  async (req, res, next) => {
    try {
      const environment = backupEnvironmentStatus();
      const latest = await query(`
        SELECT backup_type,status,storage_location,error_message,started_at,completed_at
        FROM backup_runs
        ORDER BY started_at DESC
        LIMIT 1
      `);

      res.json({
        ok: true,
        configured: Object.values(environment).every(Boolean),
        environment,
        schedule: {
          cadence: 'WEEKLY',
          day: 'Sunday',
          utc: '18:00',
          sri_lanka: '23:30'
        },
        latest_backup: latest.rows[0] || null
      });
    } catch (error) {
      next(error);
    }
  }
);

backupRouter.post(
  '/cloud-now',
  requirePermission('BACKUP_MANAGE'),
  async (req, res, next) => {
    try {
      const result = await executeCloudBackup('MANUAL', req.auth.user_id);
      res.json({
        ok: true,
        message: 'Google Drive backup completed successfully.',
        backup: result
      });
    } catch (error) {
      next(error);
    }
  }
);


backupRouter.get(
  '/download',
  requirePermission('BACKUP_MANAGE'),
  async (req, res, next) => {
    let runId = null;

    try {
      const started = await query(
        `
        INSERT INTO backup_runs(backup_type,status,storage_location,initiated_by)
        VALUES('MANUAL','STARTED','DOWNLOAD',$1)
        RETURNING id
        `,
        [req.auth.user_id]
      );
      runId = started.rows[0].id;

      const { archive, checksum, fileName } = await createBackupArchive();

      await query(
        `
        UPDATE backup_runs
        SET status='SUCCESS',
            checksum=$2,
            size_bytes=$3,
            completed_at=now()
        WHERE id=$1
        `,
        [runId, checksum, archive.length]
      );

      res.setHeader('Content-Type','application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`
      );
      res.setHeader('X-JK-Backup-SHA256', checksum);
      function* chunks() {
        for (let offset = 0; offset < archive.length; offset += 65536) {
          yield archive.subarray(offset, offset + 65536);
        }
      }
      await pipeline(Readable.from(chunks()), res);
    } catch (error) {
      if (runId) {
        try {
          await query(
            `
            UPDATE backup_runs
            SET status='FAILED',
                error_message=$2,
                completed_at=now()
            WHERE id=$1
            `,
            [runId, String(error?.message || error).slice(0,1000)]
          );
        } catch (historyError) {
          console.error('Failed to update backup history', historyError);
        }
      }
      next(error);
    }
  }
);

backupRouter.get(
  '/history',
  requirePermission('BACKUP_MANAGE'),
  async (req, res, next) => {
    try {
      const result = await query(`
        SELECT id,backup_type,status,storage_location,checksum,size_bytes,
               error_message,started_at,completed_at
        FROM backup_runs
        ORDER BY started_at DESC
        LIMIT 20
      `);

      res.json({ backups: result.rows });
    } catch (error) {
      next(error);
    }
  }
);
