import express from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const customersRouter = express.Router();

customersRouter.use(requireAuth);

customersRouter.get(
  '/',
  requirePermission('CUSTOMER_VIEW'),
  async (req, res, next) => {
    try {
      const centerId = req.query.center_id || null;
      const groupId = req.query.group_id || null;
      const search = typeof req.query.search === 'string'
        ? req.query.search.trim()
        : '';

      const result = await query(
        `
        SELECT
          c.id,
          c.customer_code,
          c.customer_name,
          c.nic,
          c.mobile,
          c.default_guarantor_name,
          c.default_guarantor_nic,
          c.default_guarantor_mobile,
          c.center_id,
          ce.center_name,
          c.group_id,
          g.group_name,
          c.status,
          cf.total_loan_payable,
          cf.total_paid,
          cf.total_balance,
          cf.total_arrears,
          cf.total_advance
        FROM customers c
        JOIN centers ce ON ce.id = c.center_id
        JOIN groups g ON g.id = c.group_id
        LEFT JOIN v_customer_financials cf ON cf.customer_id = c.id
        WHERE ($1::uuid IS NULL OR c.center_id = $1)
          AND ($2::uuid IS NULL OR c.group_id = $2)
          AND (
            $3 = ''
            OR c.customer_name ILIKE '%' || $3 || '%'
            OR c.customer_code ILIKE '%' || $3 || '%'
            OR c.nic ILIKE '%' || $3 || '%'
            OR COALESCE(c.mobile,'') ILIKE '%' || $3 || '%'
          )
        ORDER BY c.customer_name
        LIMIT 500
        `,
        [centerId, groupId, search]
      );

      res.json({ customers: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

const createCustomerSchema = z.object({
  center_id: z.string().uuid(),
  group_id: z.string().uuid(),
  customer_name: z.string().trim().min(2).max(200),
  nic: z.string().trim().min(5).max(50),
  mobile: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  guarantor_name: z.string().trim().max(200).optional().nullable(),
  guarantor_nic: z.string().trim().max(50).optional().nullable(),
  guarantor_mobile: z.string().trim().max(30).optional().nullable()
});

customersRouter.post(
  '/',
  requirePermission('CUSTOMER_CREATE'),
  async (req, res, next) => {
    try {
      const body = createCustomerSchema.parse(req.body);

      const customer = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          INSERT INTO customers(
            center_id, group_id,
            customer_name, nic, mobile, address,
            default_guarantor_name,
            default_guarantor_nic,
            default_guarantor_mobile,
            created_by, updated_by
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
          RETURNING *
          `,
          [
            body.center_id,
            body.group_id,
            body.customer_name,
            body.nic,
            body.mobile || null,
            body.address || null,
            body.guarantor_name || null,
            body.guarantor_nic || null,
            body.guarantor_mobile || null,
            req.auth.user_id
          ]
        );
        return result.rows[0];
      });

      res.status(201).json({ customer });
    } catch (error) {
      next(error);
    }
  }
);

customersRouter.get(
  '/:id',
  requirePermission('CUSTOMER_VIEW'),
  async (req, res, next) => {
    try {
      const result = await query(
        `
        SELECT
          c.*,
          ce.center_name,
          g.group_name,
          cf.total_loan_payable,
          cf.total_paid,
          cf.total_balance,
          cf.total_arrears,
          cf.total_advance
        FROM customers c
        JOIN centers ce ON ce.id = c.center_id
        JOIN groups g ON g.id = c.group_id
        LEFT JOIN v_customer_financials cf ON cf.customer_id = c.id
        WHERE c.id = $1
        `,
        [req.params.id]
      );

      if (result.rowCount !== 1) {
        return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND' });
      }

      const loans = await query(
        `
        SELECT *
        FROM v_loan_financials
        WHERE customer_id = $1
        ORDER BY loan_code DESC
        `,
        [req.params.id]
      );

      res.json({
        customer: result.rows[0],
        loans: loans.rows
      });
    } catch (error) {
      next(error);
    }
  }
);

const updateCustomerSchema = z.object({
  center_id: z.string().uuid(),
  group_id: z.string().uuid(),
  customer_name: z.string().trim().min(2).max(200),
  nic: z.string().trim().min(5).max(50),
  mobile: z.string().trim().max(30).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  guarantor_name: z.string().trim().max(200).optional().nullable(),
  guarantor_nic: z.string().trim().max(50).optional().nullable(),
  guarantor_mobile: z.string().trim().max(30).optional().nullable()
});

customersRouter.put(
  '/:id',
  requirePermission('CUSTOMER_EDIT'),
  async (req, res, next) => {
    try {
      const body = updateCustomerSchema.parse(req.body);

      const customer = await withTransaction(req.auth.user_id, async (client) => {
        const existing = await client.query(
          `SELECT id,status FROM customers WHERE id=$1 FOR UPDATE`,
          [req.params.id]
        );

        if (existing.rowCount !== 1) {
          const error = new Error('Customer not found');
          error.code = 'P0001';
          throw error;
        }

        const result = await client.query(
          `
          UPDATE customers
          SET center_id=$2,
              group_id=$3,
              customer_name=$4,
              nic=$5,
              mobile=$6,
              address=$7,
              default_guarantor_name=$8,
              default_guarantor_nic=$9,
              default_guarantor_mobile=$10,
              updated_by=$11,
              updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [
            req.params.id,
            body.center_id,
            body.group_id,
            body.customer_name,
            body.nic,
            body.mobile || null,
            body.address || null,
            body.guarantor_name || null,
            body.guarantor_nic || null,
            body.guarantor_mobile || null,
            req.auth.user_id
          ]
        );

        return result.rows[0];
      });

      res.json({ customer });
    } catch (error) {
      next(error);
    }
  }
);

customersRouter.post(
  '/:id/deactivate',
  requirePermission('CUSTOMER_EDIT'),
  async (req, res, next) => {
    try {
      const customer = await withTransaction(req.auth.user_id, async (client) => {
        const financial = await client.query(
          `
          SELECT c.id,c.status,COALESCE(cf.total_balance,0) AS total_balance
          FROM customers c
          LEFT JOIN v_customer_financials cf ON cf.customer_id=c.id
          WHERE c.id=$1
          FOR UPDATE OF c
          `,
          [req.params.id]
        );

        if (financial.rowCount !== 1) {
          const error = new Error('Customer not found');
          error.code = 'P0001';
          throw error;
        }

        if (Number(financial.rows[0].total_balance) > 0) {
          const error = new Error('Customer cannot be deactivated while a loan balance is outstanding.');
          error.code = 'P0001';
          throw error;
        }

        const result = await client.query(
          `
          UPDATE customers
          SET status='INACTIVE',updated_by=$2,updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [req.params.id, req.auth.user_id]
        );
        return result.rows[0];
      });

      res.json({ customer });
    } catch (error) {
      next(error);
    }
  }
);

customersRouter.post(
  '/:id/reactivate',
  requirePermission('CUSTOMER_EDIT'),
  async (req, res, next) => {
    try {
      const customer = await withTransaction(req.auth.user_id, async (client) => {
        const result = await client.query(
          `
          UPDATE customers
          SET status='ACTIVE',updated_by=$2,updated_at=now()
          WHERE id=$1
          RETURNING *
          `,
          [req.params.id, req.auth.user_id]
        );
        if (result.rowCount !== 1) {
          const error = new Error('Customer not found');
          error.code = 'P0001';
          throw error;
        }
        return result.rows[0];
      });
      res.json({ customer });
    } catch (error) {
      next(error);
    }
  }
);
