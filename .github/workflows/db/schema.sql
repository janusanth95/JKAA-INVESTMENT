-- ============================================================
-- JK INVESTMENT - PRODUCTION POSTGRESQL SCHEMA
-- Version: 1.0
-- Target: PostgreSQL 15+
-- Currency: LKR
--
-- IMPORTANT PRODUCTION RULES
-- 1) Do not expose the database directly to the browser.
-- 2) Financial rows should be VOIDED, not physically deleted.
-- 3) Backend should set:
--      SET LOCAL app.user_id = '<logged-in-user-uuid>';
--    before writes so audit logs record the actor.
-- 4) All money uses NUMERIC(15,2), never floating point.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 1. COMMON HELPERS
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text;
BEGIN
  v := current_setting('app.user_id', true);
  IF v IS NULL OR btrim(v) = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

-- Human-readable codes
CREATE SEQUENCE IF NOT EXISTS seq_center_code START 1;
CREATE SEQUENCE IF NOT EXISTS seq_group_code START 1;
CREATE SEQUENCE IF NOT EXISTS seq_customer_code START 1;
CREATE SEQUENCE IF NOT EXISTS seq_loan_code START 1;
CREATE SEQUENCE IF NOT EXISTS seq_receipt_no START 1;
CREATE SEQUENCE IF NOT EXISTS seq_expense_no START 1;
CREATE SEQUENCE IF NOT EXISTS seq_investor_txn_no START 1;

-- ============================================================
-- 2. RBAC / USERS / SECURITY
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z_]+$'),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]+$'),
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT,
  mobile TEXT,
  password_hash TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DISABLED','LOCKED')),
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  two_factor_secret_encrypted BYTEA,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

-- ============================================================
-- 3. ORGANIZATION: CENTERS / GROUPS
-- ============================================================

CREATE TABLE IF NOT EXISTS centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_code TEXT NOT NULL UNIQUE DEFAULT
    ('CTR-' || lpad(nextval('seq_center_code')::text, 4, '0')),
  center_name TEXT NOT NULL,
  address TEXT,
  collection_isodow SMALLINT NOT NULL CHECK (collection_isodow BETWEEN 1 AND 7),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN centers.collection_isodow IS 'ISO day: Monday=1 ... Sunday=7';

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code TEXT NOT NULL UNIQUE DEFAULT
    ('GRP-' || lpad(nextval('seq_group_code')::text, 4, '0')),
  center_id UUID NOT NULL REFERENCES centers(id),
  group_name TEXT NOT NULL,
  members_count INTEGER CHECK (members_count IS NULL OR members_count >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(center_id, group_name)
);

CREATE INDEX IF NOT EXISTS idx_groups_center ON groups(center_id, status);

-- ============================================================
-- 4. CUSTOMERS
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code TEXT NOT NULL UNIQUE DEFAULT
    ('JK-CUS-' || lpad(nextval('seq_customer_code')::text, 6, '0')),
  center_id UUID NOT NULL REFERENCES centers(id),
  group_id UUID NOT NULL REFERENCES groups(id),
  customer_name TEXT NOT NULL,
  nic TEXT NOT NULL,
  mobile TEXT,
  address TEXT,
  default_guarantor_name TEXT,
  default_guarantor_nic TEXT,
  default_guarantor_mobile TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_nic_normalized
  ON customers (upper(regexp_replace(nic, '\s+', '', 'g')));

CREATE INDEX IF NOT EXISTS idx_customers_center_group ON customers(center_id, group_id, status);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(customer_name);

CREATE OR REPLACE FUNCTION validate_customer_group_center()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_center UUID;
BEGIN
  SELECT center_id INTO v_center FROM groups WHERE id = NEW.group_id;
  IF v_center IS NULL THEN
    RAISE EXCEPTION 'Selected group does not exist';
  END IF;
  IF v_center <> NEW.center_id THEN
    RAISE EXCEPTION 'Customer center and group center do not match';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_group_center ON customers;
CREATE TRIGGER trg_customer_group_center
BEFORE INSERT OR UPDATE OF center_id, group_id ON customers
FOR EACH ROW EXECUTE FUNCTION validate_customer_group_center();

-- ============================================================
-- 5. LOANS
-- ============================================================

