
import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const organizationRouter = express.Router();

organizationRouter.use(requireAuth);

const centerCreateSchema = z.object({
  center_name: z.string().trim().min(2).max(200),
  address: z.string().trim().max(500).optional().nullable(),
  collection_isodow: z.coerce.number().int().min(1).max(7)
});

const centerUpdateSchema = z.object({
  center_name: z.string().trim().min(2).max(200).optional(),
  address: z.string().trim().max(500).optional().nullable(),
  collection_isodow: z.coerce.number().int().min(1).max(7).optional(),
  status: z.enum(['ACTIVE','INACTIVE']).optional()
}).refine(
  value => Object.keys(value).length > 0,
  { message: 'At least one center field is required.' }
);

const groupCreateSchema = z.object({
  center_id: z.string().uuid(),
  group_name: z.string().trim().min(1).max(200),
  members_count: z.coerce.number().int().min(0).optional().default(0)
});


const groupUpdateSchema = z.object({
  center_id: z.string().uuid().optional(),
  group_name: z.string().trim().min(1).max(200).optional(),
  members_count: z.coerce.number().int().min(0).optional(),
  status: z.enum(['ACTIVE','INACTIVE']).optional()
}).refine(
  value => Object.keys(value).length > 0,
  { message: 'At least one group field is required.' }
);

// ------------------------------------------------------------
// CENTERS
// ------------------------------------------------------------
organizationRouter.get('/centers', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT
        c.id,
        c.center_code,
        c.center_name,
        c.address,
        c.collection_isodow,
        c.status,
        c.created_at,
        c.updated_at
      FROM centers c
      ORDER BY
        CASE WHEN c.status='ACTIVE' THEN 0 ELSE 1 END,
        c.center_name
    `);

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

organizationRouter.post(
  '/centers',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = centerCreateSchema.parse(req.body);

      const center = await withTransaction(req.auth.user_id, async client => {
        const result = await client.query(
          `
          INSERT INTO centers(
            center_name,
            address,
            collection_isodow,
            created_by
          )
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

      res.status(201).json({ center });
    } catch (error) {
      next(error);
    }
  }
);

