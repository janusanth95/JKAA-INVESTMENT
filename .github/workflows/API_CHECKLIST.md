# JK Investment API Smoke Test

After database + API setup, test in this order:

1. `GET /health`
2. Create first admin (`npm run create-admin`)
3. `POST /api/auth/login`
4. `POST /api/auth/2fa/setup` then `/2fa/confirm`
5. Create Center
6. Create Group
7. Create Customer
8. Create Loan
9. Disburse Loan
10. Open Loan Detail and verify schedule
11. Create first Payment
12. Verify Balance / Arrears / Advance
13. Enter a second payment on the SAME date
14. Verify both receipts remain separate
15. Void one test payment as Admin
16. Verify audit log + balance are correct
17. Test Logout All Devices

Do all of the above with dummy/staging data before importing company records.
