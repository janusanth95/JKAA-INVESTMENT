
import express from 'express';

import { query } from './db.js';
import { requireAuth, requirePermission } from './middleware/auth.js';

export const auditRouter = express.Router();
auditRouter.use(requireAuth);

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'two_factor_secret',
  'two_factor_secret_encrypted',
  'token',
  'token_hash',
  'session_token',
  'otp',
  'api_key',
  'secret',
  'encryption_key'
]);

function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const output = {};

  for (const [key, child] of Object.entries(value)) {
    const normalized = String(key).toLowerCase();

    if (
      SENSITIVE_KEYS.has(normalized) ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('token_hash')
    ) {
      output[key] = '[REDACTED]';
      continue;
    }

    output[key] = redactSensitive(child);
  }

  return output;
}

function dateText(value) {
  return String(value || '').slice(0, 10);
}

function parseLimit(value) {
  const n = Number(value || 250);
  if (!Number.isFinite(n)) return 250;
  return Math.max(25, Math.min(Math.floor(n), 500));
}

auditRouter.get(
  '/',
  requirePermission('AUDIT_VIEW'),
  async (req, res, next) => {
    try {
      const now = await query(`
        SELECT
          (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today,
          (
            (now() AT TIME ZONE 'Asia/Colombo')::date - INTERVAL '30 days'
          )::date::text AS default_from
      `);

      const from = dateText(req.query.from || now.rows[0].default_from);
      const to = dateText(req.query.to || now.rows[0].today);
      const action = String(req.query.action || 'ALL').toUpperCase();
      const tableName = String(req.query.table_name || 'ALL').trim();
      const actorUserId = String(req.query.actor_user_id || 'ALL').trim();
      const search = String(req.query.search || '').trim();
      const limit = parseLimit(req.query.limit);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: 'Invalid date filter.' });
      }

      if (from > to) {
        return res.status(400).json({ error: 'From date cannot be after To date.' });
      }

      if (!['ALL', 'INSERT', 'UPDATE', 'DELETE'].includes(action)) {
        return res.status(400).json({ error: 'Invalid audit action.' });
      }

      const result = await query(
        `
        SELECT
          a.id,
          a.actor_user_id,
          COALESCE(u.full_name, u.username, 'SYSTEM') AS actor_name,
          COALESCE(r.code, 'SYSTEM') AS actor_role,
          a.action,
          a.table_name,
          a.record_id,
          a.old_data,
          a.new_data,
          a.created_at,
          to_char(
            a.created_at AT TIME ZONE 'Asia/Colombo',
            'YYYY-MM-DD HH12:MI:SS AM'
          ) AS created_at_colombo
        FROM audit_logs a
        LEFT JOIN users u ON u.id=a.actor_user_id
        LEFT JOIN roles r ON r.id=u.role_id
        WHERE
          (a.created_at AT TIME ZONE 'Asia/Colombo')::date
            BETWEEN $1::date AND $2::date
          AND ($3='ALL' OR a.action=$3)
          AND ($4='ALL' OR a.table_name=$4)
          AND ($5='ALL' OR a.actor_user_id::text=$5)
          AND (
            $6=''
            OR COALESCE(a.record_id::text,'') ILIKE '%' || $6 || '%'
            OR COALESCE(a.old_data::text,'') ILIKE '%' || $6 || '%'
            OR COALESCE(a.new_data::text,'') ILIKE '%' || $6 || '%'
          )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $7
        `,
        [from, to, action, tableName, actorUserId, search, limit]
      );

      const rows = result.rows.map(row => ({
        ...row,
        old_data: redactSensitive(row.old_data),
        new_data: redactSensitive(row.new_data)
      }));

      const summaryResult = await query(
        `
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE action='INSERT')::integer AS inserts,
          count(*) FILTER (WHERE action='UPDATE')::integer AS updates,
          count(*) FILTER (WHERE action='DELETE')::integer AS deletes
        FROM audit_logs
        WHERE
          (created_at AT TIME ZONE 'Asia/Colombo')::date
            BETWEEN $1::date AND $2::date
          AND ($3='ALL' OR action=$3)
          AND ($4='ALL' OR table_name=$4)
          AND ($5='ALL' OR actor_user_id::text=$5)
          AND (
            $6=''
            OR COALESCE(record_id::text,'') ILIKE '%' || $6 || '%'
            OR COALESCE(old_data::text,'') ILIKE '%' || $6 || '%'
            OR COALESCE(new_data::text,'') ILIKE '%' || $6 || '%'
          )
        `,
        [from, to, action, tableName, actorUserId, search]
      );

      const meta = await query(`
        SELECT
          ARRAY(
            SELECT DISTINCT table_name
            FROM audit_logs
            ORDER BY table_name
          ) AS tables,
          COALESCE(
            json_agg(actor_row ORDER BY actor_row.actor_name)
              FILTER (WHERE actor_row.actor_user_id IS NOT NULL),
            '[]'::json
          ) AS actors
        FROM (
          SELECT DISTINCT
            u.id AS actor_user_id,
            COALESCE(u.full_name,u.username) AS actor_name,
            COALESCE(r.code,'') AS actor_role
          FROM audit_logs a
          JOIN users u ON u.id=a.actor_user_id
          LEFT JOIN roles r ON r.id=u.role_id
        ) actor_row
      `);

      res.json({
        filters: {
          from,
          to,
          action,
          table_name: tableName,
          actor_user_id: actorUserId,
          search,
          limit
        },
        summary: summaryResult.rows[0],
        tables: meta.rows[0]?.tables || [],
        actors: meta.rows[0]?.actors || [],
        logs: rows
      });
    } catch (error) {
      next(error);
    }
  }
);

auditRouter.get(
  '/:id',
  requirePermission('AUDIT_VIEW'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid audit log ID.' });
      }

      const result = await query(
        `
        SELECT
          a.id,
          a.actor_user_id,
          COALESCE(u.full_name,u.username,'SYSTEM') AS actor_name,
          COALESCE(r.code,'SYSTEM') AS actor_role,
          a.action,
          a.table_name,
          a.record_id,
          a.old_data,
          a.new_data,
          a.created_at,
          to_char(
            a.created_at AT TIME ZONE 'Asia/Colombo',
            'YYYY-MM-DD HH12:MI:SS AM'
          ) AS created_at_colombo
        FROM audit_logs a
        LEFT JOIN users u ON u.id=a.actor_user_id
        LEFT JOIN roles r ON r.id=u.role_id
        WHERE a.id=$1
        `,
        [id]
      );

      if (result.rowCount !== 1) {
        return res.status(404).json({ error: 'Audit log not found.' });
      }

      const row = result.rows[0];

      res.json({
        audit: {
          ...row,
          old_data: redactSensitive(row.old_data),
          new_data: redactSensitive(row.new_data)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);