CREATE TABLE IF NOT EXISTS loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_code TEXT NOT NULL UNIQUE DEFAULT
    ('JK-LN-' || lpad(nextval('seq_loan_code')::text, 7, '0')),
  customer_id UUID NOT NULL REFERENCES customers(id),
  center_id UUID NOT NULL REFERENCES centers(id),
  group_id UUID NOT NULL REFERENCES groups(id),

  principal NUMERIC(15,2) NOT NULL CHECK (principal > 0),
  interest_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (interest_rate >= 0),
  interest_amount NUMERIC(15,2) GENERATED ALWAYS AS
    (round(principal * interest_rate / 100.0, 2)) STORED,
  total_payable NUMERIC(15,2) GENERATED ALWAYS AS
    (round(principal + (principal * interest_rate / 100.0), 2)) STORED,

  loan_type TEXT NOT NULL CHECK (loan_type IN ('DAILY','WEEKLY','MONTHLY')),
  installment_count INTEGER NOT NULL CHECK (installment_count > 0),
  repayment_start_date DATE NOT NULL,

  lifecycle_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (lifecycle_status IN ('PENDING','DISBURSED','CANCELLED')),
  disbursed_date DATE,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,

  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (
    (lifecycle_status = 'DISBURSED' AND disbursed_date IS NOT NULL)
    OR lifecycle_status <> 'DISBURSED'
  )
);

