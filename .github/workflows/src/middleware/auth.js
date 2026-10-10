import { query } from '../db.js';
import { hashToken } from '../lib/crypto.js';

export async function requireAuth(req, res, next) {
  try {
    const auth = req.get('authorization') || '';

    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }

    const rawToken = auth.slice(7).trim();
    if (!rawToken) {
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }

    const tokenHash = hashToken(rawToken);

    const result = await query(
      `
      SELECT
        s.id AS session_id,
        s.user_id,
        u.username,
        u.full_name,
        u.status,
        u.two_factor_enabled,
        r.code AS role_code,
        r.name AS role_name
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'ACTIVE'
      LIMIT 1
      `,
      [tokenHash]
    );

    if (result.rowCount !== 1) {
      return res.status(401).json({ error: 'SESSION_INVALID_OR_EXPIRED' });
    }

    req.auth = {
      ...result.rows[0],
      rawToken,
      tokenHash
    };

    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permissionCode) {
  return async function permissionMiddleware(req, res, next) {
    try {
      const result = await query(
        `
        SELECT 1
        FROM users u
        JOIN role_permissions rp ON rp.role_id = u.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = $1
          AND p.code = $2
        LIMIT 1
        `,
        [req.auth.user_id, permissionCode]
      );

      if (result.rowCount !== 1) {
        return res.status(403).json({
          error: 'PERMISSION_DENIED',
          permission: permissionCode
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
