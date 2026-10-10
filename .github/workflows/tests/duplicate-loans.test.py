"""Exercise the production eligibility SQL without touching live customer data."""
import re
import sqlite3
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / 'src/routes/loans.js').read_text()
SQL = re.search(r'const existingLoan = await client.query\(\s*`(.*?)`', SOURCE, re.S)[1]

class LoanEligibilityTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('CREATE TABLE v_loan_financials (loan_id TEXT, loan_code TEXT, customer_id TEXT, lifecycle_status TEXT, operational_status TEXT, balance NUMERIC)')

    def tearDown(self):
        self.db.close()

    def add(self, lifecycle, operational, balance, customer='customer-1'):
        self.db.execute('INSERT INTO v_loan_financials VALUES (?,?,?,?,?,?)', ('loan-1','LN001',customer,lifecycle,operational,balance))

    def blocked(self):
        return bool(self.db.execute(SQL, {'1':'customer-1'}).fetchone())

    def test_open_loans_block(self):
        for lifecycle, operational, balance in [('PENDING','PENDING',0),('DISBURSED','ACTIVE',100),('DISBURSED','OC',100),('DISBURSED','ACTIVE',0.01)]:
            with self.subTest(status=operational,balance=balance):
                self.db.execute('DELETE FROM v_loan_financials')
                self.add(lifecycle,operational,balance)
                self.assertTrue(self.blocked())

    def test_closed_cancelled_and_other_customer_allow(self):
        self.assertFalse(self.blocked())
        self.add('DISBURSED','CLOSED',0)
        self.add('CANCELLED','CANCELLED',500)
        self.add('PENDING','PENDING',500,'customer-2')
        self.assertFalse(self.blocked())

    def test_open_loan_not_hidden_by_closed_history(self):
        self.add('DISBURSED','CLOSED',0)
        self.add('DISBURSED','OC',10)
        self.assertTrue(self.blocked())

    def test_customer_lock_precedes_eligibility_and_insert(self):
        create=SOURCE[SOURCE.index('const body = createLoanSchema.parse'):]
        self.assertLess(create.index('FOR UPDATE'),create.index('const existingLoan'))
        self.assertLess(create.index('const existingLoan'),create.index('INSERT INTO loans'))
        self.assertIn('withTransaction',create[:create.index('FOR UPDATE')])

if __name__ == '__main__':
    unittest.main()
