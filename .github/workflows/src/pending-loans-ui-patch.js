import express from 'express';

const previousSend = express.response.send;

function patchFunction(body, startMarker, endMarker, transform) {
  const start = body.indexOf(startMarker);
  if (start === -1) return body;
  const end = body.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return body;
  const original = body.slice(start, end);
  const updated = transform(original);
  return body.slice(0, start) + updated + body.slice(end);
}

express.response.send = function pendingLoansUiPatch(body) {
  try {
    const requestPath = this.req?.path || this.req?.url || '';
    if (typeof body === 'string' && requestPath.startsWith('/app.js')) {
      body = patchFunction(
        body,
        'function renderLoans(){',
        '\nfunction loanTable',
        section => {
          let next = section;

          next = next.replace(
            "const pending=state.loans.filter(l=>String(l.lifecycle_status)==='PENDING');",
            "const pending=state.loans.filter(l=>String(l.lifecycle_status)==='PENDING');\n  const pendingTotal=pending.reduce((sum,l)=>sum+Number(l.principal||0),0);"
          );

          next = next.replace(
            '<div class="classic-loan-page">\n      <div class="classic-loan-toolbar">',
            '<div class="classic-loan-page">\n      <div class="classic-summary-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:16px">\n        <div class="classic-summary-card"><span>Pending Loans</span><strong>${pending.length}</strong></div>\n        <div class="classic-summary-card"><span>Pending Loan Total</span><strong>${money(pendingTotal)}</strong></div>\n      </div>\n      <div class="classic-loan-toolbar">'
          );

          return next;
        }
      );

      body = patchFunction(
        body,
        'function pendingLoanClassicTable(rows){',
        '\nfunction disbursedLoanClassicTable',
        section => section
          .replace(
            '<td><span class="customer-name">${esc(l.customer_name||\'-\')}</span></td>',
            '<td><span class="customer-name" style="font-weight:800;color:#0b1f33">${esc(l.customer_name||\'-\')}</span></td>'
          )
          .replace(
            '<td><span class="guarantor">${esc(classicLoanGuarantor(l))}</span></td>',
            '<td><span class="guarantor" style="font-weight:400;color:#425466">${esc(classicLoanGuarantor(l))}</span></td>'
          )
      );
    }
  } catch (_) {}

  return previousSend.call(this, body);
};
