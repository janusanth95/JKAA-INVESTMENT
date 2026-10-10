import express from 'express';
import PDFDocument from 'pdfkit';

import { query } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';

export const agreementPdfRouter = express.Router();
const AGREEMENT_LOGO = Buffer.from('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', 'base64');
agreementPdfRouter.use(requireAuth);

function money(value) {
  const n = Number(value || 0);
  return 'Rs.' + new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}

function rate(value) {
  return Number(value || 0).toFixed(2);
}

function agreementDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

function loanFrequencyWord(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'DAILY') return 'Daily';
  if (t === 'WEEKLY') return 'Weekly';
  if (t === 'MONTHLY') return 'Monthly';
  return 'Agreed';
}

function safeFilePart(value) {
  return String(value || 'LOAN').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
}

function drawHeader(doc, loan) {
  const left = 29.5;
  const right = 565.4;

  doc.image(AGREEMENT_LOGO, 34.7, 31.5, {
    width: 98,
    height: 48
  });

  doc.fillColor('#000000')
    .font('Times-Bold')
    .fontSize(13.8)
    .text('L O A N A G R E E M E N T', 150, 59.5, {
      width: 295,
      align: 'center'
    });

  doc.strokeColor('#4a4a4a').lineWidth(0.5)
    .moveTo(left, 97.2).lineTo(right, 97.2).stroke();
  doc.strokeColor('#b3b3b3').lineWidth(0.4)
    .moveTo(left, 99.0).lineTo(right, 99.0).stroke();

  const date = agreementDate(
    loan.disbursed_date || loan.created_date || loan.repayment_start_date
  );

  const columns = [
    { x: 29.5,  w: 118, label: 'LOAN AMOUNT', value: money(loan.principal) },
    { x: 153.5, w: 114, label: 'DATE', value: 'Date : ' + date },
    { x: 273.5, w: 130, label: 'CENTER', value: 'Center : ' + String(loan.center_name || '').toUpperCase() },
    { x: 409.5, w: 155, label: 'GROUP', value: 'Group : ' + String(loan.group_name || '').toUpperCase() }
  ];

  for (const item of columns) {
    doc.fillColor('#858585')
      .font('Helvetica')
      .fontSize(5.6)
      .text(item.label, item.x, 116.8, { width: item.w });

    doc.fillColor('#000000')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(item.value || '-', item.x, 127.3, {
        width: item.w,
        lineBreak: false
      });
  }

  doc.strokeColor('#9a9a9a').lineWidth(0.45)
    .moveTo(left, 139.0).lineTo(right, 139.0).stroke();
}

function legalCopy(loan, due) {
  const borrowerName = String(loan.customer_name || '').toUpperCase();
  const borrowerNic = String(loan.nic || '').toUpperCase();
  const amount = money(loan.principal);
  const total = money(loan.total_payable);
  const interestRate = rate(loan.interest_rate);
  const frequency = loanFrequencyWord(loan.loan_type);
  const date = agreementDate(
    loan.disbursed_date || loan.created_date || loan.repayment_start_date
  );

  const introPlain =
    `This indenture of loan made and entered by and between ${borrowerName} (${borrowerNic}) of one part hereinafter sometimes called and referred to as the "Debtor" and JK INVESTMENT COMPANY having its head office / conducting its principal business at JK INVESTMENT hereinafter sometimes called and referred to as the "Creditor" of the other part which terms or expressions as herein used shall where the context so requires or admits mean and include their heirs, executors, administrators and assigns of both parts.`;

  const strong =
    'And whereas the said debtor and creditor both hereby agree for their free written mutual covenant during the continuance of this loan subject to the following obligations on the part of the debtor and creditor to be observed and performed via :';

  const clauses = [
    `The debtor has made an application for a loan of ${amount} from the creditor and the creditor agreed to grant the said loan to the debtor. The debtor undertakes to utilize the proceeds of the loan for the sole purpose agreed with the creditor and has borrowed and received the loan of ${amount} of lawful money in Sri Lanka.`,
    `The debtor undertakes to repay the said loan to the creditor together with the interest accrued thereon at ${interestRate}% per centum as agreed by both parties. The total payable amount with interest is ${total}.`,
    `Debtor is required to repay the said loan in ${frequency} installment of ${money(due)}. However the creditor reserves the right to change this repayment programme or recall the loan at their sole discretion.`,
    `In the event of Debtor's failure to repay such installment on due dates, the Debtor agrees to settle overdue installments and outstanding balance on creditor request.`,
    `Debtor has issued a promissory note, bearing the date of this Indenture as a security to the creditor promising to pay in the aforesaid manner the sum of loan and interest accrued thereon as per or in connection with this indenture.`,
    `As such the debtor accepts that the creditor is entitled to recover the said loan together with interest accrued thereon as per the terms and condition of this indenture and the promissory note. Similarly in the event of recalling the total outstanding loan together with interest accrued thereon by the creditor, their receivers, successors or liquidators, the debtor agrees to repay such money at once even in the absence of any other voucher or a statement demanding such payment.`,
    `Furthermore within the definition of this indenture both parties agree that the promissory note tendered by the debtor as a security in respect of this indenture is deemed to be a part and parcel of this indenture therefore the creditor is entitled to file action against the debtor under summary procedure.`
  ];

  const closing =
    `Both parties hereto with their executors administrators receivers successors and assign bind themselves by the foregoing terms conditions and promises and undertaking in strict sense and set their hands to this indenture of loan on this ${date}`;

  return {
    borrowerName,
    borrowerNic,
    introPlain,
    strong,
    clauses,
    closing
  };
}

