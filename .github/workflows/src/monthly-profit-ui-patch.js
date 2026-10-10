import express from 'express';

const previousSend = express.response.send;

express.response.send = function monthlyProfitUiPatch(body) {
  try {
    const requestPath = this.req?.path || this.req?.url || '';
    if (typeof body === 'string' && requestPath.startsWith('/app.js')) {
      body = body.replace(
        '<div class="profit-metrics"><span>Interest Income <b>${money(d.month_interest_income)}</b></span><span>Expenses <b>${money(d.month_expenses)}</b></span><span>Net Profit <b>${money(d.month_net_profit)}</b></span></div>',
        '<div class="profit-metrics"><span>Interest Income <b>${money(d.month_interest_income)}</b></span><span>Charges Income <b>${money(d.month_charge_income)}</b></span><span>Expenses <b>${money(d.month_expenses)}</b></span><span>Salary Paid <b>${money(d.month_salary_paid||0)}</b></span><span>Net Profit <b>${money(d.month_net_profit)}</b></span></div>'
      );
    }
  } catch (_) {}

  return previousSend.call(this, body);
};
