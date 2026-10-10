import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const organizationRouter = express.Router();
organizationRouter.use(requireAuth);

organizationRouter.get('/centers', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM centers ORDER BY center_name`
    );
    res.json({ centers: result.rows });
  } catch (error) {
    next(error);
  }
});

organizationRouter.get('/centers/:id', async (req, res, next) => {
  try {
    const result = await query(
      `
      SELECT
        c.*,
        COALESCE((
          SELECT count(*) FROM groups g
          WHERE g.center_id=c.id AND g.status='ACTIVE'
        ),0)::int AS groups_count,
        COALESCE((
          SELECT count(*) FROM customers cu
          WHERE cu.center_id=c.id AND cu.status='ACTIVE'
        ),0)::int AS customers_count,
        COALESCE((
          SELECT count(*) FROM loans l
          WHERE l.center_id=c.id
            AND l.lifecycle_status='DISBURSED'
            AND EXISTS (
              SELECT 1
              FROM v_loan_financials vf
              WHERE vf.loan_id=l.id
                AND COALESCE(vf.balance,0) > 0
            )
        ),0)::int AS active_loans_count
      FROM centers c
      WHERE c.id=$1
      `,
      [req.params.id]
    );

    if (result.rowCount !== 1) {
      return res.status(404).json({ error: 'CENTER_NOT_FOUND' });
    }

    res.json({ center: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

organizationRouter.get('/groups', async (req, res, next) => {
  try {
    const centerId = req.query.center_id || null;
    const result = await query(
      `
      SELECT g.*, c.center_name
      FROM groups g
      JOIN centers c ON c.id = g.center_id
      WHERE ($1::uuid IS NULL OR g.center_id = $1)
      ORDER BY c.center_name, g.group_name
      `,
      [centerId]
    );
    res.json({ groups: result.rows });
  } catch (error) {
    next(error);
  }
});

const centerSchema = z.object({
  center_name: z.string().trim().min(2).max(200),
  address: z.string().trim().max(500).optional().nullable(),
  collection_isodow: z.coerce.number().int().min(1).max(7)
});

const centerUpdateSchema = z.object({
  center_name: z.string().trim().min(2).max(200).optional(),
  address: z.string().trim().max(500).optional().nullable(),
  collection_isodow: z.coerce.number().int().min(1).max(7).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional()
}).refine(
  value => Object.keys(value).length > 0,
  { message: 'At least one center field is required.' }
);

organizationRouter.post(
  '/centers',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = centerSchema.parse(req.body);
      const row = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          INSERT INTO centers(center_name,address,collection_isodow,created_by)
          VALUES($1,$2,$3,$4)
          RETURNING *
          `,
          [
            body.center_name,
            body.address || null,
            body.collection_isodow,
            req.auth.user_id
          ]
        );
        return result.rows[0];
      });
      res.status(201).json({ center: row });
    } catch (error) {
      next(error);
    }
  }
);

async function updateCenter(req, res, next) {
  try {
    const body = centerUpdateSchema.parse(req.body);

    const center = await withTransaction(req.auth.user_id, async (client) => {
      const existing = await client.query(
        `SELECT * FROM centers WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );

      if (existing.rowCount !== 1) {
        const error = new Error('Center not found.');
        error.code = 'P0001';
        throw error;
      }

      const current = existing.rows[0];
      const result = await client.query(
        `
        UPDATE centers
        SET
          center_name=$2,
          address=$3,
          collection_isodow=$4,
          status=$5,
          updated_at=now()
        WHERE id=$1
        RETURNING *
        `,
        [
          req.params.id,
          body.center_name ?? current.center_name,
          body.address !== undefined ? (body.address || null) : current.address,
          body.collection_isodow ?? current.collection_isodow,
          body.status ?? current.status
        ]
      );

      return result.rows[0];
    });

    res.json({ center });
  } catch (error) {
    next(error);
  }
}

organizationRouter.put(
  '/centers/:id',
  requirePermission('SETTINGS_MANAGE'),
  updateCenter
);

organizationRouter.patch(
  '/centers/:id',
  requirePermission('SETTINGS_MANAGE'),
  updateCenter
);

const groupSchema = z.object({
  center_id: z.string().uuid(),
  group_name: z.string().trim().min(1).max(200),
  members_count: z.coerce.number().int().min(0).optional().nullable()
});

organizationRouter.post(
  '/groups',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = groupSchema.parse(req.body);
      const row = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          INSERT INTO groups(center_id,group_name,members_count,created_by)
          VALUES($1,$2,$3,$4)
          RETURNING *
          `,
          [
            body.center_id,
            body.group_name,
            body.members_count ?? null,
            req.auth.user_id
          ]
        );
        return result.rows[0];
      });
      res.status(201).json({ group: row });
    } catch (error) {
      next(error);
    }
  }
);
