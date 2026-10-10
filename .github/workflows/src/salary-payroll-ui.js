export const salaryPayrollUiJs = String.raw`
(function () {
  function currentSalaryMonthV2() {
    return today().slice(0, 7);
  }

  function salaryMonthEndV2(month) {
    const parts = String(month).split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1], 0)).toISOString().slice(0, 10);
  }

  function salaryMonthLabelV3(month) {
    const parts = String(month || '').split('-').map(Number);
    if (!parts[0] || !parts[1]) return String(month || '');
    return new Date(Date.UTC(parts[0], parts[1] - 1, 1)).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  function salaryStatusBadgeV2(value) {
    const status = String(value || 'UPCOMING');
    return '<span class="badge ' + esc(status.toLowerCase()) + '">' + esc(status.replaceAll('_', ' ')) + '</span>';
  }

  loadSalaryAdvance = async function (month) {
    const selectedMonth = month || currentSalaryMonthV2();
    content.innerHTML = '<div class="loading-card">Loading Salary & Advance...</div>';
    try {
      const results = await Promise.all([
        api('/api/salary-advance?month=' + encodeURIComponent(selectedMonth)),
        api('/api/finance/summary')
      ]);
      state.salaryAdvance = results[0];
      state.financeSummary = results[1].summary || {};
      renderSalaryAdvance();
    } catch (error) {
      content.innerHTML = '<div class="alert error">' + esc(error.message) + '</div>';
    }
  };

  renderSalaryAdvance = function () {
    const data = state.salaryAdvance || {};
    const summary = data.summary || {};
    const advances = data.advances || [];
    const payments = data.payments || [];
    const selectedMonth = String(summary.salary_month || today()).slice(0, 7);
    const currentMonth = currentSalaryMonthV2();
    const advanceDate = selectedMonth === currentMonth ? today() : salaryMonthEndV2(selectedMonth);
    const paymentDate = selectedMonth === currentMonth ? today() : salaryMonthEndV2(selectedMonth);
    const payable = Number(summary.total_payable || 0);
    const currentBalance = Number(summary.salary_balance || 0);
    const previousBalance = Number(summary.previous_balance || 0);
    const currentSalary = Number(summary.current_month_salary || summary.salary_limit || 0);
    const advanceTaken = Number(summary.advance_taken || 0);
    const salaryPaid = Number(summary.salary_paid || 0);
    const totalSalaryBalance = Math.max(0, previousBalance + currentBalance - salaryPaid);
    const monthLabel = salaryMonthLabelV3(selectedMonth);
    const dueText = summary.due_released
      ? 'Salary due released on ' + dateOnly(summary.salary_due_date) + '.'
      : 'Current salary becomes payable on ' + dateOnly(summary.salary_due_date) + '. Previous unpaid salary can still be paid now.';

    const advanceRows = advances.length ? advances.map(function (row) {
      return '<tr>' +
        '<td><strong>' + esc(row.advance_no) + '</strong></td>' +
        '<td>' + dateOnly(row.advance_date) + '</td>' +
        '<td class="money">' + money(row.amount) + '</td>' +
        '<td>' + esc(row.payment_method) + '</td>' +
        '<td>' + esc(row.notes || '-') + '</td>' +
        '<td>' + badge(row.status) + '</td>' +
        '<td>' + esc(row.entered_by_name || '-') + '</td>' +
        '<td>' + (row.status === 'POSTED'
          ? '<button class="icon-btn danger-icon salary-void" data-id="' + esc(row.id) + '" title="Void" aria-label="Void">' + actionIcon('void') + '</button>'
          : '') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="8" class="empty">No Salary Advance entries for this month.</td></tr>';

    const paymentRows = payments.length ? payments.map(function (row) {
      return '<tr>' +
        '<td><strong>' + esc(row.payment_no) + '</strong></td>' +
        '<td>' + dateOnly(row.payment_date) + '</td>' +
        '<td class="money">' + money(row.amount) + '</td>' +
        '<td>' + esc(row.payment_method) + '</td>' +
        '<td>' + esc(row.notes || '-') + '</td>' +
        '<td>' + badge(row.status) + '</td>' +
        '<td>' + esc(row.entered_by_name || '-') + '</td>' +
        '<td>' + (row.status === 'POSTED'
          ? '<button class="icon-btn danger-icon salary-payment-void" data-id="' + esc(row.id) + '" title="Void" aria-label="Void">' + actionIcon('void') + '</button>'
          : '') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="8" class="empty">No Salary Payment entries for this month.</td></tr>';

    content.innerHTML =
      '<style>' +
        '.salary-clarity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:14px}' +
        '.salary-clarity-card{background:#fff;border:1px solid #dfe7ee;border-radius:16px;padding:18px;box-shadow:0 7px 22px rgba(15,23,42,.05)}' +
        '.salary-clarity-card span{display:block;color:#64748b;font-size:12px;font-weight:800;margin-bottom:8px}' +
        '.salary-clarity-card strong{display:block;color:#0f172a;font-size:24px;line-height:1.1}' +
        '.salary-clarity-card.previous{background:#f4f8ff;border-color:#d9e7ff}' +
        '.salary-clarity-card.salary{background:#f2fbf7;border-color:#d6efe4}' +
        '.salary-clarity-card.advance{background:#fff7ef;border-color:#f7dfc6}' +
        '.salary-clarity-card.balance{background:#f8f3ff;border-color:#e7d8ff}' +
        '.salary-total-card{display:grid;grid-template-columns:1.25fr 1fr;gap:18px;align-items:center;background:linear-gradient(135deg,#eefbf5,#f8fffb);border:1px solid #cfeadc;border-radius:18px;padding:20px;margin-bottom:16px}' +
        '.salary-total-card .main span{display:block;color:#167052;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}' +
        '.salary-total-card .main strong{display:block;font-size:28px;color:#075b3e;margin-top:5px}' +
        '.salary-total-equation{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:10px}' +
        '.salary-total-equation div{min-width:0}' +
        '.salary-total-equation span{display:block;color:#64748b;font-size:11px;font-weight:700}' +
        '.salary-total-equation strong{display:block;color:#0f172a;margin-top:4px;font-size:15px}' +
        '.salary-total-equation b{font-size:23px;color:#0d7a55}' +
        '.salary-due-strip{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e1e8ee;border-radius:16px;padding:14px 16px;margin-bottom:18px}' +
        '.salary-due-strip .left{display:flex;gap:10px;align-items:center;flex-wrap:wrap}' +
        '.salary-due-strip .payable-now{font-weight:900;color:#0f172a}' +
        '.salary-details-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.75fr);gap:18px;margin-top:18px}' +
        '.salary-breakdown{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}' +
        '.salary-breakdown td{padding:12px;border-bottom:1px solid #edf1f4}' +
        '.salary-breakdown td:last-child{text-align:right;font-weight:900}' +
        '.salary-breakdown .minus td:last-child{color:#dc2626}' +
        '.salary-breakdown .balance-row{background:#effaf5}' +
        '.salary-breakdown .balance-row td{font-weight:900;color:#087449}' +
        '.salary-breakdown .total-row{background:#fff8db}' +
        '.salary-breakdown .total-row td{font-size:16px;font-weight:900;color:#7a5600}' +
        '.salary-subtitle{color:#64748b;font-size:13px;margin:0 0 12px}' +
        '@media(max-width:900px){.salary-clarity-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.salary-total-card{grid-template-columns:1fr}.salary-details-grid{grid-template-columns:1fr}}' +
        '@media(max-width:560px){.salary-clarity-grid{grid-template-columns:1fr}.salary-total-equation{grid-template-columns:1fr}.salary-total-equation b{display:none}}' +
      '</style>' +

      '<div class="salary-clarity-grid">' +
        '<div class="salary-clarity-card previous"><span>Previous Unpaid Balance</span><strong>' + money(previousBalance) + '</strong></div>' +
        '<div class="salary-clarity-card salary"><span>Salary for ' + esc(monthLabel) + '</span><strong>' + money(currentSalary) + '</strong></div>' +
        '<div class="salary-clarity-card advance"><span>Advance Taken in ' + esc(monthLabel) + '</span><strong>' + money(advanceTaken) + '</strong></div>' +
        '<div class="salary-clarity-card balance"><span>Balance Salary (After Advance)</span><strong>' + money(currentBalance) + '</strong></div>' +
      '</div>' +

      '<div class="salary-total-card">' +
        '<div class="main"><span>Total Salary Balance · Carry Forward + This Month</span><strong>' + money(totalSalaryBalance) + '</strong></div>' +
        '<div class="salary-total-equation">' +
          '<div><span>Previous Balance</span><strong>' + money(previousBalance) + '</strong></div>' +
          '<b>+</b>' +
          '<div><span>This Month Balance</span><strong>' + money(currentBalance) + '</strong></div>' +
          '<b>=</b>' +
          '<div><span>Total Salary Balance</span><strong>' + money(totalSalaryBalance) + '</strong></div>' +
        '</div>' +
      '</div>' +

      '<div class="salary-due-strip">' +
        '<div class="left">' +
          '<label style="margin:0;font-weight:800">Salary Month</label>' +
          '<input id="salaryMonth" type="month" value="' + esc(selectedMonth) + '" max="' + esc(currentMonth) + '">' +
          '<span class="badge">Salary Date: 25th</span>' +
          salaryStatusBadgeV2(summary.payment_status) +
        '</div>' +
        '<div class="payable-now">Payable Now: ' + money(payable) + '</div>' +
        '<div class="mini-note" style="flex-basis:100%;margin:0">' + esc(dueText) + '</div>' +
      '</div>' +

      '<div class="salary-details-grid">' +
        '<div class="card">' +
          '<div class="card-head"><h2>Salary Calculation · ' + esc(monthLabel) + '</h2></div>' +
          '<p class="salary-subtitle">Easy breakdown of this month salary and the carried-forward balance.</p>' +
          '<table class="salary-breakdown"><tbody>' +
            '<tr><td>Monthly Salary (This Month)</td><td>' + money(currentSalary) + '</td></tr>' +
            '<tr class="minus"><td>Advance Taken (This Month)</td><td>− ' + money(advanceTaken) + '</td></tr>' +
            '<tr class="balance-row"><td>Balance Salary (This Month)</td><td>= ' + money(currentBalance) + '</td></tr>' +
            '<tr><td>Previous Unpaid Balance</td><td>' + money(previousBalance) + '</td></tr>' +
            (salaryPaid > 0 ? '<tr class="minus"><td>Salary Paid in Selected Month</td><td>− ' + money(salaryPaid) + '</td></tr>' : '') +
            '<tr class="total-row"><td>Total Salary Balance</td><td>' + money(totalSalaryBalance) + '</td></tr>' +
          '</tbody></table>' +
          '<div class="alert ok" style="margin-top:14px">Payable Now is kept separate from Total Salary Balance. The current month balance becomes payable on the configured salary date.</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h2>Add Salary Advance</h2></div>' +
          '<form id="salaryAdvanceForm" class="form-grid">' +
            '<div><label>Date</label><input name="advance_date" type="date" value="' + esc(advanceDate) + '" min="' + esc(selectedMonth + '-01') + '" max="' + esc(selectedMonth === currentMonth ? today() : salaryMonthEndV2(selectedMonth)) + '" required></div>' +
            '<div><label>Amount</label><input name="amount" id="salaryAdvanceAmount" type="number" min="0.01" max="' + esc(currentBalance) + '" step="0.01" required></div>' +
            '<div><label>Method</label><select name="payment_method"><option>CASH</option><option>BANK</option><option>MOBILE</option><option>OTHER</option></select></div>' +
            '<div><label>Balance Salary After Advance</label><input id="salaryBalanceAfter" value="' + money(currentBalance) + '" disabled></div>' +
            '<div class="span2"><label>Notes</label><input name="notes" placeholder="Optional note"></div>' +
            '<div class="form-actions"><button class="primary-btn" ' + (currentBalance <= 0 ? 'disabled' : '') + '>Save Advance</button></div>' +
          '</form>' +
        '</div>' +
      '</div>' +

      '<div class="section-grid" style="margin-top:18px">' +
        '<div class="card">' +
          '<div class="card-head"><h2>Monthly Salary Setting</h2></div>' +
          '<p class="muted">This amount carries forward to new months until you change it.</p>' +
          '<form id="salaryLimitForm" class="form-grid">' +
            '<input type="hidden" name="month" value="' + esc(selectedMonth) + '">' +
            '<div class="span2"><label>Monthly Salary</label><input name="salary_limit" type="number" min="0" step="0.01" value="' + esc(summary.salary_limit || 0) + '" required></div>' +
            '<div class="form-actions"><button class="primary-btn">Save Monthly Salary</button></div>' +
          '</form>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h2>Pay Salary · Payable Now</h2></div>' +
          '<p class="muted">Current available payable amount: <strong>' + money(payable) + '</strong>. Previous unpaid balance is included automatically. Partial payment is allowed.</p>' +
          '<form id="salaryPaymentForm" class="form-grid">' +
            '<div><label>Payment Date</label><input name="payment_date" type="date" value="' + esc(paymentDate) + '" min="' + esc(selectedMonth + '-01') + '" max="' + esc(selectedMonth === currentMonth ? today() : salaryMonthEndV2(selectedMonth)) + '" required></div>' +
            '<div><label>Amount</label><input name="amount" id="salaryPaymentAmount" type="number" min="0.01" max="' + esc(payable) + '" step="0.01" required></div>' +
            '<div><label>Method</label><select name="payment_method"><option>CASH</option><option>BANK</option><option>MOBILE</option><option>OTHER</option></select></div>' +
            '<div><label>Payable Balance After Payment</label><input id="salaryPayableAfter" value="' + money(payable) + '" disabled></div>' +
            '<div class="span2"><label>Notes</label><input name="notes" placeholder="Optional note"></div>' +
            '<div class="form-actions"><button class="primary-btn" ' + (payable <= 0 ? 'disabled' : '') + '>Pay Salary</button></div>' +
          '</form>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-top:18px">' +
        '<div class="card-head"><h2>Salary Advance History · ' + esc(monthLabel) + '</h2><span class="badge">' + advances.filter(function (x) { return x.status === 'POSTED'; }).length + ' Posted</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>No</th><th>Date</th><th>Amount</th><th>Method</th><th>Notes</th><th>Status</th><th>Entered By</th><th></th></tr></thead><tbody>' + advanceRows + '</tbody></table></div>' +
      '</div>' +

      '<div class="card" style="margin-top:18px">' +
        '<div class="card-head"><h2>Salary Payment History · ' + esc(monthLabel) + '</h2><span class="badge">' + payments.filter(function (x) { return x.status === 'POSTED'; }).length + ' Posted</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>No</th><th>Date</th><th>Amount</th><th>Method</th><th>Notes</th><th>Status</th><th>Entered By</th><th></th></tr></thead><tbody>' + paymentRows + '</tbody></table></div>' +
      '</div>' +

      '<div class="alert ok" style="margin-top:18px">Company Fund decreases only when an Advance or Salary Payment is actually posted. This UI update does not change any salary, advance, payment, or company-fund data.</div>';

    document.getElementById('salaryMonth').onchange = function (event) {
      loadSalaryAdvance(event.target.value);
    };

    const advanceAmount = document.getElementById('salaryAdvanceAmount');
    advanceAmount.addEventListener('input', function () {
      document.getElementById('salaryBalanceAfter').value = money(Math.max(0, currentBalance - Number(advanceAmount.value || 0)));
    });

    const paymentAmount = document.getElementById('salaryPaymentAmount');
    paymentAmount.addEventListener('input', function () {
      document.getElementById('salaryPayableAfter').value = money(Math.max(0, payable - Number(paymentAmount.value || 0)));
    });

    document.getElementById('salaryLimitForm').onsubmit = async function (event) {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      if (!confirm('Update Monthly Salary to ' + money(body.salary_limit) + ' for ' + selectedMonth + '?')) return;
      try {
        await api('/api/salary-advance/limit', { method:'PUT', body:JSON.stringify(body) });
        showNotice('Monthly Salary updated successfully.');
        await loadSalaryAdvance(selectedMonth);
      } catch (error) { showNotice(error.message, 'error'); }
    };

    document.getElementById('salaryAdvanceForm').onsubmit = async function (event) {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      if (Number(body.amount) > currentBalance) {
        showNotice('Advance cannot exceed Salary Balance ' + money(currentBalance) + '.', 'error');
        return;
      }
      if (!confirm('Save Salary Advance ' + money(body.amount) + '? Company Fund will decrease.')) return;
      try {
        await api('/api/salary-advance', { method:'POST', body:JSON.stringify(body) });
        showNotice('Salary Advance saved. Company Fund updated.');
        await loadSalaryAdvance(selectedMonth);
      } catch (error) { showNotice(error.message, 'error'); }
    };

    document.getElementById('salaryPaymentForm').onsubmit = async function (event) {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      if (Number(body.amount) > payable) {
        showNotice('Salary Payment cannot exceed Total Payable ' + money(payable) + '.', 'error');
        return;
      }
      if (!confirm('Pay Salary ' + money(body.amount) + '? Company Fund will decrease.')) return;
      try {
        await api('/api/salary-advance/payment', { method:'POST', body:JSON.stringify(body) });
        showNotice('Salary Payment saved. Balance updated.');
        await loadSalaryAdvance(selectedMonth);
      } catch (error) { showNotice(error.message, 'error'); }
    };

    document.querySelectorAll('.salary-void').forEach(function (button) {
      button.onclick = async function () {
        const reason = prompt('Reason for voiding this Salary Advance:');
        if (!reason) return;
        try {
          await api('/api/salary-advance/' + button.dataset.id + '/void', { method:'POST', body:JSON.stringify({ reason:reason }) });
          showNotice('Salary Advance voided. Company Fund restored.');
          await loadSalaryAdvance(selectedMonth);
        } catch (error) { showNotice(error.message, 'error'); }
      };
    });

    document.querySelectorAll('.salary-payment-void').forEach(function (button) {
      button.onclick = async function () {
        const reason = prompt('Reason for voiding this Salary Payment:');
        if (!reason) return;
        try {
          await api('/api/salary-advance/payment/' + button.dataset.id + '/void', { method:'POST', body:JSON.stringify({ reason:reason }) });
          showNotice('Salary Payment voided. Company Fund restored.');
          await loadSalaryAdvance(selectedMonth);
        } catch (error) { showNotice(error.message, 'error'); }
      };
    });
  };
})();
`;