organizationRouter.put(
  '/centers/:id',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = centerUpdateSchema.parse(req.body);

      const center = await withTransaction(req.auth.user_id, async client => {
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
);

organizationRouter.delete(
  '/centers/:id',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const deleted = await withTransaction(req.auth.user_id, async client => {
        const center = await client.query(
          `SELECT id,center_name FROM centers WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );

        if (center.rowCount !== 1) {
          const error = new Error('Center not found.');
          error.code = 'P0001';
          throw error;
        }

        const related = await client.query(
          `
          SELECT
            (SELECT count(*) FROM groups WHERE center_id=$1)::int AS groups,
            (SELECT count(*) FROM customers WHERE center_id=$1)::int AS customers,
            (SELECT count(*) FROM loans WHERE center_id=$1)::int AS loans
          `,
          [req.params.id]
        );

        const counts = related.rows[0];

        if (
          Number(counts.groups) > 0 ||
          Number(counts.customers) > 0 ||
          Number(counts.loans) > 0
        ) {
          const error = new Error(
            'This Center has Group / Customer / Loan data. It cannot be deleted.'
          );
          error.code = 'P0001';
          throw error;
        }

        await client.query(`DELETE FROM centers WHERE id=$1`, [req.params.id]);

        return {
          id: center.rows[0].id,
          center_name: center.rows[0].center_name
        };
      });

      res.json({ deleted: true, center: deleted });
    } catch (error) {
      next(error);
    }
  }
);

// ------------------------------------------------------------
// GROUPS — existing create/list flow preserved.
// ------------------------------------------------------------
organizationRouter.get('/groups', async (req, res, next) => {
  try {
    const centerId = req.query.center_id || null;

    const result = await query(
      `
      SELECT
        g.id,
        g.group_code,
        g.group_name,
        g.members_count,
        g.status,
        g.center_id,
        c.center_code,
        c.center_name,
        g.created_at,
        g.updated_at
      FROM groups g
      JOIN centers c ON c.id=g.center_id
      WHERE ($1::uuid IS NULL OR g.center_id=$1)
      ORDER BY
        CASE WHEN g.status='ACTIVE' THEN 0 ELSE 1 END,
        c.center_name,
        g.group_name
      `,
      [centerId]
    );

    res.json({ groups: result.rows });
  } catch (error) {
    next(error);
  }
});

organizationRouter.post(
  '/groups',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = groupCreateSchema.parse(req.body);

      const group = await withTransaction(req.auth.user_id, async client => {
        const center = await client.query(
          `SELECT id,status FROM centers WHERE id=$1`,
          [body.center_id]
        );

        if (center.rowCount !== 1 || center.rows[0].status !== 'ACTIVE') {
          const error = new Error('Please select an active Center.');
          error.code = 'P0001';
          throw error;
        }

        const result = await client.query(
          `
          INSERT INTO groups(
            center_id,
            group_name,
            members_count,
            created_by
          )
          VALUES($1,$2,$3,$4)
          RETURNING *
          `,
          [
            body.center_id,
            body.group_name,
            body.members_count,
            req.auth.user_id
          ]
        );

        return result.rows[0];
      });

      res.status(201).json({ group });
    } catch (error) {
      next(error);
    }
  }
);
organizationRouter.get('/groups/:id', async (req, res, next) => {
  try {
    const result = await query(
      `
      SELECT
        g.*,
        c.center_code,
        c.center_name,
        COALESCE((
          SELECT count(*)
          FROM customers cu
          WHERE cu.group_id=g.id
            AND cu.status='ACTIVE'
        ),0)::int AS customers_count,
        COALESCE((
          SELECT count(*)
          FROM loans l
          JOIN v_loan_financials vf ON vf.loan_id=l.id
          WHERE l.group_id=g.id
            AND l.lifecycle_status='DISBURSED'
            AND COALESCE(vf.balance,0)>0
        ),0)::int AS active_loans_count
      FROM groups g
      JOIN centers c ON c.id=g.center_id
      WHERE g.id=$1
      `,
      [req.params.id]
    );

    if (result.rowCount !== 1) {
      return res.status(404).json({ error: 'GROUP_NOT_FOUND' });
    }

    res.json({ group: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

organizationRouter.put(
  '/groups/:id',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const body = groupUpdateSchema.parse(req.body);

      const group = await withTransaction(req.auth.user_id, async client => {
        const existing = await client.query(
          `SELECT * FROM groups WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );

        if (existing.rowCount !== 1) {
          const error = new Error('Group not found.');
          error.code = 'P0001';
          throw error;
        }

        const current = existing.rows[0];
        const nextCenterId = body.center_id ?? current.center_id;

        if (String(nextCenterId) !== String(current.center_id)) {
          const related = await client.query(
            `
            SELECT
              (SELECT count(*) FROM customers WHERE group_id=$1)::int AS customers,
              (SELECT count(*) FROM loans WHERE group_id=$1)::int AS loans
            `,
            [req.params.id]
          );

          if (
            Number(related.rows[0].customers) > 0 ||
            Number(related.rows[0].loans) > 0
          ) {
            const error = new Error(
              'This Group already has Customer / Loan data. Its Center cannot be changed.'
            );
            error.code = 'P0001';
            throw error;
          }
        }

        const center = await client.query(
          `SELECT id,status FROM centers WHERE id=$1`,
          [nextCenterId]
        );

        if (center.rowCount !== 1 || center.rows[0].status !== 'ACTIVE') {
          const error = new Error('Please select an active Center.');
          error.code = 'P0001';
          throw error;
        }

        const result = await client.query(
          `
          UPDATE groups
          SET
            center_id=$2,
            group_name=$3,
            members_count=$4,
            status=$5,
            updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            nextCenterId,
            body.group_name ?? current.group_name,
            body.members_count ?? current.members_count,
            body.status ?? current.status
          ]
        );

        return result.rows[0];
      });

      res.json({ group });
    } catch (error) {
      next(error);
    }
  }
);

organizationRouter.delete(
  '/groups/:id',
  requirePermission('SETTINGS_MANAGE'),
  async (req, res, next) => {
    try {
      const deleted = await withTransaction(req.auth.user_id, async client => {
        const group = await client.query(
          `SELECT id,group_name FROM groups WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );

        if (group.rowCount !== 1) {
          const error = new Error('Group not found.');
          error.code = 'P0001';
          throw error;
        }

        const related = await client.query(
          `
          SELECT
            (SELECT count(*) FROM customers WHERE group_id=$1)::int AS customers,
            (SELECT count(*) FROM loans WHERE group_id=$1)::int AS loans
          `,
          [req.params.id]
        );

        if (
          Number(related.rows[0].customers) > 0 ||
          Number(related.rows[0].loans) > 0
        ) {
          const error = new Error(
            'This Group has Customer / Loan data. It cannot be deleted.'
          );
          error.code = 'P0001';
          throw error;
        }

        await client.query(`DELETE FROM groups WHERE id=$1`, [req.params.id]);

        return {
          id: group.rows[0].id,
          group_name: group.rows[0].group_name
        };
      });

      res.json({ deleted: true, group: deleted });
    } catch (error) {
      next(error);
    }
  }
);
