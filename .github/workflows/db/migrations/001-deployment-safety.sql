BEGIN;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS whatsapp_jobs (
  payment_id UUID PRIMARY KEY REFERENCES payments(id),
  actor_user_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','SKIPPED','REVIEW','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  last_reason TEXT,
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_jobs_ready ON whatsapp_jobs(available_at) WHERE status='PENDING';
COMMIT;