function measureLegal(doc, copy, size, width, lineGap) {
  const opts = { width, lineGap };

  let height = 0;
  doc.font('Times-Roman').fontSize(size);
  height += doc.heightOfString(copy.introPlain, opts) + 6;

  doc.font('Times-Bold').fontSize(size);
  height += doc.heightOfString(copy.strong, opts) + 4;

  doc.font('Times-Roman').fontSize(size);
  copy.clauses.forEach(text => {
    height += doc.heightOfString(text, {
      width: width - 18,
      lineGap
    }) + 1.3;
  });

  doc.font('Times-Bold').fontSize(size);
  height += doc.heightOfString(copy.closing, opts);

  return height;
}

function drawIntro(doc, copy, x, y, width, size, lineGap) {
  const normal = text => {
    doc.font('Times-Roman').fontSize(size).text(text, {
      continued: true
    });
  };
  const bold = text => {
    doc.font('Times-Bold').fontSize(size).text(text, {
      continued: true
    });
  };

  doc.fillColor('#111111')
    .font('Times-Roman')
    .fontSize(size)
    .text(
      'This indenture of loan made and entered by and between ',
      x,
      y,
      { width, lineGap, continued: true }
    );

  bold(copy.borrowerName);
  normal(` (${copy.borrowerNic}) of one part hereinafter sometimes called and referred to as the "Debtor" and `);
  bold('JK INVESTMENT COMPANY');
  normal(' having its head office / conducting its principal business at ');
  bold('JK INVESTMENT');

  doc.font('Times-Roman')
    .fontSize(size)
    .text(
      ' hereinafter sometimes called and referred to as the "Creditor" of the other part which terms or expressions as herein used shall where the context so requires or admits mean and include their heirs, executors, administrators and assigns of both parts.',
      { continued: false }
    );

  return doc.y;
}

function drawLegal(doc, loan, due) {
  const left = 29.5;
  const width = 535.9;
  const startY = 157.3;
  const maxBottom = 522.0;
  const copy = legalCopy(loan, due);

  let size = 8.55;
  let lineGap = 2.8;

  while (
    size > 7.45 &&
    measureLegal(doc, copy, size, width, lineGap) > (maxBottom - startY)
  ) {
    size -= 0.1;
    lineGap = Math.max(1.7, lineGap - 0.05);
  }

  let y = startY;

  y = drawIntro(doc, copy, left, y, width, size, lineGap) + 6;

  doc.fillColor('#111111')
    .font('Times-Bold')
    .fontSize(size)
    .text(copy.strong, left, y, {
      width,
      lineGap
    });
  y = doc.y + 3.5;

  copy.clauses.forEach((text, index) => {
    doc.fillColor('#111111')
      .font('Times-Roman')
      .fontSize(size)
      .text(`${index + 1}.`, left + 4, y, {
        width: 12,
        lineGap
      });

    doc.fillColor('#111111')
      .font('Times-Roman')
      .fontSize(size)
      .text(text, left + 18, y, {
        width: width - 18,
        lineGap
      });

    y = doc.y + 1.1;
  });

  doc.fillColor('#111111')
    .font('Times-Bold')
    .fontSize(size)
    .text(copy.closing, left, y, {
      width,
      lineGap
    });

  return doc.y;
}

function fittedFontSize(doc, text, font, preferred, maxWidth, minimum = 6.4) {
  let size = preferred;
  doc.font(font).fontSize(size);
  while (size > minimum && doc.widthOfString(text) > maxWidth) {
    size -= 0.15;
    doc.fontSize(size);
  }
  return size;
}

function drawSignatureBlock(doc, x, y, width, role, name, nic, stamp = false) {
  doc.fillColor('#000000')
    .font('Helvetica-Bold')
    .fontSize(8.2)
    .text(role.toUpperCase(), x, y, {
      width,
      characterSpacing: 1.55,
      lineBreak: false
    });

  const cleanName = String(name || '').toUpperCase();
  const cleanNic = String(nic || '').toUpperCase();
  const identity = cleanName
    ? `${cleanName}${cleanNic ? ` (${cleanNic})` : ''}`
    : '';

  if (identity) {
    const nameSize = fittedFontSize(
      doc,
      identity,
      'Helvetica',
      8.3,
      width,
      6.6
    );

    doc.fillColor('#111111')
      .font('Helvetica')
      .fontSize(nameSize)
      .text(identity, x, y + 17.5, {
        width,
        lineBreak: false
      });
  }

  const lineY = y + 58.5;
  doc.strokeColor('#111111').lineWidth(0.55)
    .moveTo(x, lineY).lineTo(x + 67, lineY).stroke();

  doc.fillColor('#333333')
    .font('Helvetica')
    .fontSize(6.4)
    .text(stamp ? 'Stamp' : 'Signature', x, lineY + 6, {
      width: 95
    });
}