CREATE INDEX IF NOT EXISTS idx_loans_customer ON loans(customer_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_loans_center_group ON loans(center_id, group_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_loans_repayment_start ON loans(repayment_start_date);

CREATE OR REPLACE FUNCTION validate_loan_links_and_center_day()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer_center UUID;
  v_customer_group UUID;
  v_group_center UUID;
  v_collection_isodow SMALLINT;
BEGIN
  SELECT center_id, group_id
    INTO v_customer_center, v_customer_group
  FROM customers
  WHERE id = NEW.customer_id;

  IF v_customer_center IS NULL THEN
    RAISE EXCEPTION 'Customer does not exist';
  END IF;

  IF v_customer_center <> NEW.center_id OR v_customer_group <> NEW.group_id THEN
    RAISE EXCEPTION 'Loan customer/center/group relationship does not match';
  END IF;

  SELECT center_id INTO v_group_center FROM groups WHERE id = NEW.group_id;
  IF v_group_center <> NEW.center_id THEN
    RAISE EXCEPTION 'Loan group does not belong to selected center';
  END IF;

  SELECT collection_isodow INTO v_collection_isodow
  FROM centers WHERE id = NEW.center_id;

  -- For WEEKLY/MONTHLY loans, repayment start must match the center collection day.
  IF NEW.loan_type IN ('WEEKLY','MONTHLY')
     AND extract(isodow from NEW.repayment_start_date)::smallint <> v_collection_isodow THEN
    RAISE EXCEPTION
      'Repayment start date (%) does not match center collection day (ISO day %)',
      NEW.repayment_start_date, v_collection_isodow;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_loan_links ON loans;
CREATE TRIGGER trg_validate_loan_links
BEFORE INSERT OR UPDATE OF customer_id, center_id, group_id, loan_type, repayment_start_date
ON loans
FOR EACH ROW EXECUTE FUNCTION validate_loan_links_and_center_day();

-- If disbursement happens after the planned repayment start date, move the
-- repayment start forward to the next valid cycle.
CREATE OR REPLACE FUNCTION adjust_repayment_start_on_disbursement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_date DATE;
BEGIN
  IF NEW.lifecycle_status = 'DISBURSED'
     AND (OLD.lifecycle_status IS DISTINCT FROM 'DISBURSED')
     AND NEW.disbursed_date IS NOT NULL THEN

    v_date := NEW.repayment_start_date;

    IF NEW.loan_type = 'DAILY' THEN
      IF v_date < NEW.disbursed_date THEN
        v_date := NEW.disbursed_date;
      END IF;

    ELSIF NEW.loan_type = 'WEEKLY' THEN
      WHILE v_date < NEW.disbursed_date LOOP
        v_date := v_date + 7;
      END LOOP;

    ELSIF NEW.loan_type = 'MONTHLY' THEN
      WHILE v_date < NEW.disbursed_date LOOP
        v_date := (v_date + INTERVAL '1 month')::date;
      END LOOP;
    END IF;

    NEW.repayment_start_date := v_date;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_adjust_repayment_start ON loans;
CREATE TRIGGER trg_adjust_repayment_start
BEFORE UPDATE OF lifecycle_status, disbursed_date ON loans
FOR EACH ROW EXECUTE FUNCTION adjust_repayment_start_on_disbursement();

-- ============================================================
-- 6. LOAN GUARANTORS
-- ============================================================

CREATE TABLE IF NOT EXISTS loan_guarantors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  guarantor_order SMALLINT NOT NULL CHECK (guarantor_order IN (1,2)),
  customer_id UUID REFERENCES customers(id),
  guarantor_name TEXT NOT NULL,
  nic TEXT NOT NULL,
  mobile TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(loan_id, guarantor_order)
);

CREATE INDEX IF NOT EXISTS idx_loan_guarantors_loan ON loan_guarantors(loan_id);

-- ============================================================
-- 7. REPAYMENT SCHEDULE
-- ============================================================

CREATE TABLE IF NOT EXISTS loan_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  installment_no INTEGER NOT NULL CHECK (installment_no > 0),
  due_date DATE NOT NULL,
  due_amount NUMERIC(15,2) NOT NULL CHECK (due_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(loan_id, installment_no),
  UNIQUE(loan_id, due_date)
);

CREATE INDEX IF NOT EXISTS idx_schedule_due_date ON loan_schedule(due_date, loan_id);
CREATE INDEX IF NOT EXISTS idx_schedule_loan ON loan_schedule(loan_id, installment_no);

CREATE OR REPLACE FUNCTION generate_loan_schedule(p_loan_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_loan loans%ROWTYPE;
  v_base NUMERIC(15,2);
  v_due NUMERIC(15,2);
  v_date DATE;
  i INTEGER;
BEGIN
  SELECT * INTO v_loan
  FROM loans
  WHERE id = p_loan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan % not found', p_loan_id;
  END IF;

  DELETE FROM loan_schedule WHERE loan_id = p_loan_id;

  v_base := round(v_loan.total_payable / v_loan.installment_count, 2);

  FOR i IN 1..v_loan.installment_count LOOP

    IF v_loan.loan_type = 'DAILY' THEN
      v_date := v_loan.repayment_start_date + (i - 1);

    ELSIF v_loan.loan_type = 'WEEKLY' THEN
      v_date := v_loan.repayment_start_date + ((i - 1) * 7);

    ELSE
      v_date := (v_loan.repayment_start_date + ((i - 1) * INTERVAL '1 month'))::date;
    END IF;

    IF i < v_loan.installment_count THEN
      v_due := v_base;
    ELSE
      -- Make the final installment absorb rounding difference.
      v_due := round(
        v_loan.total_payable - (v_base * (v_loan.installment_count - 1)),
        2
      );
    END IF;

    INSERT INTO loan_schedule(loan_id, installment_no, due_date, due_amount)
    VALUES (p_loan_id, i, v_date, v_due);
  END LOOP;
END;
$$;

-- ============================================================
-- 8. PAYMENTS / RECEIPTS / ALLOCATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no TEXT NOT NULL UNIQUE DEFAULT
    ('JK-RCP-' || lpad(nextval('seq_receipt_no')::text, 8, '0')),
  idempotency_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

  loan_id UUID NOT NULL REFERENCES loans(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  center_id UUID NOT NULL REFERENCES centers(id),

  payment_date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  reference_no TEXT,
  notes TEXT,

  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  whatsapp_sent_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  void_reason TEXT,

  entered_by UUID REFERENCES users(id),
  edited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (
    (status = 'VOIDED' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
    OR status = 'POSTED'
  )
);

CREATE INDEX IF NOT EXISTS idx_payments_loan_date ON payments(loan_id, payment_date, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_customer_date ON payments(customer_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_center_date ON payments(center_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_posted ON payments(loan_id) WHERE status = 'POSTED';

CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  schedule_id UUID NOT NULL REFERENCES loan_schedule(id) ON DELETE RESTRICT,
  allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payment_id, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_alloc_schedule ON payment_allocations(schedule_id);
CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(payment_id);

CREATE OR REPLACE FUNCTION validate_payment_links_and_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_customer UUID;
  v_center UUID;
  v_status TEXT;
  v_total NUMERIC(15,2);
  v_paid_other NUMERIC(15,2);
BEGIN
  SELECT customer_id, center_id, lifecycle_status, total_payable
    INTO v_customer, v_center, v_status, v_total
  FROM loans
  WHERE id = NEW.loan_id;

  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'Loan does not exist';
  END IF;

  IF v_customer <> NEW.customer_id OR v_center <> NEW.center_id THEN
    RAISE EXCEPTION 'Payment customer/center does not match loan';
  END IF;

  IF v_status <> 'DISBURSED' THEN
    RAISE EXCEPTION 'Payments are allowed only for DISBURSED loans';
  END IF;

  IF NEW.status = 'POSTED' THEN
    SELECT COALESCE(sum(amount),0)
      INTO v_paid_other
    FROM payments
    WHERE loan_id = NEW.loan_id
      AND status = 'POSTED'
      AND id <> COALESCE(NEW.id, gen_random_uuid());

    IF round(v_paid_other + NEW.amount, 2) > v_total THEN
      RAISE EXCEPTION
        'Payment exceeds outstanding loan balance. Total payable %, already paid %, attempted %',
        v_total, v_paid_other, NEW.amount;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_payment ON payments;
CREATE TRIGGER trg_validate_payment
BEFORE INSERT OR UPDATE OF loan_id, customer_id, center_id, amount, status
ON payments
FOR EACH ROW EXECUTE FUNCTION validate_payment_links_and_balance();

CREATE OR REPLACE FUNCTION allocate_payment_fifo(p_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment payments%ROWTYPE;
  v_remaining NUMERIC(15,2);
  v_already NUMERIC(15,2);
  v_need NUMERIC(15,2);
  v_take NUMERIC(15,2);
  r RECORD;
BEGIN
  SELECT * INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', p_payment_id;
  END IF;

  DELETE FROM payment_allocations WHERE payment_id = p_payment_id;

  IF v_payment.status <> 'POSTED' THEN
    RETURN;
  END IF;

  v_remaining := v_payment.amount;

  FOR r IN
    SELECT s.id, s.installment_no, s.due_date, s.due_amount,
           COALESCE((
             SELECT sum(pa.allocated_amount)
             FROM payment_allocations pa
             JOIN payments p2 ON p2.id = pa.payment_id
             WHERE pa.schedule_id = s.id
               AND p2.status = 'POSTED'
               AND p2.id <> p_payment_id
           ),0) AS allocated_other
    FROM loan_schedule s
    WHERE s.loan_id = v_payment.loan_id
    ORDER BY s.installment_no
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_already := r.allocated_other;
    v_need := greatest(r.due_amount - v_already, 0);

    IF v_need > 0 THEN
      v_take := least(v_remaining, v_need);

      INSERT INTO payment_allocations(payment_id, schedule_id, allocated_amount)
      VALUES (p_payment_id, r.id, v_take);

      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;

  IF v_remaining > 0.009 THEN
    RAISE EXCEPTION 'Unallocated payment amount remains: %', v_remaining;
  END IF;
END;
$$;

-- ============================================================
-- 9. LOAN CHARGES: DOC / INSURANCE / SERVICE
-- ============================================================

CREATE TABLE IF NOT EXISTS charge_defaults (
  charge_type TEXT PRIMARY KEY CHECK (charge_type IN ('DOCUMENT','INSURANCE','SERVICE')),
  default_amount NUMERIC(15,2) NOT NULL CHECK (default_amount >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO charge_defaults(charge_type, default_amount)
VALUES
  ('DOCUMENT', 1000.00),
  ('INSURANCE', 1000.00),
  ('SERVICE', 500.00)
ON CONFLICT (charge_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS loan_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id),
  charge_type TEXT NOT NULL CHECK (charge_type IN ('DOCUMENT','INSURANCE','SERVICE','OTHER')),
  amount NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE','COLLECTED','WAIVED')),
  collected_date DATE,
  payment_method TEXT CHECK (
    payment_method IS NULL OR payment_method IN ('CASH','BANK','MOBILE','OTHER')
  ),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(loan_id, charge_type)
);

CREATE INDEX IF NOT EXISTS idx_loan_charges_loan ON loan_charges(loan_id, status);

CREATE OR REPLACE FUNCTION add_default_loan_charges(p_loan_id UUID, p_user_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO loan_charges(loan_id, charge_type, amount, created_by)
  SELECT p_loan_id, charge_type, default_amount, p_user_id
  FROM charge_defaults
  WHERE active = true
  ON CONFLICT (loan_id, charge_type) DO NOTHING;
END;
$$;

-- ============================================================
-- 10. EXPENSES
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_no TEXT NOT NULL UNIQUE DEFAULT
    ('JK-EXP-' || lpad(nextval('seq_expense_no')::text, 7, '0')),
  expense_date DATE NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  void_reason TEXT,
  entered_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date, status);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category, expense_date);

-- ============================================================
-- 11. INVESTORS
-- ============================================================

CREATE TABLE IF NOT EXISTS investors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_name TEXT NOT NULL,
  mobile TEXT,
  nic TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investor_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_no TEXT NOT NULL UNIQUE DEFAULT
    ('JK-INV-' || lpad(nextval('seq_investor_txn_no')::text, 7, '0')),
  investor_id UUID NOT NULL REFERENCES investors(id),
  transaction_date DATE NOT NULL,
  transaction_type TEXT NOT NULL
    CHECK (transaction_type IN ('DEPOSIT','WITHDRAWAL','INTEREST_PAID','ADJUSTMENT')),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES users(id),
  void_reason TEXT,
  entered_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_investor_txns_investor_date
  ON investor_transactions(investor_id, transaction_date, status);

-- ============================================================
-- 12. CASH LEDGER
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  category TEXT NOT NULL CHECK (
    category IN (
      'COLLECTION',
      'LOAN_CHARGE',
      'INVESTOR_DEPOSIT',
      'INVESTOR_WITHDRAWAL',
      'LOAN_DISBURSEMENT',
      'EXPENSE',
      'ADJUSTMENT'
    )
  ),
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  source_table TEXT,
  source_id UUID,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_ledger_source
  ON cash_ledger(source_table, source_id, category)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_ledger_date
  ON cash_ledger(entry_date, status, payment_method);

-- ============================================================
-- 12A. SALARY, ADVANCE & MONTHLY CARRY-FORWARD
-- Salary becomes due on the 25th. Carry-forward is calculated
-- from monthly salary - advances - salary payments.
-- ============================================================

CREATE TABLE IF NOT EXISTS salary_month_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_month DATE NOT NULL UNIQUE,
  salary_limit NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (salary_limit >= 0),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (salary_month = date_trunc('month', salary_month)::date)
);

CREATE TABLE IF NOT EXISTS salary_advances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_no TEXT NOT NULL UNIQUE,
  salary_month DATE NOT NULL,
  advance_date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  entered_by UUID REFERENCES users(id),
  voided_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (salary_month = date_trunc('month', salary_month)::date),
  CHECK (advance_date >= salary_month),
  CHECK (advance_date < salary_month + INTERVAL '1 month')
);

CREATE INDEX IF NOT EXISTS idx_salary_advances_month
  ON salary_advances(salary_month, status, advance_date);

CREATE TABLE IF NOT EXISTS salary_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_no TEXT NOT NULL UNIQUE,
  salary_month DATE NOT NULL,
  payment_date DATE NOT NULL,
  amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'CASH'
    CHECK (payment_method IN ('CASH','BANK','MOBILE','OTHER')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOIDED')),
  entered_by UUID REFERENCES users(id),
  voided_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (salary_month = date_trunc('month', salary_month)::date),
  CHECK (payment_date >= salary_month),
  CHECK (payment_date < salary_month + INTERVAL '1 month')
);

CREATE INDEX IF NOT EXISTS idx_salary_payments_month
  ON salary_payments(salary_month, status, payment_date);

-- ============================================================
-- 13. BACKUP HISTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('AUTO_DAILY','AUTO_WEEKLY','MANUAL','MONTHLY_ARCHIVE')),
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCESS','FAILED')),
  storage_location TEXT,
  checksum TEXT,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  initiated_by UUID REFERENCES users(id),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at DESC);

-- ============================================================
-- 14. AUDIT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  table_name TEXT NOT NULL,
  record_id UUID,
  old_data JSONB,
  new_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record
  ON audit_logs(table_name, record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      v_record_id := OLD.id;
    EXCEPTION WHEN undefined_column THEN
      v_record_id := NULL;
    END;

    INSERT INTO audit_logs(actor_user_id, action, table_name, record_id, old_data)
    VALUES (current_app_user_id(), TG_OP, TG_TABLE_NAME, v_record_id, to_jsonb(OLD));

    RETURN OLD;
  END IF;

  BEGIN
    v_record_id := NEW.id;
  EXCEPTION WHEN undefined_column THEN
    v_record_id := NULL;
  END;

  INSERT INTO audit_logs(actor_user_id, action, table_name, record_id, old_data, new_data)
  VALUES (
    current_app_user_id(),
    TG_OP,
    TG_TABLE_NAME,
    v_record_id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW)
  );

  RETURN NEW;
END;
$$;

-- ============================================================
-- 15. PROTECT FINANCIAL TABLES FROM PHYSICAL DELETE
-- ============================================================

CREATE OR REPLACE FUNCTION prevent_financial_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Physical DELETE is disabled for %. Use VOID/CANCEL status instead.',
    TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_no_delete_loans ON loans;
CREATE TRIGGER trg_no_delete_loans
BEFORE DELETE ON loans
FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

DROP TRIGGER IF EXISTS trg_no_delete_payments ON payments;
CREATE TRIGGER trg_no_delete_payments
BEFORE DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

DROP TRIGGER IF EXISTS trg_no_delete_expenses ON expenses;
CREATE TRIGGER trg_no_delete_expenses
BEFORE DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

DROP TRIGGER IF EXISTS trg_no_delete_investor_transactions ON investor_transactions;
CREATE TRIGGER trg_no_delete_investor_transactions
BEFORE DELETE ON investor_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

DROP TRIGGER IF EXISTS trg_no_delete_cash_ledger ON cash_ledger;
CREATE TRIGGER trg_no_delete_cash_ledger
BEFORE DELETE ON cash_ledger
FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete();

-- ============================================================
-- 16. AUTO UPDATED_AT TRIGGERS
-- ============================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','centers','groups','customers','loans',
    'payments','loan_charges','expenses','investors','charge_defaults'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- 17. AUDIT TRIGGERS
-- ============================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'centers','groups','customers','loans','loan_guarantors',
    'loan_schedule','payments','payment_allocations','loan_charges',
    'expenses','investors','investor_transactions','cash_ledger',
    'charge_defaults'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_audit ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_audit
       AFTER INSERT OR UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t, t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- 18. BUSINESS VIEWS
-- ============================================================

-- Per-loan balance, arrears/advance and derived operational status.
CREATE OR REPLACE VIEW v_loan_financials AS
WITH p AS (
  SELECT
    loan_id,
    COALESCE(sum(amount) FILTER (WHERE status = 'POSTED'), 0)::numeric(15,2) AS total_paid
  FROM payments
  GROUP BY loan_id
),
d AS (
  SELECT
    loan_id,
    COALESCE(sum(due_amount) FILTER (WHERE due_date <= current_date), 0)::numeric(15,2) AS scheduled_due_to_date,
    max(due_date) AS last_due_date
  FROM loan_schedule
  GROUP BY loan_id
)
SELECT
  l.id AS loan_id,
  l.loan_code,
  l.customer_id,
  l.center_id,
  l.group_id,
  l.principal,
  l.interest_rate,
  l.interest_amount,
  l.total_payable,
  COALESCE(p.total_paid,0)::numeric(15,2) AS total_paid,
  greatest(l.total_payable - COALESCE(p.total_paid,0), 0)::numeric(15,2) AS balance,
  (COALESCE(d.scheduled_due_to_date,0) - COALESCE(p.total_paid,0))::numeric(15,2) AS arrears_signed,
  greatest(COALESCE(d.scheduled_due_to_date,0) - COALESCE(p.total_paid,0), 0)::numeric(15,2) AS arrears,
  greatest(COALESCE(p.total_paid,0) - COALESCE(d.scheduled_due_to_date,0), 0)::numeric(15,2) AS advance,
  l.repayment_start_date,
  d.last_due_date,
  l.lifecycle_status,
  CASE
    WHEN l.lifecycle_status = 'CANCELLED' THEN 'CANCELLED'
    WHEN l.lifecycle_status = 'PENDING' THEN 'PENDING'
    WHEN COALESCE(p.total_paid,0) >= l.total_payable THEN 'CLOSED'
    WHEN d.last_due_date IS NOT NULL AND current_date > d.last_due_date THEN 'OC'
    ELSE 'ACTIVE'
  END AS operational_status
FROM loans l
LEFT JOIN p ON p.loan_id = l.id
LEFT JOIN d ON d.loan_id = l.id;

CREATE OR REPLACE VIEW v_customer_financials AS
SELECT
  c.id AS customer_id,
  c.customer_code,
  c.customer_name,
  c.center_id,
  c.group_id,
  COALESCE(sum(v.total_payable),0)::numeric(15,2) AS total_loan_payable,
  COALESCE(sum(v.total_paid),0)::numeric(15,2) AS total_paid,
  COALESCE(sum(v.balance),0)::numeric(15,2) AS total_balance,
  COALESCE(sum(v.arrears),0)::numeric(15,2) AS total_arrears,
  COALESCE(sum(v.advance),0)::numeric(15,2) AS total_advance
FROM customers c
LEFT JOIN v_loan_financials v
  ON v.customer_id = c.id
 AND v.lifecycle_status <> 'CANCELLED'
GROUP BY c.id, c.customer_code, c.customer_name, c.center_id, c.group_id;

CREATE OR REPLACE VIEW v_schedule_status AS
SELECT
  s.id AS schedule_id,
  s.loan_id,
  s.installment_no,
  s.due_date,
  s.due_amount,
  COALESCE(sum(pa.allocated_amount) FILTER (WHERE p.status = 'POSTED'),0)::numeric(15,2) AS allocated_amount,
  greatest(
    s.due_amount - COALESCE(sum(pa.allocated_amount) FILTER (WHERE p.status = 'POSTED'),0),
    0
  )::numeric(15,2) AS remaining_amount,
  CASE
    WHEN COALESCE(sum(pa.allocated_amount) FILTER (WHERE p.status = 'POSTED'),0) >= s.due_amount
      THEN 'PAID'
    WHEN COALESCE(sum(pa.allocated_amount) FILTER (WHERE p.status = 'POSTED'),0) > 0
      THEN 'PARTIAL'
    WHEN s.due_date < current_date
      THEN 'OVERDUE'
    ELSE 'PENDING'
  END AS installment_status
FROM loan_schedule s
LEFT JOIN payment_allocations pa ON pa.schedule_id = s.id
LEFT JOIN payments p ON p.id = pa.payment_id
GROUP BY s.id, s.loan_id, s.installment_no, s.due_date, s.due_amount;

CREATE OR REPLACE VIEW v_center_daily_collections AS
SELECT
  p.payment_date,
  p.center_id,
  count(*) AS payment_entries,
  count(DISTINCT p.customer_id) AS customers_paid,
  sum(p.amount)::numeric(15,2) AS collection_total
FROM payments p
WHERE p.status = 'POSTED'
GROUP BY p.payment_date, p.center_id;

-- Customers with a scheduled due today and no posted payment today.
CREATE OR REPLACE VIEW v_not_paid_today AS
SELECT DISTINCT
  l.center_id,
  l.group_id,
  l.customer_id,
  c.customer_code,
  c.customer_name,
  c.mobile,
  l.id AS loan_id,
  l.loan_code,
  s.due_amount
FROM loan_schedule s
JOIN loans l ON l.id = s.loan_id
JOIN customers c ON c.id = l.customer_id
WHERE s.due_date = current_date
  AND l.lifecycle_status = 'DISBURSED'
  AND NOT EXISTS (
    SELECT 1
    FROM payments p
    WHERE p.loan_id = l.id
      AND p.payment_date = current_date
      AND p.status = 'POSTED'
  );

CREATE OR REPLACE VIEW v_doc_ins_income AS
SELECT
  lc.loan_id,
  l.center_id,
  l.group_id,
  lc.charge_type,
  lc.amount,
  lc.collected_date,
  lc.payment_method
FROM loan_charges lc
JOIN loans l ON l.id = lc.loan_id
WHERE lc.status = 'COLLECTED'
  AND lc.charge_type IN ('DOCUMENT','INSURANCE');

CREATE OR REPLACE VIEW v_cash_book_daily AS
SELECT
  entry_date,
  payment_method,
  COALESCE(sum(amount) FILTER (WHERE direction = 'IN' AND status = 'POSTED'),0)::numeric(15,2) AS total_in,
  COALESCE(sum(amount) FILTER (WHERE direction = 'OUT' AND status = 'POSTED'),0)::numeric(15,2) AS total_out,
  (
    COALESCE(sum(amount) FILTER (WHERE direction = 'IN' AND status = 'POSTED'),0)
    -
    COALESCE(sum(amount) FILTER (WHERE direction = 'OUT' AND status = 'POSTED'),0)
  )::numeric(15,2) AS net_movement
FROM cash_ledger
GROUP BY entry_date, payment_method;

CREATE OR REPLACE VIEW v_investor_balances AS
SELECT
  i.id AS investor_id,
  i.investor_name,
  COALESCE(sum(
    CASE
      WHEN t.status <> 'POSTED' THEN 0
      WHEN t.transaction_type IN ('DEPOSIT','ADJUSTMENT') THEN t.amount
      WHEN t.transaction_type IN ('WITHDRAWAL','INTEREST_PAID') THEN -t.amount
      ELSE 0
    END
  ),0)::numeric(15,2) AS current_balance
FROM investors i
LEFT JOIN investor_transactions t ON t.investor_id = i.id
GROUP BY i.id, i.investor_name;

-- ============================================================
-- 19. SAFE WRITE FUNCTIONS FOR BACKEND
-- ============================================================

CREATE OR REPLACE FUNCTION create_payment(
  p_loan_id UUID,
  p_amount NUMERIC(15,2),
  p_payment_date DATE,
  p_payment_method TEXT,
  p_notes TEXT,
  p_user_id UUID,
  p_idempotency_key UUID DEFAULT gen_random_uuid()
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_id UUID;
  v_customer_id UUID;
  v_center_id UUID;
BEGIN
  PERFORM set_config('app.user_id', p_user_id::text, true);

  SELECT customer_id, center_id
    INTO v_customer_id, v_center_id
  FROM loans
  WHERE id = p_loan_id
  FOR UPDATE;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  INSERT INTO payments(
    idempotency_key,
    loan_id,
    customer_id,
    center_id,
    payment_date,
    amount,
    payment_method,
    notes,
    entered_by
  )
  VALUES(
    p_idempotency_key,
    p_loan_id,
    v_customer_id,
    v_center_id,
    p_payment_date,
    p_amount,
    p_payment_method,
    p_notes,
    p_user_id
  )
  RETURNING id INTO v_payment_id;

  PERFORM allocate_payment_fifo(v_payment_id);

  INSERT INTO cash_ledger(
    entry_date, direction, category, amount, payment_method,
    source_table, source_id, description, created_by
  )
  VALUES(
    p_payment_date, 'IN', 'COLLECTION', p_amount, p_payment_method,
    'payments', v_payment_id, 'Loan collection payment', p_user_id
  );

  RETURN v_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION void_payment(
  p_payment_id UUID,
  p_reason TEXT,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'Void reason is required';
  END IF;

  PERFORM set_config('app.user_id', p_user_id::text, true);

  UPDATE payments
  SET status = 'VOIDED',
      voided_at = now(),
      voided_by = p_user_id,
      void_reason = p_reason,
      edited_by = p_user_id
  WHERE id = p_payment_id
    AND status = 'POSTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Posted payment not found';
  END IF;

  DELETE FROM payment_allocations
  WHERE payment_id = p_payment_id;

  UPDATE cash_ledger
  SET status = 'VOIDED'
  WHERE source_table = 'payments'
    AND source_id = p_payment_id
    AND category = 'COLLECTION';
END;
$$;

CREATE OR REPLACE FUNCTION disburse_loan(
  p_loan_id UUID,
  p_disbursed_date DATE,
  p_payment_method TEXT,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_principal NUMERIC(15,2);
BEGIN
  PERFORM set_config('app.user_id', p_user_id::text, true);

  SELECT principal INTO v_principal
  FROM loans
  WHERE id = p_loan_id
  FOR UPDATE;

  IF v_principal IS NULL THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  UPDATE loans
  SET lifecycle_status = 'DISBURSED',
      disbursed_date = p_disbursed_date,
      updated_by = p_user_id
  WHERE id = p_loan_id
    AND lifecycle_status = 'PENDING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only PENDING loans can be disbursed';
  END IF;

  PERFORM generate_loan_schedule(p_loan_id);
  PERFORM add_default_loan_charges(p_loan_id, p_user_id);

  INSERT INTO cash_ledger(
    entry_date, direction, category, amount, payment_method,
    source_table, source_id, description, created_by
  )
  VALUES(
    p_disbursed_date, 'OUT', 'LOAN_DISBURSEMENT', v_principal, p_payment_method,
    'loans', p_loan_id, 'Loan principal disbursement', p_user_id
  )
  ON CONFLICT DO NOTHING;
END;
$$;

-- ============================================================
-- 20. SEED DEFAULT ROLES / PERMISSIONS
-- ============================================================

INSERT INTO roles(code, name)
VALUES
  ('ADMIN', 'Administrator'),
  ('STAFF', 'Staff')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions(code, description)
VALUES
  ('CUSTOMER_CREATE', 'Create customers'),
  ('CUSTOMER_EDIT', 'Edit customers'),
  ('CUSTOMER_VIEW', 'View customers'),
  ('LOAN_CREATE', 'Create loan applications'),
  ('LOAN_EDIT', 'Edit pending loans'),
  ('LOAN_DISBURSE', 'Disburse loans'),
  ('LOAN_VIEW', 'View loans'),
  ('PAYMENT_CREATE', 'Enter collection payments'),
  ('PAYMENT_EDIT', 'Edit/void payments'),
  ('REPORT_VIEW', 'View operational reports'),
  ('FINANCE_VIEW', 'View profit/cash/investor reports'),
  ('SETTINGS_MANAGE', 'Manage centers/groups/settings'),
  ('STAFF_MANAGE', 'Manage users and roles'),
  ('AUDIT_VIEW', 'View audit history'),
  ('BACKUP_MANAGE', 'Run/download backups')
ON CONFLICT (code) DO NOTHING;

-- ADMIN: all permissions
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

-- STAFF: intentionally limited
INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN (
  'CUSTOMER_CREATE','CUSTOMER_VIEW',
  'LOAN_CREATE','LOAN_VIEW',
  'PAYMENT_CREATE','REPORT_VIEW'
)
WHERE r.code = 'STAFF'
ON CONFLICT DO NOTHING;

-- ============================================================
-- 21. FINAL NOTES
-- ============================================================
-- Recommended backend transaction for a collection:
--
--   BEGIN;
--   SET LOCAL app.user_id = '<user-uuid>';
--   SELECT create_payment(...);
--   COMMIT;
--
-- Recommended loan flow:
--   1) INSERT loan with lifecycle_status='PENDING'
--   2) Add 2 guarantors if required
--   3) SELECT disburse_loan(...)
--      -> adjusts delayed repayment start
--      -> creates schedule
--      -> adds default DOC/INS/SERVICE charges
--      -> records disbursement in cash ledger
--
-- Arrears:
--   v_loan_financials.arrears_signed > 0 = arrears
--   v_loan_financials.arrears_signed < 0 = advance
--
-- Customer header:
--   v_customer_financials gives Total Payable / Paid / Balance / Arrears / Advance
--
-- Not Paid list:
--   v_not_paid_today gives today's due customers who have no posted payment.
--
-- IMPORTANT:
--   Actual automatic backups are configured at the hosting/database provider level.
--   backup_runs only records backup job status/history.

COMMIT;
