import { query } from '../db.js';
import { hashToken } from '../lib/crypto.js';

export async function requireAuth(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    let rawToken = '';

    if (auth.startsWith('Bearer ')) {
      rawToken = auth.slice(7).trim();
    } else {
      const cookieHeader = String(req.headers.cookie || '');
      for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();

        if (key === 'jk_app_session') {
          try {
            rawToken = decodeURIComponent(value);
          } catch {
            rawToken = value;
          }
          break;
        }
      }
    }

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