function drawSignatures(doc, loan, selected) {
  const dividerY = 534.5;
  const left = 29.5;
  const right = 326.5;
  const width = 238;

  doc.strokeColor('#8d8d8d').lineWidth(0.45)
    .moveTo(29.5, dividerY).lineTo(565.4, dividerY).stroke();

  drawSignatureBlock(
    doc,
    left,
    558,
    width,
    'CUSTOMER',
    loan.customer_name,
    loan.nic,
    true
  );

  drawSignatureBlock(
    doc,
    right,
    558,
    width,
    'LOAN GUARANTOR',
    loan.loan_guarantor_name,
    loan.loan_guarantor_nic,
    false
  );

  drawSignatureBlock(
    doc,
    left,
    668,
    width,
    'GUARANTOR',
    selected[0]?.customer_name || '',
    selected[0]?.nic || '',
    false
  );

  drawSignatureBlock(
    doc,
    right,
    668,
    width,
    'GUARANTOR',
    selected[1]?.customer_name || '',
    selected[1]?.nic || '',
    false
  );

  doc.fillColor('#777777')
    .font('Times-Italic')
    .fontSize(5.3)
    .text('JK INVESTMENT - Loan Agreement', 29.5, 823.2, {
      width: 535.9,
      align: 'center'
    });
}

agreementPdfRouter.get(
  '/:id',
  requirePermission('LOAN_VIEW'),
  async (req, res, next) => {
    try {
      const loanResult = await query(
        `
        SELECT
          l.id AS loan_id,
          l.loan_code,
          l.customer_id,
          l.group_id,
          l.principal,
          l.interest_rate,
          l.loan_type,
          l.installment_count,
          l.repayment_start_date,
          l.disbursed_date,
          l.created_at::date AS created_date,
          COALESCE(vf.total_payable,l.total_payable,l.principal) AS total_payable,
          c.customer_name,
          c.nic,
          c.default_guarantor_name,
          c.default_guarantor_nic,
          c.default_guarantor_mobile,
          COALESCE((
            SELECT lg.guarantor_name
            FROM loan_guarantors lg
            WHERE lg.loan_id=l.id
            ORDER BY lg.guarantor_order
            LIMIT 1
          ),c.default_guarantor_name) AS loan_guarantor_name,
          COALESCE((
            SELECT lg.nic
            FROM loan_guarantors lg
            WHERE lg.loan_id=l.id
            ORDER BY lg.guarantor_order
            LIMIT 1
          ),c.default_guarantor_nic) AS loan_guarantor_nic,
          ce.center_name,
          g.group_name,
          COALESCE((
            SELECT s.due_amount
            FROM loan_schedule s
            WHERE s.loan_id=l.id
            ORDER BY s.installment_no
            LIMIT 1
          ),0) AS due_amount
        FROM loans l
        LEFT JOIN v_loan_financials vf ON vf.loan_id=l.id
        JOIN customers c ON c.id=l.customer_id
        JOIN centers ce ON ce.id=l.center_id
        JOIN groups g ON g.id=l.group_id
        WHERE l.id=$1::uuid
        LIMIT 1
        `,
        [req.params.id]
      );

      if (loanResult.rowCount !== 1) {
        return res.status(404).json({ error: 'LOAN_NOT_FOUND' });
      }

      const loan = loanResult.rows[0];
      const ids = [req.query.g1, req.query.g2]
        .map(x => String(x || '').trim())
        .filter(Boolean);

      if (ids.length === 2 && ids[0] === ids[1]) {
        return res.status(400).json({ error: 'SELECT_TWO_DIFFERENT_GUARANTORS' });
      }

      let selected = [];
      if (ids.length) {
        const params = [loan.group_id, loan.customer_id, ...ids];
        const placeholders = ids.map((_, i) => `$${i + 3}`).join(',');
        const members = await query(
          `
          SELECT id,customer_name,nic,mobile
          FROM customers
          WHERE group_id=$1
            AND id<>$2
            AND status='ACTIVE'
            AND id IN (${placeholders})
          `,
          params
        );

        const byId = new Map(members.rows.map(row => [String(row.id), row]));
        selected = ids.map(id => byId.get(id)).filter(Boolean);

        if (selected.length !== ids.length) {
          return res.status(400).json({ error: 'INVALID_GROUP_GUARANTOR' });
        }
      }

      while (selected.length < 2) {
        selected.push({ customer_name: '', nic: '', mobile: '' });
      }

      const filename = `${safeFilePart(loan.loan_code)}_Loan_Agreement.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        autoFirstPage: true,
        info: {
          Title: `Loan Agreement - ${loan.loan_code}`,
          Author: 'JK Investment'
        }
      });

      doc.pipe(res);
      drawHeader(doc, loan);
      drawLegal(doc, loan, Number(loan.due_amount || 0));
      drawSignatures(doc, loan, selected);
      doc.end();
    } catch (error) {
      next(error);
    }
  }
);
