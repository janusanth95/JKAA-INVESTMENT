# JK Investment Salary Carry-Forward Update

## Included behavior

- Fixed salary due date: 25th of every month.
- Monthly salary amount carries forward until changed.
- Salary advance reduces current-month salary balance and Company Fund.
- Unpaid or partly paid salary automatically carries to the next month.
- Salary payments can be full or partial and reduce Company Fund only when posted.
- Advance and payment corrections use Void with a reason; financial rows are not deleted.
- Dashboard profit recognizes the full monthly salary on the 25th.
- Google Drive backup includes salary payment data and a `Salary_Payments.xlsx` file.

## Safe deployment

1. Keep the existing Google Drive backup before uploading this update.
2. Upload the contents of this package to the repository root, preserving the `src`, `src/routes`, `db`, and `tests` paths.
3. Commit directly to `main` with message: `Add salary carry forward and payments`.
4. Wait for Vercel to show `Ready` and `Production`.
5. Hard refresh the website, open Settings > Salary Advance, and verify the current monthly salary before entering a payment.

No manual database command is required. The application safely creates the new `salary_payments` table and audit protections when the salary page, finance summary, dashboard, or backup first loads.
