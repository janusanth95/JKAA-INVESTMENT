# JK Investment Backend API — Starter v1

This is the next layer after the PostgreSQL schema: a secure Node.js/Express API that sits between the JK Investment website and PostgreSQL.

## Included now

### Security
- Argon2id password verification
- Opaque bearer sessions stored as hashes in PostgreSQL
- Admin/Staff permission checks from database RBAC
- Login brute-force protection
- Temporary account lock after repeated failures
- Logout
- Logout all devices
- Authenticator/TOTP 2FA setup + confirm + login verification
- AES-256-GCM encryption for 2FA secrets at rest
- Helmet security headers
- CORS allow-list
- Parameterized PostgreSQL queries
- Financial database writes inside transactions

### JK workflow
- Centers list/create
- Groups list/create
- Customers list/create/view
- Customer top totals: payable / paid / balance / arrears / advance
- Loans list/create/view
- Two guarantors
- Loan disbursement
- Repayment schedule
- Payments
- Duplicate same-day payments
- Payment idempotency key support
- Payment void instead of physical delete
- Dashboard totals
- Active / OC / Closed
- Not-paid-today count
- Cash-in-hand from the cash ledger

## Architecture

```text
JK Website / Mobile Browser
          |
          | HTTPS JSON API
          v
JK Investment Backend API
          |
          | private DATABASE_URL
          v
PostgreSQL
          |
          +-- automatic provider backups
```

The frontend must NEVER contain `DATABASE_URL`, database passwords, 2FA encryption keys, or admin passwords.

## 1. Requirements

- Node.js 20+ recommended
- PostgreSQL 15+
- npm

## 2. Install

```bash
npm install
```

## 3. Configure local environment

Copy:

```bash
cp .env.example .env
```

Generate the 2FA encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the result into:

```text
TWO_FACTOR_ENCRYPTION_KEY=...
```

Set a real PostgreSQL `DATABASE_URL`.

## 4. Create database schema

Run:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

The schema must be installed before starting the API.

## 5. Create the first Admin

Set in `.env`:

```text
ADMIN_USERNAME=admin
ADMIN_NAME=JK Administrator
ADMIN_PASSWORD=<strong-password-at-least-12-characters>
```

Then:

```bash
npm run create-admin
```

After creation, do not keep the real admin password in source control.

## 6. Start API

Development:

```bash
npm run dev
```

Production:

```bash
npm start
```

Health check:

```text
GET /health
```

Default local API:

```text
http://localhost:4000
```

## Main API endpoints

### Auth
```text
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
POST /api/auth/logout-all
POST /api/auth/2fa/setup
POST /api/auth/2fa/confirm
```

### Organization
```text
GET  /api/organization/centers
POST /api/organization/centers
GET  /api/organization/groups
POST /api/organization/groups
```

### Customers
```text
GET  /api/customers
POST /api/customers
GET  /api/customers/:id
```

### Loans
```text
GET  /api/loans
POST /api/loans
GET  /api/loans/:id
POST /api/loans/:id/disburse
```

### Payments
```text
POST /api/payments
POST /api/payments/:id/void
```

### Dashboard
```text
GET /api/dashboard
```

## Login request example

```json
{
  "username": "admin",
  "password": "your-password",
  "totp": "123456",
  "device_label": "Janu Laptop"
}
```

`totp` is required only after 2FA is enabled.

The returned `access_token` is sent on future requests:

```text
Authorization: Bearer <access_token>
```

The raw session token is never stored in the database; only its SHA-256 hash is stored.

## Create customer example

```json
{
  "center_id": "UUID",
  "group_id": "UUID",
  "customer_name": "Customer Name",
  "nic": "NIC",
  "mobile": "0771234567",
  "address": "Address",
  "guarantor_name": "Guarantor",
  "guarantor_nic": "NIC",
  "guarantor_mobile": "0770000000"
}
```

## Create loan example

```json
{
  "customer_id": "UUID",
  "principal": 100000,
  "interest_rate": 20,
  "loan_type": "WEEKLY",
  "installment_count": 28,
  "repayment_start_date": "2026-09-07",
  "guarantors": [
    {
      "name": "Guarantor One",
      "nic": "NIC1",
      "mobile": "0771111111"
    },
    {
      "name": "Guarantor Two",
      "nic": "NIC2",
      "mobile": "0772222222"
    }
  ]
}
```

## Disburse loan example

```json
{
  "disbursed_date": "2026-09-05",
  "payment_method": "CASH"
}
```

The PostgreSQL function will generate the repayment schedule and move a delayed repayment start to the next valid cycle according to the schema rules.

## Create payment example

```json
{
  "loan_id": "UUID",
  "amount": 2500,
  "payment_date": "2026-09-07",
  "payment_method": "CASH",
  "notes": "Weekly collection",
  "idempotency_key": "OPTIONAL-UUID-FROM-FRONTEND"
}
```

The response includes the updated loan `balance`, `arrears`, and `advance`.

## Important money rule

PostgreSQL `NUMERIC` values are intentionally returned as JSON strings by node-postgres, for example:

```json
{
  "balance": "80000.00",
  "arrears": "4822.00"
}
```

Do not convert money to JavaScript floating-point for business calculations. Let PostgreSQL handle financial arithmetic.

## 2FA frontend flow

1. Login normally.
2. Call `POST /api/auth/2fa/setup`.
3. Backend returns an `otpauth_uri`.
4. Frontend renders that URI as a QR code.
5. User scans with Google/Microsoft/Authy/1Password authenticator.
6. Send the 6-digit token to `POST /api/auth/2fa/confirm`.
7. Future logins require the `totp` field.

## Production deployment order

1. Create managed PostgreSQL.
2. Apply `db/schema.sql`.
3. Deploy this backend with private environment secrets.
4. Create first admin.
5. Verify `/health`.
6. Test with dummy Customer → Loan → Disbursement → Payment.
7. Connect the existing JK frontend to the API.
8. Import existing JK JSON backup into a staging database.
9. Compare totals/arrears against the current system.
10. Enable provider automatic daily backups.
11. Only after reconciliation, launch production.

## Still to build before full launch

This starter intentionally focuses on the core money path. Next modules should be:
- Current JK JSON backup importer
- Customer/loan edit endpoints with stronger audit workflow
- DOC/INS collection endpoints
- Expenses endpoints
- Investor endpoints
- Cashbook detailed reporting
- PDF agreements/statements
- Excel full backup export
- Staff management UI/endpoints
- Backup job integration
- Automated integration tests

## Critical launch rule

Do not point real company operations at a fresh production database until a staging test proves:
- balances match,
- arrears match,
- repayment dates match,
- payment duplicates behave correctly,
- void/reversal behavior works,
- backup restore has been tested.
