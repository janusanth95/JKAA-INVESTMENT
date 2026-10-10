import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['true', 'false']).default('true'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  SESSION_HOURS: z.coerce.number().positive().max(720).default(12),

  // Optional for the first staging deploy.
  // REQUIRED before enabling 2FA.
  TWO_FACTOR_ENCRYPTION_KEY: z.string().optional().default(''),

  // One-time bootstrap secret for creating the FIRST admin.
  // Remove it from Vercel after bootstrap succeeds.
  BOOTSTRAP_SECRET: z.string().optional().default(''),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),

WHATSAPP_ACCESS_TOKEN:
  z.string().optional().default(''),

WHATSAPP_PHONE_NUMBER_ID:
  z.string().optional().default(''),

WHATSAPP_PAYMENT_TEMPLATE:
  z.string().default('payment_received'),

WHATSAPP_TEMPLATE_LANGUAGE:
  z.string().default('en_US')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const raw = parsed.data;
let twoFactorKey = null;

if (raw.TWO_FACTOR_ENCRYPTION_KEY) {
  const decoded = Buffer.from(raw.TWO_FACTOR_ENCRYPTION_KEY, 'base64');
  if (decoded.length !== 32) {
    throw new Error('TWO_FACTOR_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  twoFactorKey = decoded;
}

const configuredCorsOrigins = raw.CORS_ORIGINS
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

const requiredProductionOrigins = [
  'https://jkinvestment.com.lk',
  'https://www.jkinvestment.com.lk',
  'https://jkinvestment.lk',
  'https://www.jkinvestment.lk'
];

export const config = {
  ...raw,
  databaseSsl: raw.DATABASE_SSL === 'true',
  corsOrigins: [...new Set([...configuredCorsOrigins, ...requiredProductionOrigins])],
  twoFactorKey
};
