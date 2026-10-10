import express from 'express';
import PDFDocument from 'pdfkit';

import { query } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';

export const reportsRouter = express.Router();
reportsRouter.use(requireAuth);
reportsRouter.use(requirePermission('REPORT_VIEW'));

reportsRouter.get('/print.js', (req, res) => {
  res.type('application/javascript').send(
    "document.getElementById('printBtn')?.addEventListener('click',()=>window.print());"
  );
});

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(value) {
  const n = Number(value || 0);
  return `Rs. ${new Intl.NumberFormat('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n)}`;
}

function reportShell({ title, subtitle = '', body, landscape = false }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:9mm}
*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0;background:#fff;font-size:12px}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
.brand{font-size:22px;font-weight:900}.muted{color:#666}.right{text-align:right}.title{font-size:18px;font-weight:900;margin:0 0 3px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:10px 0}.box{border:1px solid #bbb;padding:8px;border-radius:5px}.box span{display:block;font-size:10px;color:#666}.box strong{display:block;margin-top:3px;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:9px}th,td{border:1px solid #aaa;padding:6px;text-align:left;vertical-align:top}th{background:#f1f1f1;font-size:10px;text-transform:uppercase}.num{text-align:right;font-weight:700}.center{text-align:center}.name{font-weight:800}.sign{height:45px}.blank-col{width:72px;height:30px}
.repayment-sheet{table-layout:fixed}.repayment-sheet col.col-no{width:2.5%}.repayment-sheet col.col-customer{width:20%}.repayment-sheet col.col-loan{width:6.5%}.repayment-sheet col.col-money{width:9.5%}.repayment-sheet col.col-write{width:10.625%}.repayment-sheet tbody td{height:42px;vertical-align:middle}.repayment-sheet .num{font-size:10.5px;white-space:nowrap;padding-left:3px;padding-right:3px}.repayment-sheet .blank-col{padding:4px}.repayment-sheet thead .blank-col{height:30px;background:#fff}.repayment-sheet tfoot td{height:46px;vertical-align:middle;border-top:2px solid #000;border-bottom:3px solid #000;font-weight:900;color:#000}.repayment-sheet .total-label{text-align:center;font-size:12px;letter-spacing:.4px}
.printbar{position:fixed;right:14px;top:14px;z-index:3}.printbar button{padding:9px 14px;border:0;border-radius:6px;background:#111;color:#fff;font-weight:700;cursor:pointer}
@media print{.printbar{display:none}.no-print{display:none}}
</style>
</head>
<body>
<div class="printbar"><button id="printBtn">Print / Save PDF</button></div>
<div class="top"><div><div class="brand">JK INVESTMENT</div><div class="muted">Secure Loan Management System</div></div><div class="right"><div class="title">${esc(title)}</div><div class="muted">${esc(subtitle)}</div></div></div>
${body}
<script src="/api/reports/print.js" defer></script>
</body></html>`;
}

reportsRouter.get('/customer-statement/:customerId', async (req, res, next) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;

    const customer = await query(
      `
      SELECT c.*,ce.center_name,g.group_name,
             COALESCE(cf.total_loan_payable,0) AS total_loan_payable,
             COALESCE(cf.total_paid,0) AS total_paid,
             COALESCE(cf.total_balance,0) AS total_balance,
             COALESCE(cf.total_arrears,0) AS total_arrears,
             COALESCE(cf.total_advance,0) AS total_advance
      FROM customers c
      JOIN centers ce ON ce.id=c.center_id
      JOIN groups g ON g.id=c.group_id
      LEFT JOIN v_customer_financials cf ON cf.customer_id=c.id
      WHERE c.id=$1
      `,
      [req.params.customerId]
    );

    if (customer.rowCount !== 1) {
      return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND' });
    }

    const loans = await query(
      `
      SELECT vf.*,l.loan_type,l.installment_count,l.disbursed_date
      FROM v_loan_financials vf
      JOIN loans l ON l.id=vf.loan_id
      WHERE vf.customer_id=$1
      ORDER BY l.created_at DESC
      `,
      [req.params.customerId]
    );

    const payments = await query(
      `
      SELECT p.*,l.loan_code
      FROM payments p
      JOIN loans l ON l.id=p.loan_id
      WHERE p.customer_id=$1
        AND ($2::date IS NULL OR p.payment_date >= $2::date)
        AND ($3::date IS NULL OR p.payment_date <= $3::date)
      ORDER BY p.payment_date DESC,p.created_at DESC
      `,
      [req.params.customerId, from, to]
    );

    res.json({ customer: customer.rows[0], loans: loans.rows, payments: payments.rows, filters: { from, to } });
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/closed-loans', async (req, res, next) => {
  try {
    const centerId = req.query.center_id || null;
    const result = await query(
      `
      SELECT vf.*,c.customer_code,c.customer_name,c.mobile,ce.center_name,g.group_name,
             l.loan_type,l.installment_count,l.disbursed_date
      FROM v_loan_financials vf
      JOIN loans l ON l.id=vf.loan_id
      JOIN customers c ON c.id=vf.customer_id
      JOIN centers ce ON ce.id=vf.center_id
      JOIN groups g ON g.id=vf.group_id
      WHERE vf.operational_status='CLOSED'
        AND ($1::uuid IS NULL OR vf.center_id=$1)
      ORDER BY l.disbursed_date DESC,l.created_at DESC
      `,
      [centerId]
    );
    res.json({ loans: result.rows });
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/center-collection', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'VALID_DATE_REQUIRED' });
    }

    const entries = await query(
      `
      SELECT p.id,p.receipt_no,p.payment_date,p.amount,p.payment_method,p.status,
             c.customer_code,c.customer_name,c.mobile,l.loan_code,ce.center_name,g.group_name
      FROM payments p
      JOIN customers c ON c.id=p.customer_id
      JOIN loans l ON l.id=p.loan_id
      JOIN centers ce ON ce.id=p.center_id
      JOIN groups g ON g.id=l.group_id
      WHERE p.payment_date=$1::date
        AND p.status='POSTED'
        AND ($2::uuid IS NULL OR p.center_id=$2)
      ORDER BY ce.center_name,g.group_name,c.customer_name,p.created_at
      `,
      [date, centerId]
    );

    const total = entries.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    res.json({ date, total: total.toFixed(2), entries: entries.rows });
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/not-paid', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'VALID_DATE_REQUIRED' });
    }

    const result = await query(
      `
      SELECT DISTINCT
        l.center_id,l.group_id,l.customer_id,c.customer_code,c.customer_name,c.mobile,
        l.id AS loan_id,l.loan_code,s.due_amount,ce.center_name,g.group_name,
        vf.balance,vf.arrears,vf.advance
      FROM loan_schedule s
      JOIN loans l ON l.id=s.loan_id
      JOIN customers c ON c.id=l.customer_id
      JOIN centers ce ON ce.id=l.center_id
      JOIN groups g ON g.id=l.group_id
      JOIN v_loan_financials vf ON vf.loan_id=l.id
      WHERE s.due_date=$1::date
        AND l.lifecycle_status='DISBURSED'
        AND ($2::uuid IS NULL OR l.center_id=$2)
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.loan_id=l.id
            AND p.payment_date=$1::date
            AND p.status='POSTED'
        )
      ORDER BY ce.center_name,g.group_name,c.customer_name
      `,
      [date, centerId]
    );

    res.json({ date, customers: result.rows });
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/repayment-sheet', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'VALID_DATE_REQUIRED' });
    }

    const result = await query(
      `
      SELECT
        ce.center_name,g.group_name,c.customer_code,c.customer_name,c.mobile,
        l.id AS loan_id,l.loan_code,
        COALESCE(s.installment_no,1) AS installment_no,
        COALESCE(
          s.due_amount,
          round(vf.total_payable / NULLIF(l.installment_count,0),2),
          0
        ) AS due_amount,
        vf.total_paid,vf.balance,vf.arrears,vf.advance
      FROM loans l
      JOIN customers c ON c.id=l.customer_id
      JOIN centers ce ON ce.id=l.center_id
      JOIN groups g ON g.id=c.group_id
      JOIN v_loan_financials vf ON vf.loan_id=l.id
      LEFT JOIN LATERAL (
        SELECT installment_no,due_amount
        FROM loan_schedule
        WHERE loan_id=l.id
        ORDER BY installment_no
        LIMIT 1
      ) s ON true
      WHERE l.lifecycle_status='DISBURSED'
        AND vf.balance > 0
        AND ($1::uuid IS NULL OR l.center_id=$1)
      ORDER BY ce.center_name,g.group_name,c.customer_name
      `,
      [centerId]
    );

    res.json({ date, rows: result.rows });
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/print/customer-statement/:customerId', async (req, res, next) => {
  try {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const cR = await query(
      `
      SELECT c.*,ce.center_name,g.group_name,
             COALESCE(cf.total_loan_payable,0) AS total_loan_payable,
             COALESCE(cf.total_paid,0) AS total_paid,
             COALESCE(cf.total_balance,0) AS total_balance,
             COALESCE(cf.total_arrears,0) AS total_arrears,
             COALESCE(cf.total_advance,0) AS total_advance
      FROM customers c
      JOIN centers ce ON ce.id=c.center_id
      JOIN groups g ON g.id=c.group_id
      LEFT JOIN v_customer_financials cf ON cf.customer_id=c.id
      WHERE c.id=$1
      `,
      [req.params.customerId]
    );
    if (cR.rowCount !== 1) return res.status(404).send('Customer not found');
    const c = cR.rows[0];

    const pR = await query(
      `
      SELECT p.*,l.loan_code
      FROM payments p JOIN loans l ON l.id=p.loan_id
      WHERE p.customer_id=$1
        AND ($2::date IS NULL OR p.payment_date >= $2::date)
        AND ($3::date IS NULL OR p.payment_date <= $3::date)
      ORDER BY p.payment_date,p.created_at
      `,
      [req.params.customerId, from, to]
    );

    const body = `
      <div><strong>${esc(c.customer_name)}</strong> &nbsp; ${esc(c.customer_code)} &nbsp; NIC: ${esc(c.nic)} &nbsp; Mobile: ${esc(c.mobile || '-')}</div>
      <div class="muted">Center: ${esc(c.center_name)} · Group: ${esc(c.group_name)} · Period: ${esc(from || 'All')} to ${esc(to || 'All')}</div>
      <div class="summary">
        <div class="box"><span>Total Payable</span><strong>${money(c.total_loan_payable)}</strong></div>
        <div class="box"><span>Total Paid</span><strong>${money(c.total_paid)}</strong></div>
        <div class="box"><span>Balance</span><strong>${money(c.total_balance)}</strong></div>
        <div class="box"><span>Arrears / Advance</span><strong>${money(c.total_arrears)} / ${money(c.total_advance)}</strong></div>
      </div>
      <table><thead><tr><th>Date</th><th>Receipt</th><th>Loan</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead><tbody>
        ${pR.rows.map(p => `<tr><td>${esc(p.payment_date)}</td><td>${esc(p.receipt_no)}</td><td>${esc(p.loan_code)}</td><td>${esc(p.payment_method)}</td><td>${esc(p.status)}</td><td class="num">${money(p.amount)}</td></tr>`).join('') || '<tr><td colspan="6" class="center">No payment entries</td></tr>'}
      </tbody></table>`;

    res.type('html').send(reportShell({ title: 'Customer Statement', subtitle: c.customer_code, body }));
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/print/repayment-sheet', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'VALID_DATE_REQUIRED' });
    }

    const params = new URLSearchParams({ date });
    if (centerId) params.set('center_id', String(centerId));

    return res.redirect(
      302,
      '/api/reports/download/repayment-sheet?' + params.toString()
    );
  } catch (error) {
    next(error);
  }
});


reportsRouter.get('/download/repayment-sheet', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'VALID_DATE_REQUIRED' });
    }

    const result = await query(
      `
      SELECT ce.center_name,g.group_name,c.customer_name,c.mobile,
             l.loan_code,l.principal,
             COALESCE(s.due_amount,round(vf.total_payable / NULLIF(l.installment_count,0),2),0) AS due_amount,
             vf.balance,vf.arrears,vf.advance
      FROM loans l
      JOIN customers c ON c.id=l.customer_id
      JOIN centers ce ON ce.id=l.center_id
      JOIN groups g ON g.id=c.group_id
      JOIN v_loan_financials vf ON vf.loan_id=l.id
      LEFT JOIN LATERAL (
        SELECT due_amount
        FROM loan_schedule
        WHERE loan_id=l.id
        ORDER BY installment_no
        LIMIT 1
      ) s ON true
      WHERE l.lifecycle_status='DISBURSED'
        AND vf.balance > 0
        AND ($1::uuid IS NULL OR l.center_id=$1)
      ORDER BY ce.center_name,g.group_name,c.customer_name
      `,
      [centerId]
    );

    const rows = result.rows;
    const centerName = rows[0]?.center_name || 'All Centers';
    const safeCenterName = centerName.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'Center';
    const filename = 'JK_Repayment_' + safeCenterName + '_' + date + '.pdf';

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'private, no-store, max-age=0'
    });

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 0,
      bufferPages: true,
      autoFirstPage: true
    });
    doc.pipe(res);

    // Approved V8 repayment-sheet layout.
    const tableX = 35.141;
    const widths = [
      167.250, // Customer Name
      52.290,  // Mobile
      48.786,  // Loan Amt
      49.770,  // Balance
      40.422,  // Rental
      48.786,  // Arrears
      91.076,  // Writing box 1
      91.076,  // Writing box 2
      91.076,  // Writing box 3
      91.076   // Writing box 4
    ];
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const tableRight = tableX + tableWidth;
    const headerHeight = 33.054;
    const rowHeight = 13.0434;
    const totalHeight = 14.739;
    const fixedRows = 5;
    const groupTitleToTable = 27.307;
    const groupStride = 158.300;
    const firstPageGroupY = 102.100;
    const laterPageGroupY = 20.000;
    const lavender = '#d5d3f9';
    const ink = '#000000';

    const x = [tableX];
    for (const width of widths) x.push(x[x.length - 1] + width);

    function amount(value) {
      return new Intl.NumberFormat('en-LK', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(Number(value || 0));
    }

    function line(x1, y1, x2, y2, width = 0.75) {
      doc.moveTo(x1, y1)
        .lineTo(x2, y2)
        .lineWidth(width)
        .strokeColor('#111111')
        .stroke();
    }

    function text(value, tx, ty, width, options = {}) {
      const stringValue = String(value ?? '');
      const fontName = options.bold ? 'Helvetica-Bold' : (options.font || 'Helvetica');
      let fontSize = options.size || 9;
      const align = options.align || 'left';
      const characterSpacing = options.characterSpacing || 0;

      doc.font(fontName).fontSize(fontSize).fillColor(ink);

      // PDFKit wraps a value when its measured width is only a fraction wider
      // than the supplied box. V8 preview used absolute single-line placement,
      // so reproduce that behavior for all approved non-wrapping text.
      if (options.lineBreak === false) {
        const minSize = options.minSize || 7.5;
        let measured = doc.widthOfString(stringValue, { characterSpacing });

        while (measured > width && fontSize > minSize) {
          fontSize = Math.max(minSize, fontSize - 0.1);
          doc.fontSize(fontSize);
          measured = doc.widthOfString(stringValue, { characterSpacing });
        }

        let drawX = tx;
        if (align === 'right') drawX = tx + width - measured;
        if (align === 'center') drawX = tx + ((width - measured) / 2);

        doc.text(stringValue, drawX, ty, {
          lineBreak: false,
          characterSpacing
        });
        return;
      }

      doc.text(stringValue, tx, ty, {
        width,
        align,
        lineBreak: true,
        ellipsis: options.ellipsis === true,
        characterSpacing
      });
    }

    function drawDocumentHeader() {
      text('JK Investment Repayment Sheet', tableX, 45.5, tableWidth, {
        bold: true,
        size: 18,
        align: 'center',
        lineBreak: false
      });

      doc.font('Times-Bold').fontSize(12).fillColor(ink)
        .text('Branch : JK INVESTMENT', 37.016, 73.2, {
          width: 230,
          lineBreak: false
        });
      doc.text('Loan Officer :', 304.938, 73.2, {
        width: 190,
        lineBreak: false
      });
      doc.text('Center Name : ' + centerName.toUpperCase(), 622.582, 73.2, {
        width: tableRight - 622.582,
        align: 'right',
        lineBreak: false
      });
    }

    function drawGroup(groupName, groupRows, titleY, continued = false) {
      text(
        'Group Name : ' + String(groupName || '').toUpperCase() + (continued ? ' (CONTINUED)' : ''),
        tableX,
        titleY + 3.0,
        tableWidth,
        { size: 12, lineBreak: false, ellipsis: true }
      );

      const tableY = titleY + groupTitleToTable;
      const headerBottom = tableY + headerHeight;
      const totalTop = headerBottom + (fixedRows * rowHeight);
      const tableBottom = totalTop + totalHeight;

      // Lavender header cells: first 6 data columns + four full writing boxes.
      for (let i = 0; i < widths.length; i += 1) {
        doc.rect(x[i], tableY, widths[i], headerHeight).fill(lavender);
      }

      // Horizontal grid lines.
      line(tableX, tableY, tableRight, tableY, 0.75);
      line(tableX, headerBottom, tableRight, headerBottom, 0.75);
      for (let r = 1; r <= fixedRows; r += 1) {
        line(tableX, headerBottom + (r * rowHeight), tableRight, headerBottom + (r * rowHeight), 0.75);
      }
      line(tableX, tableBottom, tableRight, tableBottom, 0.75);

      // Main vertical boundaries only. No inner divider inside the 4 writing boxes.
      for (const vx of x) {
        line(vx, tableY, vx, tableBottom, 0.75);
      }

      // Column headings - V8 approved 12 pt bold.
      text('Customer Name', x[0], tableY + 11.15, widths[0], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Mobile', x[1], tableY + 11.15, widths[1], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Loan', x[2], tableY + 3.85, widths[2], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Amt', x[2], tableY + 18.55, widths[2], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Balance', x[3], tableY + 11.15, widths[3], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Rental', x[4], tableY + 11.15, widths[4], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });
      text('Arrears', x[5], tableY + 11.15, widths[5], {
        bold: true, size: 12, align: 'center', lineBreak: false
      });

      const paddedRows = groupRows.slice();
      while (paddedRows.length < fixedRows) paddedRows.push(null);

      paddedRows.forEach((row, rowIndex) => {
        if (!row) return;
        const top = headerBottom + (rowIndex * rowHeight);
        const arrears = Number(row.arrears || 0) - Number(row.advance || 0);
        const values = [
          String(row.customer_name || '').toUpperCase(),
          String(row.mobile || ''),
          amount(row.principal),
          amount(row.balance),
          amount(row.due_amount),
          amount(arrears)
        ];

        text(values[0], x[0] + 1.125, top + 4.2, widths[0] - 2.25, {
          size: 9,
          lineBreak: false,
          ellipsis: true
        });
        text(values[1], x[1] + 1.125, top + 4.2, widths[1] - 2.25, {
          size: 9,
          lineBreak: false
        });

        for (let i = 2; i <= 5; i += 1) {
          text(values[i], x[i] + 1, top + 5.2, widths[i] - 4, {
            size: 9,
            align: 'right',
            lineBreak: false
          });
        }
      });

      // Total row - same V8 alignment and size.
      const totalPrincipal = groupRows.reduce((sum, row) => sum + Number(row.principal || 0), 0);
      const totalBalance = groupRows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
      const totalRental = groupRows.reduce((sum, row) => sum + Number(row.due_amount || 0), 0);
      const totalArrears = groupRows.reduce(
        (sum, row) => sum + Number(row.arrears || 0) - Number(row.advance || 0),
        0
      );

      text('Total', x[0], totalTop + 4.6, widths[0], {
        bold: true,
        size: 9,
        align: 'center',
        lineBreak: false
      });

      const totals = [
        [2, amount(totalPrincipal)],
        [3, amount(totalBalance)],
        [4, amount(totalRental)],
        [5, amount(totalArrears)]
      ];
      totals.forEach(([index, value]) => {
        text(value, x[index] + 1, totalTop + 4.6, widths[index] - 4, {
          bold: true,
          size: 9,
          align: 'right',
          lineBreak: false
        });
      });
    }

    function drawFooter() {
      const footerTop = 488.0;
      const footerYs = [488.0, 507.5, 527.0, 546.5, 566.0];

      // 1 label box + 4 boxes exactly aligned below the four upper writing boxes.
      const footerXs = [tableX, x[6], x[7], x[8], x[9], x[10]];

      for (const fy of footerYs) line(footerXs[0], fy, footerXs[5], fy, 0.75);
      for (const fx of footerXs) line(fx, footerTop, fx, footerYs[4], 0.75);

      text('Center Total', tableX, 492.75, x[6] - tableX - 5, {
        bold: true, size: 12, align: 'right', lineBreak: false
      });
      text('Collection Officer Signature', tableX, 512.25, x[6] - tableX - 5, {
        bold: true, size: 12, align: 'right', lineBreak: false
      });
      text('Account Assistant Signature', tableX, 531.75, x[6] - tableX - 5, {
        bold: true, size: 12, align: 'right', lineBreak: false
      });
      text('Manager Signature', tableX, 551.25, x[6] - tableX - 5, {
        bold: true, size: 12, align: 'right', lineBreak: false
      });
    }

    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.group_name || 'UNASSIGNED');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    const chunks = [];
    for (const [groupName, groupRows] of grouped.entries()) {
      for (let index = 0; index < groupRows.length; index += fixedRows) {
        chunks.push({
          groupName,
          rows: groupRows.slice(index, index + fixedRows),
          continued: index > 0
        });
      }
    }

    drawDocumentHeader();

    if (chunks.length === 0) {
      text('No active disbursed loans for this center', tableX, 145, tableWidth, {
        bold: true,
        size: 10,
        align: 'center',
        lineBreak: false
      });
      drawFooter();
    } else if (chunks.length <= 2) {
      chunks.forEach((chunk, index) => {
        drawGroup(chunk.groupName, chunk.rows, firstPageGroupY + (index * groupStride), chunk.continued);
      });
      drawFooter();
    } else if (chunks.length === 3) {
      // Keep the approved footer clear: two groups on the first page, the final group + footer on page 2.
      for (let index = 0; index < 2; index += 1) {
        const chunk = chunks[index];
        drawGroup(chunk.groupName, chunk.rows, firstPageGroupY + (index * groupStride), chunk.continued);
      }
      doc.addPage();
      const chunk = chunks[2];
      drawGroup(chunk.groupName, chunk.rows, laterPageGroupY, chunk.continued);
      drawFooter();
    } else {
      // First page includes the document header and up to three groups.
      let index = 0;
      for (; index < Math.min(3, chunks.length); index += 1) {
        const chunk = chunks[index];
        drawGroup(chunk.groupName, chunk.rows, firstPageGroupY + (index * groupStride), chunk.continued);
      }

      // Following pages fit three groups and still leave the approved footer area clear.
      while (index < chunks.length) {
        doc.addPage();
        const pageCount = Math.min(3, chunks.length - index);
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const chunk = chunks[index + pageIndex];
          drawGroup(chunk.groupName, chunk.rows, laterPageGroupY + (pageIndex * groupStride), chunk.continued);
        }
        index += pageCount;
        if (index >= chunks.length) drawFooter();
      }
    }

    doc.end();
  } catch (error) {
    next(error);
  }
});


reportsRouter.get('/print/closed-loans', async (req, res, next) => {
  try {
    const centerId = req.query.center_id || null;
    const rows = await query(
      `
      SELECT vf.*,c.customer_code,c.customer_name,c.mobile,ce.center_name,g.group_name,l.disbursed_date
      FROM v_loan_financials vf
      JOIN loans l ON l.id=vf.loan_id
      JOIN customers c ON c.id=vf.customer_id
      JOIN centers ce ON ce.id=vf.center_id
      JOIN groups g ON g.id=vf.group_id
      WHERE vf.operational_status='CLOSED'
        AND ($1::uuid IS NULL OR vf.center_id=$1)
      ORDER BY ce.center_name,l.disbursed_date DESC
      `,
      [centerId]
    );
    const body = `<table><thead><tr><th>#</th><th>Loan</th><th>Customer</th><th>Center / Group</th><th>Disbursed</th><th>Payable</th><th>Paid</th></tr></thead><tbody>${rows.rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.loan_code)}</td><td class="name">${esc(r.customer_name)}</td><td>${esc(r.center_name)} / ${esc(r.group_name)}</td><td>${esc(r.disbursed_date || '-')}</td><td class="num">${money(r.total_payable)}</td><td class="num">${money(r.total_paid)}</td></tr>`).join('') || '<tr><td colspan="7" class="center">No closed loans</td></tr>'}</tbody></table>`;
    res.type('html').send(reportShell({ title: 'Closed Loan Report', subtitle: `${rows.rowCount} loans`, body, landscape: true }));
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/print/loan-schedule/:loanId', async (req, res, next) => {
  try {
    const loanR = await query(
      `
      SELECT vf.*,l.loan_type,l.installment_count,l.disbursed_date,
             c.customer_code,c.customer_name,c.nic,c.mobile,
             ce.center_name,g.group_name
      FROM v_loan_financials vf
      JOIN loans l ON l.id=vf.loan_id
      JOIN customers c ON c.id=vf.customer_id
      JOIN centers ce ON ce.id=vf.center_id
      JOIN groups g ON g.id=vf.group_id
      WHERE vf.loan_id=$1
      `,
      [req.params.loanId]
    );
    if (loanR.rowCount !== 1) return res.status(404).send('Loan not found');
    const l = loanR.rows[0];
    const sR = await query(
      `SELECT * FROM v_schedule_status WHERE loan_id=$1 ORDER BY installment_no`,
      [req.params.loanId]
    );
    const body = `
      <div><strong>${esc(l.customer_name)}</strong> · ${esc(l.customer_code)} · ${esc(l.loan_code)} · ${esc(l.loan_type)}</div>
      <div class="muted">${esc(l.center_name)} / ${esc(l.group_name)} · NIC ${esc(l.nic)} · Mobile ${esc(l.mobile || '-')}</div>
      <div class="summary">
        <div class="box"><span>Total Payable</span><strong>${money(l.total_payable)}</strong></div>
        <div class="box"><span>Paid</span><strong>${money(l.total_paid)}</strong></div>
        <div class="box"><span>Balance</span><strong>${money(l.balance)}</strong></div>
        <div class="box"><span>Arrears / Advance</span><strong>${money(l.arrears)} / ${money(l.advance)}</strong></div>
      </div>
      <table><thead><tr><th>#</th><th>Due Date</th><th>Due Amount</th><th>Allocated</th><th>Remaining</th><th>Status</th></tr></thead><tbody>
      ${sR.rows.map(r=>`<tr><td>${esc(r.installment_no)}</td><td>${esc(r.due_date)}</td><td class="num">${money(r.due_amount)}</td><td class="num">${money(r.allocated_amount)}</td><td class="num">${money(r.remaining_amount)}</td><td>${esc(r.installment_status)}</td></tr>`).join('')}
      </tbody></table>`;
    res.type('html').send(reportShell({ title: 'Loan Repayment Schedule', subtitle: l.loan_code, body }));
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/print/receipt/:paymentId', async (req, res, next) => {
  try {
    const r = await query(
      `
      SELECT p.*,l.loan_code,c.customer_code,c.customer_name,c.nic,c.mobile,ce.center_name,g.group_name
      FROM payments p
      JOIN loans l ON l.id=p.loan_id
      JOIN customers c ON c.id=p.customer_id
      JOIN centers ce ON ce.id=p.center_id
      JOIN groups g ON g.id=l.group_id
      WHERE p.id=$1
      `,
      [req.params.paymentId]
    );
    if (r.rowCount !== 1) return res.status(404).send('Receipt not found');
    const p = r.rows[0];
    const body = `
      <div class="summary">
        <div class="box"><span>Receipt No</span><strong>${esc(p.receipt_no)}</strong></div>
        <div class="box"><span>Date</span><strong>${esc(p.payment_date)}</strong></div>
        <div class="box"><span>Loan</span><strong>${esc(p.loan_code)}</strong></div>
        <div class="box"><span>Amount</span><strong>${money(p.amount)}</strong></div>
      </div>
      <table><tbody>
        <tr><th>Customer</th><td class="name">${esc(p.customer_name)} (${esc(p.customer_code)})</td></tr>
        <tr><th>NIC / Mobile</th><td>${esc(p.nic)} / ${esc(p.mobile || '-')}</td></tr>
        <tr><th>Center / Group</th><td>${esc(p.center_name)} / ${esc(p.group_name)}</td></tr>
        <tr><th>Payment Method</th><td>${esc(p.payment_method)}</td></tr>
        <tr><th>Status</th><td>${esc(p.status)}</td></tr>
        <tr><th>Notes</th><td>${esc(p.notes || '-')}</td></tr>
      </tbody></table>
      <div style="margin-top:55px;display:flex;justify-content:space-between"><div>Customer Signature ____________________</div><div>Authorized Signature ____________________</div></div>`;
    res.type('html').send(reportShell({ title: 'Payment Receipt', subtitle: p.receipt_no, body }));
  } catch (error) {
    next(error);
  }
});

reportsRouter.get('/print/center-collection', async (req, res, next) => {
  try {
    const date = String(req.query.date || '');
    const centerId = req.query.center_id || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send('Valid date required');
    const r = await query(
      `
      SELECT p.receipt_no,p.amount,p.payment_method,c.customer_name,l.loan_code,ce.center_name,g.group_name
      FROM payments p
      JOIN customers c ON c.id=p.customer_id
      JOIN loans l ON l.id=p.loan_id
      JOIN centers ce ON ce.id=p.center_id
      JOIN groups g ON g.id=l.group_id
      WHERE p.payment_date=$1::date AND p.status='POSTED'
        AND ($2::uuid IS NULL OR p.center_id=$2)
      ORDER BY ce.center_name,g.group_name,c.customer_name,p.created_at
      `,
      [date, centerId]
    );
    const total = r.rows.reduce((sum,x)=>sum+Number(x.amount||0),0);
    const body = `<div><strong>Date:</strong> ${esc(date)} &nbsp; <strong>Total Collection:</strong> ${money(total)}</div>
      <table><thead><tr><th>#</th><th>Customer</th><th>Center / Group</th><th>Loan</th><th>Receipt</th><th>Method</th><th>Amount</th></tr></thead><tbody>
      ${r.rows.map((x,i)=>`<tr><td>${i+1}</td><td class="name">${esc(x.customer_name)}</td><td>${esc(x.center_name)} / ${esc(x.group_name)}</td><td>${esc(x.loan_code)}</td><td>${esc(x.receipt_no)}</td><td>${esc(x.payment_method)}</td><td class="num">${money(x.amount)}</td></tr>`).join('') || '<tr><td colspan="7" class="center">No collections</td></tr>'}
      </tbody></table>`;
    res.type('html').send(reportShell({ title: 'Centerwise Collection Report', subtitle: date, body, landscape: true }));
  } catch (error) {
    next(error);
  }
});
