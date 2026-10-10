import crypto from 'crypto';
import { config } from '../config.js';

export function randomSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function requireTwoFactorKey() {
  if (!config.twoFactorKey) {
    const error = new Error(
      '2FA encryption key is not configured. Set TWO_FACTOR_ENCRYPTION_KEY first.'
    );
    error.code = 'TWO_FACTOR_KEY_MISSING';
    throw error;
  }
  return config.twoFactorKey;
}

export function encrypt2FASecret(secret) {
  const key = requireTwoFactorKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decrypt2FASecret(payload) {
  const key = requireTwoFactorKey();
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

  if (buffer.length < 29) {
    throw new Error('Invalid encrypted 2FA payload');
  }

  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8');
}
