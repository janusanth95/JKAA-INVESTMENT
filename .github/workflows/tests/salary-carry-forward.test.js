import assert from 'node:assert/strict';

import { calculateSalaryFigures, salaryAdvanceRouter } from '../src/salary-advance.js';

const registeredRoutes = salaryAdvanceRouter.stack
  .filter(layer => layer.route)
  .map(layer => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).filter(key => layer.route.methods[key])
  }));

assert(registeredRoutes.some(route => route.path === '/payment' && route.methods.includes('post')));
assert(registeredRoutes.some(route => route.path === '/payment/:id/void' && route.methods.includes('post')));

const september = calculateSalaryFigures({
  salaryLimit: 30000,
  advanceTaken: 10000,
  previousBalance: 0,
  salaryPaid: 0,
  dueReleased: true
});

assert.equal(september.currentSalaryBalance, 20000);
assert.equal(september.closingBalance, 20000);
assert.equal(september.paymentStatus, 'UNPAID');

const october = calculateSalaryFigures({
  salaryLimit: 30000,
  advanceTaken: 0,
  previousBalance: september.closingBalance,
  salaryPaid: 0,
  dueReleased: true
});

assert.equal(october.grossPayable, 50000);
assert.equal(october.closingBalance, 50000);

const partialPayment = calculateSalaryFigures({
  salaryLimit: 30000,
  advanceTaken: 5000,
  previousBalance: 20000,
  salaryPaid: 25000,
  dueReleased: true
});

assert.equal(partialPayment.grossPayable, 45000);
assert.equal(partialPayment.closingBalance, 20000);
assert.equal(partialPayment.paymentStatus, 'PARTIALLY_PAID');

const beforeDueDate = calculateSalaryFigures({
  salaryLimit: 30000,
  advanceTaken: 10000,
  previousBalance: 0,
  salaryPaid: 0,
  dueReleased: false
});

assert.equal(beforeDueDate.currentSalaryBalance, 20000);
assert.equal(beforeDueDate.closingBalance, 0);
assert.equal(beforeDueDate.paymentStatus, 'UPCOMING');

console.log('Salary carry-forward calculation tests passed.');
