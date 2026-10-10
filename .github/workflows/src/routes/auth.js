import express from 'express';
import argon2 from 'argon2';
import { rateLimit } from 'express-rate-limit';
import { generateSecret, generateURI, verify } from 'otplib';
import { z } from 'zod';

import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import {
  decrypt2FASecret,
  encrypt2FASecret,
  hashToken,
  randomSessionToken
} from '../lib/crypto.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
  device_label: z.string().trim().max(120).optional()
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);

    const result = await query(
      `
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.password_hash,
        u.status,
        u.two_factor_enabled,
        u.two_factor_secret_encrypted,
        u.locked_until,
        u.failed_login_count,
        r.code AS role_code
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE lower(u.username) = lower($1)
      LIMIT 1
      `,
      [body.username]
    );

    // Deliberately generic failure response.
    if (result.rowCount !== 1) {
      return res.status(401).json({ error: 'INVALID_LOGIN' });
    }

    const user = result.rows[0];

    if (user.status !== 'ACTIVE') {
      return res.status(401).json({ error: 'INVALID_LOGIN' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'ACCOUNT_TEMPORARILY_LOCKED' });
    }

    const passwordOk = await argon2.verify(user.password_hash, body.password);

    if (!passwordOk) {
      await query(
        `
        UPDATE users
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes'
              ELSE locked_until
            END
        WHERE id = $1
        `,
        [user.id]
      );
      return res.status(401).json({ error: 'INVALID_LOGIN' });
    }

    if (user.two_factor_enabled) {
      if (!body.totp) {
        return res.status(401).json({
          error: 'TWO_FACTOR_REQUIRED',
          two_factor_required: true
        });
      }

      if (!user.two_factor_secret_encrypted) {
        return res.status(500).json({ error: 'TWO_FACTOR_CONFIGURATION_ERROR' });
      }

      const secret = decrypt2FASecret(user.two_factor_secret_encrypted);
      const verification = await verify({
        secret,
        token: body.totp
      });

      if (!verification.valid) {
        return res.status(401).json({ error: 'INVALID_TWO_FACTOR_CODE' });
      }
    }

    const rawToken = randomSessionToken();
    const tokenHash = hashToken(rawToken);

    await withTransaction(user.id, async (client) => {
      await client.query(
        `
        UPDATE users
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = now()
        WHERE id = $1
        `,
        [user.id]
      );

      await client.query(
        `
        INSERT INTO user_sessions(
          user_id,
          token_hash,
          device_label,
          ip_address,
          user_agent,
          expires_at
        )
        VALUES(
          $1, $2, $3, $4, $5,
          now() + ($6::text || ' hours')::interval
        )
        `,
        [
          user.id,
          tokenHash,
          body.device_label || null,
          req.ip || null,
          req.get('user-agent') || null,
          config.SESSION_HOURS
        ]
      );
    });

    res.json({
      access_token: rawToken,
      token_type: 'Bearer',
      expires_in_hours: config.SESSION_HOURS,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role_code,
        two_factor_enabled: user.two_factor_enabled
      }
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({
    user: {
      id: req.auth.user_id,
      username: req.auth.username,
      full_name: req.auth.full_name,
      role: req.auth.role_code,
      two_factor_enabled: Boolean(req.auth.two_factor_enabled)
    }
  });
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await query(
      `UPDATE user_sessions SET revoked_at = now() WHERE id = $1`,
      [req.auth.session_id]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await query(
      `
      UPDATE user_sessions
      SET revoked_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL
      `,
      [req.auth.user_id]
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const secret = generateSecret();
    const encrypted = encrypt2FASecret(secret);

    await query(
      `
      UPDATE users
      SET two_factor_secret_encrypted = $2,
          two_factor_enabled = false
      WHERE id = $1
      `,
      [req.auth.user_id, encrypted]
    );

    const uri = generateURI({
      issuer: 'JK Investment',
      label: req.auth.username,
      secret
    });

    res.json({
      otpauth_uri: uri,
      message: 'Scan this URI/QR in an authenticator app, then confirm with a 6-digit code.'
    });
  } catch (error) {
    next(error);
  }
});

const confirm2faSchema = z.object({
  token: z.string().regex(/^\d{6}$/)
});

const toggle2faSchema = z.object({
  enabled: z.boolean(),
  password: z.string().min(8).max(200),
  token: z.string().regex(/^\d{6}$/)
});

authRouter.post('/2fa/toggle', requireAuth, async (req, res, next) => {
  try {
    const body = toggle2faSchema.parse(req.body);

    const result = await query(
      `
      SELECT password_hash, two_factor_enabled, two_factor_secret_encrypted
      FROM users
      WHERE id = $1 AND status = 'ACTIVE'
      LIMIT 1
      `,
      [req.auth.user_id]
    );

    if (result.rowCount !== 1) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }

    const user = result.rows[0];
    const passwordOk = await argon2.verify(user.password_hash, body.password);
    if (!passwordOk) {
      return res.status(400).json({ error: 'INVALID_PASSWORD' });
    }

    if (!user.two_factor_secret_encrypted) {
      return res.status(400).json({ error: 'TWO_FACTOR_SETUP_REQUIRED' });
    }

    const secret = decrypt2FASecret(user.two_factor_secret_encrypted);
    const verification = await verify({ secret, token: body.token });
    if (!verification.valid) {
      return res.status(400).json({ error: 'INVALID_TWO_FACTOR_CODE' });
    }

    await query(
      `UPDATE users SET two_factor_enabled = $2 WHERE id = $1`,
      [req.auth.user_id, body.enabled]
    );

    res.json({ ok: true, two_factor_enabled: body.enabled });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/2fa/confirm', requireAuth, async (req, res, next) => {
  try {
    const body = confirm2faSchema.parse(req.body);

    const result = await query(
      `SELECT two_factor_secret_encrypted FROM users WHERE id = $1`,
      [req.auth.user_id]
    );

    const encrypted = result.rows[0]?.two_factor_secret_encrypted;
    if (!encrypted) {
      return res.status(400).json({ error: 'TWO_FACTOR_SETUP_NOT_STARTED' });
    }

    const secret = decrypt2FASecret(encrypted);
    const verification = await verify({ secret, token: body.token });

    if (!verification.valid) {
      return res.status(400).json({ error: 'INVALID_TWO_FACTOR_CODE' });
    }

    await query(
      `UPDATE users SET two_factor_enabled = true WHERE id = $1`,
      [req.auth.user_id]
    );

    res.json({ ok: true, two_factor_enabled: true });
  } catch (error) {
    next(error);
  }
});
