import express from 'express';
import './group-view-members-patch.js';
import './protected-form-popups-patch.js';
import './daily-closing-ui-patch.js';
import './pending-loans-ui-patch.js';
import './agreement-guarantor-dropdown-patch.js';
import './premium-customer-view-patch.js';
import './monthly-profit-ui-patch.js';
import cors from 'cors';
import helmet from 'helmet';
import argon2 from 'argon2';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify } from 'otplib';
import { z } from 'zod';

import { config } from './config.js';
import { pool, query, withTransaction } from './db.js';
import { authRouter } from './routes/auth.js';
import { customersRouter } from './routes/customers.js';
import { organizationRouter } from './routes/organization.js';
import { loansRouter } from './routes/loans.js';
import { paymentsRouter } from './routes/payments.js';
import { dashboardRouter } from './routes/dashboard.js';
import { financeRouter } from './finance.js';
import { reportsRouter } from './reports.js';
import { importerRouter } from './importer.js';
import { documentsRouter } from './documents.js';
import { agreementPdfRouter } from './agreement-pdf.js';
import { backupRouter, cloudDailyBackupHandler } from './backup.js';
import { auditRouter } from './audit.js';
import { salaryAdvanceRouter } from './salary-advance.js';
import { dailyClosingRouter } from './daily-closing.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { decrypt2FASecret, encrypt2FASecret, hashToken, randomSessionToken } from './lib/crypto.js';
import { registerAppUi } from './app-ui.js';
import { registerPublicLegalPages } from './public-legal.js';

import { enqueuePaymentWhatsApp, scheduleWhatsAppDrain, whatsappCronHandler } from './payment-whatsapp.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// Browser-only diagnostic pages must never be exposed in production.
app.use((req, res, next) => {
  if (
    config.NODE_ENV === 'production' &&
    (
      req.path === '/login-test' ||
      req.path === '/secure-login-test' ||
      req.path.startsWith('/staging-test')
    )
  ) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }

  return next();
});

app.get('/', (req, res) => {
  res.json({
    service: 'JK Investment Backend API',
    ok: true
  });
});

app.get('/health', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        now() AS database_time,
        current_database() AS database_name
    `);

    res.json({
      ok: true,
      service: 'jk-investment-backend',
      database: result.rows[0].database_name,
      database_time: result.rows[0].database_time
    });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------
// ONE-TIME FIRST ADMIN BOOTSTRAP
// Security:
// - Requires BOOTSTRAP_SECRET header.
// - Only works when users table has ZERO users.
// - After successful creation, REMOVE BOOTSTRAP_SECRET from Vercel.
// ------------------------------------------------------------
const bootstrapSchema = z.object({
  username: z.string().trim().min(3).max(100),
  full_name: z.string().trim().min(2).max(150),
  password: z.string().min(12).max(200)
});

app.post('/api/bootstrap/admin', async (req, res, next) => {
  try {
    if (!config.BOOTSTRAP_SECRET) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }

    const provided = req.get('x-bootstrap-secret') || '';
    if (provided !== config.BOOTSTRAP_SECRET) {
      return res.status(403).json({ error: 'BOOTSTRAP_FORBIDDEN' });
    }

    const body = bootstrapSchema.parse(req.body);

    const result = await withTransaction(null, async (client) => {
      const userCount = await client.query(`SELECT count(*)::int AS count FROM users`);

      if (userCount.rows[0].count !== 0) {
        const error = new Error('Bootstrap disabled because a user already exists');
        error.code = 'P0001';
        throw error;
      }

      const role = await client.query(
        `SELECT id FROM roles WHERE code='ADMIN' LIMIT 1`
      );

      if (role.rowCount !== 1) {
        const error = new Error('ADMIN role is missing from database');
        error.code = 'P0001';
        throw error;
      }

      const passwordHash = await argon2.hash(body.password, {
        type: argon2.argon2id
      });

      const inserted = await client.query(
        `
        INSERT INTO users(
          username,
          full_name,
          password_hash,
          role_id,
          status
        )
        VALUES($1,$2,$3,$4,'ACTIVE')
        RETURNING id, username, full_name
        `,
        [body.username, body.full_name, passwordHash, role.rows[0].id]
      );

      return inserted.rows[0];
    });

    res.status(201).json({
      ok: true,
      admin: result,
      important: 'Remove BOOTSTRAP_SECRET from Vercel now.'
    });
  } catch (error) {
    next(error);
  }
});


// ------------------------------------------------------------
// Browser-friendly ONE-TIME Admin setup page (no inline JS)
// ------------------------------------------------------------
function adminSetupPage(message = '', isError = false) {
  const msgHtml = message
    ? `<div style="margin-top:18px;padding:12px;border-radius:8px;background:${isError ? '#fdecec' : '#e8f7ed'};color:${isError ? '#8b1e1e' : '#176b35'}">${message}</div>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment - Create First Admin</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:30px}
    .card{max-width:560px;margin:30px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
    h1{margin:0 0 8px;font-size:26px}
    p{color:#555;line-height:1.5}
    label{display:block;margin-top:18px;font-weight:700}
    input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
    button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
    .note{font-size:13px;color:#777;margin-top:14px}
  </style>
</head>
<body>
  <div class="card">
    <h1>JK Investment</h1>
    <p>Create the first Administrator account. This page works only once.</p>
    <form method="post" action="/setup-admin">
      <label>Admin Username</label>
      <input name="username" autocomplete="username" required minlength="3" placeholder="admin">

      <label>Full Name</label>
      <input name="full_name" required minlength="2" placeholder="JK Administrator">

      <label>Admin Password</label>
      <input name="password" type="password" autocomplete="new-password" required minlength="12" placeholder="Minimum 12 characters">

      <label>Bootstrap Secret</label>
      <input name="bootstrap_secret" type="password" required placeholder="The BOOTSTRAP_SECRET you added in Vercel">

      <button type="submit">Create Admin</button>
      ${msgHtml}
    </form>
    <div class="note">After success, remove BOOTSTRAP_SECRET from Vercel Environment Variables.</div>
  </div>
</body>
</html>`;
}

app.get('/setup-admin', (req, res) => {
  if (!config.BOOTSTRAP_SECRET) {
    return res.status(404).send('Setup is disabled.');
  }

  return res.type('html').send(adminSetupPage());
});

app.post('/setup-admin', async (req, res) => {
  if (!config.BOOTSTRAP_SECRET) {
    return res.status(404).send('Setup is disabled.');
  }

  const provided = String(req.body?.bootstrap_secret || '');

  if (provided !== config.BOOTSTRAP_SECRET) {
    return res.status(403).type('html').send(
      adminSetupPage('Bootstrap Secret is incorrect.', true)
    );
  }

  let body;
  try {
    body = bootstrapSchema.parse({
      username: req.body?.username,
      full_name: req.body?.full_name,
      password: req.body?.password
    });
  } catch (error) {
    return res.status(400).type('html').send(
      adminSetupPage(
        'Please check the fields. Password must be at least 12 characters.',
        true
      )
    );
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userCount = await client.query(
      `SELECT count(*)::int AS count FROM public.users`
    );

    if (userCount.rows[0].count !== 0) {
      await client.query('ROLLBACK');
      return res.status(409).type('html').send(
        adminSetupPage('Admin account already exists. Setup is closed.', false)
      );
    }

    const role = await client.query(
      `SELECT id FROM public.roles WHERE code='ADMIN' LIMIT 1`
    );

    if (role.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(500).type('html').send(
        adminSetupPage(
          'ADMIN role is missing. Database schema must be checked.',
          true
        )
      );
    }

    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id
    });

    const inserted = await client.query(
      `INSERT INTO public.users(
         username,
         full_name,
         password_hash,
         role_id,
         status
       )
       VALUES($1,$2,$3,$4,'ACTIVE')
       RETURNING id, username, full_name`,
      [body.username, body.full_name, passwordHash, role.rows[0].id]
    );

    await client.query('COMMIT');

    return res.status(201).type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:30px">
  <div style="max-width:560px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
    <h1>Admin created successfully ✅</h1>
    <p>Username: <strong>${inserted.rows[0].username}</strong></p>
    <p>Next: remove <strong>BOOTSTRAP_SECRET</strong> from Vercel Environment Variables, then redeploy.</p>
  </div>
</body>
</html>`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('Admin setup failed:', {
      code: error?.code,
      message: error?.message
    });

    const safeMessage =
      error?.code === '23505'
        ? 'That Admin username already exists.'
        : `Admin creation failed (code: ${error?.code || 'UNKNOWN'}). Please send only this error code.`;

    return res.status(500).type('html').send(
      adminSetupPage(safeMessage, true)
    );
  } finally {
    client.release();
  }
});


// ------------------------------------------------------------
// Browser-friendly Admin login verification page (staging)
// ------------------------------------------------------------
function loginTestPage(message = '', isError = false) {
  const safeMessage = String(message)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment - Admin Login Test</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:30px}
    .card{max-width:520px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
    h1{margin:0 0 8px;font-size:26px}
    p{color:#555;line-height:1.5}
    label{display:block;margin-top:18px;font-weight:700}
    input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
    button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
    .msg{margin-top:18px;padding:12px;border-radius:8px;${message ? 'display:block' : 'display:none'}}
    .ok{background:#e8f7ed;color:#176b35}
    .err{background:#fdecec;color:#8b1e1e}
  </style>
</head>
<body>
  <div class="card">
    <h1>JK Investment</h1>
    <p>Admin Login Test</p>
    ${message ? `<div class="msg ${isError ? 'err' : 'ok'}">${safeMessage}</div>` : ''}
    <form method="post" action="/login-test">
      <label>Username</label>
      <input name="username" autocomplete="username" required value="admin">

      <label>Password</label>
      <input name="password" type="password" autocomplete="current-password" required>

      <button type="submit">Test Login</button>
    </form>
  </div>
</body>
</html>`;
}

app.get('/login-test', (req, res) => {
  return res.type('html').send(loginTestPage());
});

app.post('/login-test', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).type('html').send(
        loginTestPage('Username and password are required.', true)
      );
    }

    const result = await query(
      `
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.password_hash,
        u.status,
        r.code AS role_code
      FROM public.users u
      JOIN public.roles r ON r.id = u.role_id
      WHERE lower(u.username) = lower($1)
      LIMIT 1
      `,
      [username]
    );

    if (result.rowCount !== 1) {
      return res.status(401).type('html').send(
        loginTestPage('Login failed. Check username/password.', true)
      );
    }

    const user = result.rows[0];

    if (user.status !== 'ACTIVE') {
      return res.status(401).type('html').send(
        loginTestPage('This user is not active.', true)
      );
    }

    const passwordOk = await argon2.verify(user.password_hash, password);

    if (!passwordOk) {
      return res.status(401).type('html').send(
        loginTestPage('Login failed. Check username/password.', true)
      );
    }

    return res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:30px">
  <div style="max-width:520px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
    <h1>Admin login successful ✅</h1>
    <p>User: <strong>${user.username}</strong></p>
    <p>Name: <strong>${user.full_name}</strong></p>
    <p>Role: <strong>${user.role_code}</strong></p>
    <p>Next step: enable Authenticator 2FA and connect the JK frontend to the real API.</p>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('Login test failed:', { code: error?.code, message: error?.message });
    return res.status(500).type('html').send(
      loginTestPage(`Login test failed (code: ${error?.code || 'UNKNOWN'}).`, true)
    );
  }
});


// ------------------------------------------------------------
// Browser-friendly Authenticator 2FA setup
// ------------------------------------------------------------
function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function twoFaStartPage(message = '', isError = false) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment - 2FA Setup</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:30px}
    .card{max-width:540px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
    h1{margin:0 0 8px;font-size:26px}
    p{color:#555;line-height:1.5}
    label{display:block;margin-top:18px;font-weight:700}
    input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
    button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
    .msg{margin-top:15px;padding:12px;border-radius:8px}
    .ok{background:#e8f7ed;color:#176b35}
    .err{background:#fdecec;color:#8b1e1e}
  </style>
</head>
<body>
  <div class="card">
    <h1>JK Investment</h1>
    <p>Enable Authenticator 2FA</p>
    ${message ? `<div class="msg ${isError ? 'err' : 'ok'}">${htmlEscape(message)}</div>` : ''}
    <form method="post" action="/2fa-setup/start">
      <label>Admin Username</label>
      <input name="username" value="admin" autocomplete="username" required>

      <label>Admin Password</label>
      <input name="password" type="password" autocomplete="current-password" required>

      <button type="submit">Generate QR Code</button>
    </form>
  </div>
</body>
</html>`;
}

app.get('/2fa-setup', (req, res) => {
  if (!config.twoFactorKey) {
    return res.status(503).type('html').send(
      twoFaStartPage(
        'TWO_FACTOR_ENCRYPTION_KEY is not configured in Vercel yet.',
        true
      )
    );
  }
  return res.type('html').send(twoFaStartPage());
});

app.post('/2fa-setup/start', async (req, res) => {
  try {
    if (!config.twoFactorKey) {
      return res.status(503).type('html').send(
        twoFaStartPage('2FA encryption key is missing in Vercel.', true)
      );
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    const result = await query(
      `SELECT id, username, full_name, password_hash, status
       FROM public.users
       WHERE lower(username)=lower($1)
       LIMIT 1`,
      [username]
    );

    if (result.rowCount !== 1) {
      return res.status(401).type('html').send(
        twoFaStartPage('Login details are incorrect.', true)
      );
    }

    const user = result.rows[0];
    const passwordOk = await argon2.verify(user.password_hash, password);

    if (!passwordOk || user.status !== 'ACTIVE') {
      return res.status(401).type('html').send(
        twoFaStartPage('Login details are incorrect.', true)
      );
    }

    const secret = generateSecret();
    const encrypted = encrypt2FASecret(secret);

    await query(
      `UPDATE public.users
       SET two_factor_secret_encrypted=$2,
           two_factor_enabled=false
       WHERE id=$1`,
      [user.id, encrypted]
    );

    const uri = generateURI({
      issuer: 'JK Investment',
      label: user.username,
      secret
    });

    const qrDataUrl = await QRCode.toDataURL(uri, {
      width: 280,
      margin: 2
    });

    return res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JK Investment - Scan QR</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:30px}
    .card{max-width:560px;margin:30px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}
    label{display:block;text-align:left;margin-top:18px;font-weight:700}
    input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
    button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
    .secret{word-break:break-all;background:#f6f6f6;padding:10px;border-radius:8px;font-family:monospace}
  </style>
</head>
<body>
  <div class="card">
    <h1>Scan this QR ✅</h1>
    <p>Open Google Authenticator or Microsoft Authenticator and scan this QR code.</p>
    <img src="${qrDataUrl}" width="280" height="280" alt="2FA QR Code">
    <p>If scanning is difficult, use this setup key:</p>
    <div class="secret">${htmlEscape(secret)}</div>

    <form method="post" action="/2fa-setup/confirm">
      <input type="hidden" name="username" value="${htmlEscape(user.username)}">

      <label>Admin Password</label>
      <input name="password" type="password" autocomplete="current-password" required>

      <label>6-digit Authenticator Code</label>
      <input name="token" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required placeholder="123456">

      <button type="submit">Confirm 2FA</button>
    </form>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('2FA setup start failed:', {
      code: error?.code,
      message: error?.message
    });
    return res.status(500).type('html').send(
      twoFaStartPage(`2FA setup failed (code: ${error?.code || 'UNKNOWN'}).`, true)
    );
  }
});

app.post('/2fa-setup/confirm', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const token = String(req.body?.token || '').trim();

    if (!/^\d{6}$/.test(token)) {
      return res.status(400).type('html').send(
        twoFaStartPage('Enter a valid 6-digit Authenticator code.', true)
      );
    }

    const result = await query(
      `SELECT id, username, full_name, password_hash, status,
              two_factor_secret_encrypted
       FROM public.users
       WHERE lower(username)=lower($1)
       LIMIT 1`,
      [username]
    );

    if (result.rowCount !== 1) {
      return res.status(401).type('html').send(
        twoFaStartPage('Login details are incorrect.', true)
      );
    }

    const user = result.rows[0];
    const passwordOk = await argon2.verify(user.password_hash, password);

    if (!passwordOk || user.status !== 'ACTIVE') {
      return res.status(401).type('html').send(
        twoFaStartPage('Login details are incorrect.', true)
      );
    }

    if (!user.two_factor_secret_encrypted) {
      return res.status(400).type('html').send(
        twoFaStartPage('Please generate the QR code again.', true)
      );
    }

    const secret = decrypt2FASecret(user.two_factor_secret_encrypted);
    const verification = await verify({ secret, token });

    if (!verification.valid) {
      return res.status(400).type('html').send(
        twoFaStartPage('Authenticator code is incorrect. Try again.', true)
      );
    }

    await query(
      `UPDATE public.users
       SET two_factor_enabled=true
       WHERE id=$1`,
      [user.id]
    );

    return res.type('html').send(`<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JK Investment</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:30px">
  <div style="max-width:540px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
    <h1>Authenticator 2FA enabled ✅</h1>
    <p>User: <strong>${htmlEscape(user.username)}</strong></p>
    <p>Future secure API logins now require the 6-digit Authenticator code.</p>
    <p>Next step: run the secure login test.</p>
  </div>
</body>
</html>`);
  } catch (error) {
    console.error('2FA confirm failed:', {
      code: error?.code,
      message: error?.message
    });
    return res.status(500).type('html').send(
      twoFaStartPage(`2FA confirmation failed (code: ${error?.code || 'UNKNOWN'}).`, true)
    );
  }
});

// ------------------------------------------------------------
// Browser-friendly secure login test with 2FA
// ------------------------------------------------------------
app.get('/secure-login-test', (req, res) => {
  return res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JK Investment Secure Login Test</title>
<style>
body{font-family:Arial,sans-serif;background:#f4f6f8;padding:30px}
.card{max-width:520px;margin:40px auto;background:white;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
label{display:block;margin-top:18px;font-weight:700}
input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font-size:16px;font-weight:700}
</style>
</head>
<body><div class="card"><h1>JK Investment</h1><p>Secure Login Test</p>
<form method="post" action="/secure-login-test">
<label>Username</label><input name="username" value="admin" required>
<label>Password</label><input name="password" type="password" required>
<label>Authenticator Code</label><input name="token" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Secure Login</button>
</form></div></body></html>`);
});

app.post('/secure-login-test', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const token = String(req.body?.token || '').trim();

    const result = await query(
      `SELECT u.id,u.username,u.full_name,u.password_hash,u.status,
              u.two_factor_enabled,u.two_factor_secret_encrypted,
              r.code AS role_code
       FROM public.users u
       JOIN public.roles r ON r.id=u.role_id
       WHERE lower(u.username)=lower($1)
       LIMIT 1`,
      [username]
    );

    if (result.rowCount !== 1) {
      return res.status(401).send('Login failed.');
    }

    const user = result.rows[0];
    const passwordOk = await argon2.verify(user.password_hash, password);

    if (!passwordOk || user.status !== 'ACTIVE' || !user.two_factor_enabled) {
      return res.status(401).send('Login failed or 2FA is not enabled.');
    }

    const secret = decrypt2FASecret(user.two_factor_secret_encrypted);
    const verification = await verify({ secret, token });

    if (!verification.valid) {
      return res.status(401).send('Invalid Authenticator code.');
    }

    return res.type('html').send(`<!doctype html>
<html><body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:30px">
<div style="max-width:520px;margin:40px auto;background:#fff;padding:28px;border-radius:14px">
<h1>Secure login successful ✅</h1>
<p>User: <strong>${htmlEscape(user.username)}</strong></p>
<p>Role: <strong>${htmlEscape(user.role_code)}</strong></p>
<p>Password + Authenticator code both verified.</p>
</div></body></html>`);
  } catch (error) {
    console.error('Secure login test failed:', {
      code: error?.code,
      message: error?.message
    });
    return res.status(500).send('Secure login test failed.');
  }
});


// ------------------------------------------------------------
// Browser-friendly staging test console
// Center -> Group -> Customer -> Loan -> Disburse -> Payment
// Protected by password + 2FA and an HttpOnly staging session cookie.
// ------------------------------------------------------------
const STAGING_COOKIE = 'jk_staging_session';

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const cookies = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

async function getStagingUser(req) {
  const token = parseCookies(req)[STAGING_COOKIE];
  if (!token) return null;

  const tokenHash = hashToken(token);
  const result = await query(
    `SELECT s.id AS session_id, u.id AS user_id, u.username, u.full_name, r.code AS role_code
     FROM public.user_sessions s
     JOIN public.users u ON u.id=s.user_id
     JOIN public.roles r ON r.id=u.role_id
     WHERE s.token_hash=$1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status='ACTIVE'
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

function stagingLoginPage(message='') {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JK Investment - Staging Test Login</title>
<style>
body{font-family:Arial,sans-serif;background:#f4f6f8;padding:30px}
.card{max-width:520px;margin:40px auto;background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
label{display:block;margin-top:18px;font-weight:700}
input{width:100%;box-sizing:border-box;padding:12px;margin-top:7px;border:1px solid #ccd2d8;border-radius:8px;font-size:16px}
button{width:100%;margin-top:24px;padding:13px;border:0;border-radius:8px;background:#111;color:white;font-size:16px;font-weight:700}
.msg{background:#fdecec;color:#8b1e1e;padding:10px;border-radius:8px;margin:12px 0}
</style>
</head>
<body><div class="card">
<h1>JK Investment</h1>
<p>Staging Test Console Login</p>
${message ? `<div class="msg">${htmlEscape(message)}</div>` : ''}
<form method="post" action="/staging-test/login">
<label>Username</label><input name="username" value="admin" required>
<label>Password</label><input name="password" type="password" required>
<label>Authenticator Code</label><input name="token" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">Login to Test Console</button>
</form>
</div></body></html>`;
}

app.get('/staging-test/login', (req,res) => {
  res.type('html').send(stagingLoginPage());
});

app.post('/staging-test/login', async (req,res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const token = String(req.body?.token || '').trim();

    const result = await query(
      `SELECT u.id,u.username,u.full_name,u.password_hash,u.status,
              u.two_factor_enabled,u.two_factor_secret_encrypted
       FROM public.users u
       WHERE lower(u.username)=lower($1)
       LIMIT 1`,
      [username]
    );

    if (result.rowCount !== 1) {
      return res.status(401).type('html').send(stagingLoginPage('Login failed.'));
    }

    const user = result.rows[0];
    const passwordOk = await argon2.verify(user.password_hash, password);

    if (!passwordOk || user.status !== 'ACTIVE' || !user.two_factor_enabled) {
      return res.status(401).type('html').send(stagingLoginPage('Login failed or 2FA is not enabled.'));
    }

    const secret = decrypt2FASecret(user.two_factor_secret_encrypted);
    const verification = await verify({secret, token});

    if (!verification.valid) {
      return res.status(401).type('html').send(stagingLoginPage('Authenticator code is incorrect.'));
    }

    const rawToken = randomSessionToken();
    const tokenHash = hashToken(rawToken);

    await query(
      `INSERT INTO public.user_sessions(
         user_id, token_hash, device_label, user_agent, expires_at
       )
       VALUES($1,$2,'Staging Test Console',$3,now()+interval '2 hours')`,
      [user.id, tokenHash, req.get('user-agent') || null]
    );

    res.setHeader(
      'Set-Cookie',
      `${STAGING_COOKIE}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200`
    );
    return res.redirect(303, '/staging-test');
  } catch (error) {
    console.error('Staging login failed:', {code:error?.code,message:error?.message});
    return res.status(500).type('html').send(stagingLoginPage('Unexpected login error.'));
  }
});

app.post('/staging-test/logout', async (req,res) => {
  try {
    const raw = parseCookies(req)[STAGING_COOKIE];
    if (raw) {
      await query(
        `UPDATE public.user_sessions SET revoked_at=now() WHERE token_hash=$1`,
        [hashToken(raw)]
      );
    }
  } catch {}
  res.setHeader('Set-Cookie', `${STAGING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res.redirect(303, '/staging-test/login');
});

async function requireStaging(req,res) {
  const user = await getStagingUser(req);
  if (!user) {
    res.redirect(303, '/staging-test/login');
    return null;
  }
  return user;
}

function optionRows(rows, valueKey, labelFn) {
  return rows.map(r =>
    `<option value="${htmlEscape(r[valueKey])}">${htmlEscape(labelFn(r))}</option>`
  ).join('');
}

app.get('/staging-test', async (req,res) => {
  const user = await requireStaging(req,res);
  if (!user) return;

  try {
    const [centersR, groupsR, customersR, loansR] = await Promise.all([
      query(`SELECT id,center_code,center_name,collection_isodow FROM public.centers ORDER BY created_at DESC LIMIT 20`),
      query(`SELECT g.id,g.group_code,g.group_name,g.center_id,c.center_name
             FROM public.groups g JOIN public.centers c ON c.id=g.center_id
             ORDER BY g.created_at DESC LIMIT 20`),
      query(`SELECT c.id,c.customer_code,c.customer_name,c.nic,c.center_id,c.group_id
             FROM public.customers c ORDER BY c.created_at DESC LIMIT 20`),
      query(`SELECT vf.loan_id,vf.loan_code,vf.total_payable,vf.total_paid,vf.balance,
                    vf.arrears,vf.advance,vf.operational_status,c.customer_name
             FROM public.v_loan_financials vf
             JOIN public.customers c ON c.id=vf.customer_id
             ORDER BY vf.loan_code DESC LIMIT 20`)
    ]);

    const centers = centersR.rows, groups=groupsR.rows, customers=customersR.rows, loans=loansR.rows;
    const latestLoan = loans[0] || null;

    res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JK Investment - Staging Test</title>
<style>
body{font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#111}
.wrap{max-width:1100px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:20px}
.card{background:#fff;padding:20px;border-radius:14px;box-shadow:0 5px 22px rgba(0,0,0,.06)}
label{display:block;margin-top:12px;font-weight:700;font-size:14px}
input,select{width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border:1px solid #ccd2d8;border-radius:8px}
button{margin-top:15px;padding:11px 15px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:700;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px;border-bottom:1px solid #eee;text-align:left}
.small{font-size:13px;color:#666}.ok{background:#e9f8ed;padding:10px;border-radius:8px}
</style>
</head>
<body><div class="wrap">
<div class="top">
  <div><h1>JK Investment Staging Test</h1><div class="small">Logged in: ${htmlEscape(user.username)} | Test data only</div></div>
  <form method="post" action="/staging-test/logout"><button>Logout</button></form>
</div>

<div class="grid">
<div class="card">
<h2>1. Create Center</h2>
<form method="post" action="/staging-test/center">
<label>Center Name</label><input name="center_name" value="Test Center" required>
<label>Address</label><input name="address" value="Testing Only">
<label>Collection Day</label>
<select name="collection_isodow">
<option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option>
<option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="7">Sunday</option>
</select>
<button>Create Center</button>
</form>
</div>

<div class="card">
<h2>2. Create Group</h2>
<form method="post" action="/staging-test/group">
<label>Center</label><select name="center_id" required>
${optionRows(centers,'id',r=>`${r.center_name} (${r.center_code})`)}
</select>
<label>Group Name</label><input name="group_name" value="Test Group" required>
<label>Members Count</label><input name="members_count" type="number" value="5" min="0">
<button>Create Group</button>
</form>
</div>

<div class="card">
<h2>3. Create Customer</h2>
<form method="post" action="/staging-test/customer">
<label>Center</label><select name="center_id" required>
${optionRows(centers,'id',r=>`${r.center_name} (${r.center_code})`)}
</select>
<label>Group</label><select name="group_id" required>
${optionRows(groups,'id',r=>`${r.group_name} - ${r.center_name}`)}
</select>
<label>Customer Name</label><input name="customer_name" value="Test Customer" required>
<label>NIC</label><input name="nic" value="TESTNIC001" required>
<label>Mobile</label><input name="mobile" value="0770000000">
<button>Create Customer</button>
</form>
</div>

<div class="card">
<h2>4. Create Loan</h2>
<form method="post" action="/staging-test/loan">
<label>Customer</label><select name="customer_id" required>
${optionRows(customers,'id',r=>`${r.customer_name} (${r.customer_code})`)}
</select>
<label>Principal</label><input name="principal" type="number" step="0.01" value="100000" required>
<label>Interest %</label><input name="interest_rate" type="number" step="0.01" value="20" required>
<label>Loan Type</label><select name="loan_type"><option>WEEKLY</option><option>DAILY</option><option>MONTHLY</option></select>
<label>Installments</label><input name="installment_count" type="number" value="28" required>
<label>Repayment Start Date</label><input name="repayment_start_date" type="date" required>
<button>Create Pending Loan</button>
</form>
</div>

<div class="card">
<h2>5. Disburse Loan</h2>
<form method="post" action="/staging-test/disburse">
<label>Loan</label><select name="loan_id" required>
${optionRows(loans,'loan_id',r=>`${r.loan_code} - ${r.customer_name} - ${r.operational_status}`)}
</select>
<label>Disbursed Date</label><input name="disbursed_date" type="date" required>
<label>Payment Method</label><select name="payment_method"><option>CASH</option><option>BANK</option></select>
<button>Disburse Loan</button>
</form>
</div>

<div class="card">
<h2>6. Enter Payment</h2>
<form method="post" action="/staging-test/payment">
<label>Loan</label><select name="loan_id" required>
${optionRows(loans,'loan_id',r=>`${r.loan_code} - ${r.customer_name} - Balance ${r.balance}`)}
</select>
<label>Amount</label><input name="amount" type="number" step="0.01" value="2500" required>
<label>Payment Date</label><input name="payment_date" type="date" required>
<label>Method</label><select name="payment_method"><option>CASH</option><option>BANK</option></select>
<button>Enter Payment</button>
</form>
</div>
</div>

<div class="card" style="margin-top:20px">
<h2>Latest Loan Financials</h2>
${latestLoan ? `<div class="ok">
Loan: <strong>${htmlEscape(latestLoan.loan_code)}</strong> |
Customer: <strong>${htmlEscape(latestLoan.customer_name)}</strong> |
Status: <strong>${htmlEscape(latestLoan.operational_status)}</strong><br>
Total Payable: <strong>${htmlEscape(latestLoan.total_payable)}</strong> |
Paid: <strong>${htmlEscape(latestLoan.total_paid)}</strong> |
Balance: <strong>${htmlEscape(latestLoan.balance)}</strong> |
Arrears: <strong>${htmlEscape(latestLoan.arrears)}</strong> |
Advance: <strong>${htmlEscape(latestLoan.advance)}</strong>
</div>` : '<p>No loan created yet.</p>'}
</div>

<div class="card" style="margin-top:20px">
<h2>Recent Records</h2>
<table><tr><th>Type</th><th>Code / Name</th><th>Details</th></tr>
${centers.slice(0,5).map(r=>`<tr><td>Center</td><td>${htmlEscape(r.center_code)}</td><td>${htmlEscape(r.center_name)}</td></tr>`).join('')}
${groups.slice(0,5).map(r=>`<tr><td>Group</td><td>${htmlEscape(r.group_code)}</td><td>${htmlEscape(r.group_name)}</td></tr>`).join('')}
${customers.slice(0,5).map(r=>`<tr><td>Customer</td><td>${htmlEscape(r.customer_code)}</td><td>${htmlEscape(r.customer_name)}</td></tr>`).join('')}
${loans.slice(0,5).map(r=>`<tr><td>Loan</td><td>${htmlEscape(r.loan_code)}</td><td>${htmlEscape(r.customer_name)} | ${htmlEscape(r.operational_status)}</td></tr>`).join('')}
</table>
</div>
</div></body></html>`);
  } catch (error) {
    console.error('Staging dashboard error:', {code:error?.code,message:error?.message});
    res.status(500).send(`Staging dashboard error: ${htmlEscape(error?.code || 'UNKNOWN')}`);
  }
});

app.post('/staging-test/center', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, client => client.query(
      `INSERT INTO public.centers(center_name,address,collection_isodow,created_by)
       VALUES($1,$2,$3,$4)`,
      [String(req.body.center_name||'').trim(), String(req.body.address||'').trim() || null,
       Number(req.body.collection_isodow), user.user_id]
    ));
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Center create failed: ${htmlEscape(error.message)}`);
  }
});

app.post('/staging-test/group', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, client => client.query(
      `INSERT INTO public.groups(center_id,group_name,members_count,created_by)
       VALUES($1,$2,$3,$4)`,
      [req.body.center_id, String(req.body.group_name||'').trim(),
       Number(req.body.members_count||0), user.user_id]
    ));
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Group create failed: ${htmlEscape(error.message)}`);
  }
});

app.post('/staging-test/customer', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, client => client.query(
      `INSERT INTO public.customers(
         center_id,group_id,customer_name,nic,mobile,created_by,updated_by
       ) VALUES($1,$2,$3,$4,$5,$6,$6)`,
      [req.body.center_id, req.body.group_id, String(req.body.customer_name||'').trim(),
       String(req.body.nic||'').trim(), String(req.body.mobile||'').trim() || null, user.user_id]
    ));
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Customer create failed: ${htmlEscape(error.message)}`);
  }
});

app.post('/staging-test/loan', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, async client => {
      const customer = await client.query(
        `SELECT center_id,group_id FROM public.customers WHERE id=$1`,
        [req.body.customer_id]
      );
      if (customer.rowCount !== 1) throw new Error('Customer not found');
      const c = customer.rows[0];
      await client.query(
        `INSERT INTO public.loans(
          customer_id,center_id,group_id,principal,interest_rate,loan_type,
          installment_count,repayment_start_date,lifecycle_status,created_by,updated_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$9)`,
        [req.body.customer_id,c.center_id,c.group_id,req.body.principal,req.body.interest_rate,
         req.body.loan_type,req.body.installment_count,req.body.repayment_start_date,user.user_id]
      );
    });
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Loan create failed: ${htmlEscape(error.message)}`);
  }
});

app.post('/staging-test/disburse', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, client => client.query(
      `SELECT public.disburse_loan($1,$2,$3,$4)`,
      [req.body.loan_id,req.body.disbursed_date,req.body.payment_method,user.user_id]
    ));
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Disbursement failed: ${htmlEscape(error.message)}`);
  }
});

app.post('/staging-test/payment', async (req,res) => {
  const user = await requireStaging(req,res); if (!user) return;
  try {
    await withTransaction(user.user_id, client => client.query(
      `SELECT public.create_payment($1,$2,$3,$4,$5,$6,gen_random_uuid())`,
      [req.body.loan_id,req.body.amount,req.body.payment_date,req.body.payment_method,
       'Staging test payment',user.user_id]
    ));
    return res.redirect(303,'/staging-test');
  } catch(error) {
    return res.status(400).send(`Payment failed: ${htmlEscape(error.message)}`);
  }
});

// Public legal pages required for OAuth transparency and consent-screen links.
registerPublicLegalPages(app);

// Production-style browser frontend (same-origin, HttpOnly session cookie)
registerAppUi(app);

// CORS is intentionally applied only to API routes below.
// Browser-local setup-admin is a same-origin one-time page and should not
// be blocked by frontend CORS configuration.
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow this Vercel staging project's canonical/preview domains.
    if (
      /^https:\/\/jk-investment-production(?:-[a-z0-9-]+)?(?:-jk-investment)?\.vercel\.app$/i.test(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error('CORS origin not allowed'));
  },
  credentials: false
}));

// Register backup routes before the larger application routers. Keeping these
// mounts together prevents a later compatibility/catch-all route from hiding
// the one-click or scheduled backup endpoints.
app.use('/api/backup', backupRouter);
app.get('/api/cron/backup', cloudDailyBackupHandler);
app.get('/api/cron/whatsapp', whatsappCronHandler);

app.use('/api/auth', authRouter);
app.use('/api/organization', organizationRouter);
app.use('/api/customers', customersRouter);
app.use('/api/loans', loansRouter);

// ------------------------------------------------------------
// PAYMENTS LIST COMPATIBILITY ENDPOINT
// The current frontend Collections page loads recent payments with
// GET /api/payments. Older backend copies only exposed POST/edit/void,
// which caused a 404 NOT_FOUND on the Collections screen.
// ------------------------------------------------------------
app.get(
  '/api/payments',
  requireAuth,
  requirePermission('PAYMENT_CREATE'),
  async (req, res, next) => {
    try {
      const result = await query(
        `
        SELECT
          p.id,
          p.receipt_no,
          p.loan_id,
          p.customer_id,
          p.center_id,
          p.payment_date,
          p.amount,
          p.payment_method,
          p.notes,
          p.status,
          p.whatsapp_sent_at,
          greatest(
            l.total_payable - COALESCE((
              SELECT sum(px.amount)
              FROM payments px
              WHERE px.loan_id=p.loan_id
                AND px.status='POSTED'
            ),0),
            0
          )::numeric(15,2) AS balance_after,
          p.created_at,
          p.updated_at AS edited_at,
          p.voided_at,
          p.void_reason,
          l.loan_code,
          c.customer_code,
          c.customer_name,
          c.mobile,
          ce.center_name
        FROM payments p
        JOIN loans l ON l.id=p.loan_id
        JOIN customers c ON c.id=p.customer_id
        JOIN centers ce ON ce.id=p.center_id
        ORDER BY p.payment_date DESC, p.created_at DESC
        LIMIT 300
        `
      );

      res.json({ payments: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/payments/:id/whatsapp-sent',
  requireAuth,
  requirePermission('PAYMENT_CREATE'),
  async (req, res, next) => {
    try {
      const result = await query(
        `
        UPDATE payments
        SET whatsapp_sent_at=COALESCE(whatsapp_sent_at,now()),
            updated_at=now()
        WHERE id=$1::uuid
          AND status='POSTED'
        RETURNING id,whatsapp_sent_at
        `,
        [req.params.id]
      );

      if (result.rowCount !== 1) {
        return res.status(404).json({ error: 'POSTED_PAYMENT_NOT_FOUND' });
      }

      res.json({ ok: true, payment: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
);


// ------------------------------------------------------------
// GROUP COLLECTION
// One screen -> many member payments.
// Each member still gets a separate permanent payment/receipt.
// Save is atomic: if one row fails, none of the group rows are posted.
// ------------------------------------------------------------
const groupCollectionPreviewSchema = z.object({
  group_id: z.string().uuid(),
  payment_date: z.iso.date()
});

app.get(
  '/api/group-collections/preview',
  requireAuth,
  requirePermission('PAYMENT_CREATE'),
  async (req, res, next) => {
    try {
      const body = groupCollectionPreviewSchema.parse({
        group_id: req.query.group_id,
        payment_date: req.query.payment_date
      });

      const clock = await query(
        `(SELECT (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo)`
      );

      if (body.payment_date > clock.rows[0].today_colombo) {
        const error = new Error('Future payment dates are not allowed.');
        error.code = 'P0001';
        throw error;
      }

      const groupInfo = await query(
        `
        SELECT
          g.id AS group_id,
          g.group_name,
          c.id AS center_id,
          c.center_name
        FROM groups g
        JOIN centers c ON c.id=g.center_id
        WHERE g.id=$1
        `,
        [body.group_id]
      );

      if (groupInfo.rowCount !== 1) {
        const error = new Error('Group not found.');
        error.code = 'P0001';
        throw error;
      }

      const rows = await query(
        `
        SELECT
          vf.loan_id,
          vf.loan_code,
          vf.customer_id,
          cu.customer_code,
          cu.customer_name,
          cu.mobile,
          vf.total_payable,
          vf.total_paid,
          vf.balance,
          vf.arrears,
          vf.advance,
          l.disbursed_date,
          COALESCE((
            SELECT s.due_amount
            FROM loan_schedule s
            WHERE s.loan_id=l.id
            ORDER BY s.installment_no
            LIMIT 1
          ),0)::numeric(15,2) AS regular_due,
          COALESCE((
            SELECT sum(p.amount)
            FROM payments p
            WHERE p.loan_id=l.id
              AND p.status='POSTED'
              AND p.payment_date=$2::date
          ),0)::numeric(15,2) AS paid_on_date
        FROM v_loan_financials vf
        JOIN loans l ON l.id=vf.loan_id
        JOIN customers cu ON cu.id=vf.customer_id
        WHERE vf.group_id=$1
          AND vf.lifecycle_status='DISBURSED'
          AND vf.balance > 0
        ORDER BY cu.customer_name,l.loan_code
        `,
        [body.group_id, body.payment_date]
      );

      const members = rows.rows.map(row => {
        const regularDue = Number(row.regular_due || 0);
        const balance = Number(row.balance || 0);
        const paidToday = Number(row.paid_on_date || 0);

        return {
          ...row,
          suggested_amount:
            paidToday > 0
              ? '0.00'
              : Math.min(regularDue, balance).toFixed(2)
        };
      });

      res.json({
        group: groupInfo.rows[0],
        payment_date: body.payment_date,
        members
      });
    } catch (error) {
      next(error);
    }
  }
);

const groupCollectionSchema = z.object({
  group_id: z.string().uuid(),
  payment_date: z.iso.date(),
  payment_method: z.enum(['CASH','BANK','MOBILE','OTHER']).default('CASH'),
  notes: z.string().trim().max(500).optional().nullable(),
  payments: z.array(
    z.object({
      loan_id: z.string().uuid(),
      amount: z.coerce.number().positive(),
      idempotency_key: z.string().uuid().optional()
    })
  ).min(1).max(100)
});

app.post(
  '/api/group-collections',
  requireAuth,
  requirePermission('PAYMENT_CREATE'),
  async (req, res, next) => {
    try {
      const body = groupCollectionSchema.parse(req.body);

      const loanIds = body.payments.map(x => x.loan_id);
      if (new Set(loanIds).size !== loanIds.length) {
        const error = new Error('The same loan appears more than once in the group payment.');
        error.code = 'P0001';
        throw error;
      }

      const result = await withTransaction(
        req.auth.user_id,
        async (client) => {
          const clock = await client.query(
            `(SELECT (now() AT TIME ZONE 'Asia/Colombo')::date::text AS today_colombo)`
          );

          if (body.payment_date > clock.rows[0].today_colombo) {
            const error = new Error('Future payment dates are not allowed.');
            error.code = 'P0001';
            throw error;
          }

          const groupInfo = await client.query(
            `
            SELECT g.group_name,c.center_name
            FROM groups g
            JOIN centers c ON c.id=g.center_id
            WHERE g.id=$1
            `,
            [body.group_id]
          );

          if (groupInfo.rowCount !== 1) {
            const error = new Error('Group not found.');
            error.code = 'P0001';
            throw error;
          }

          const created = [];

          for (const item of body.payments) {
            const loanCheck = await client.query(
              `
              SELECT
                l.id,
                l.loan_code,
                l.group_id,
                l.lifecycle_status,
                l.disbursed_date::text AS disbursed_date,
                l.total_payable,
                c.customer_name,
                COALESCE((
                  SELECT sum(p.amount)
                  FROM payments p
                  WHERE p.loan_id=l.id AND p.status='POSTED'
                ),0)::numeric(15,2) AS total_paid
              FROM loans l
              JOIN customers c ON c.id=l.customer_id
              WHERE l.id=$1
              FOR UPDATE OF l
              `,
              [item.loan_id]
            );

            if (loanCheck.rowCount !== 1) {
              const error = new Error('A selected loan was not found.');
              error.code = 'P0001';
              throw error;
            }

            const loan = loanCheck.rows[0];

            if (loan.group_id !== body.group_id) {
              const error = new Error(`${loan.loan_code} does not belong to the selected group.`);
              error.code = 'P0001';
              throw error;
            }

            if (loan.lifecycle_status !== 'DISBURSED') {
              const error = new Error(`${loan.loan_code} is not an active disbursed loan.`);
              error.code = 'P0001';
              throw error;
            }

            if (loan.disbursed_date && body.payment_date < loan.disbursed_date) {
              const error = new Error(
                `Payment date for ${loan.loan_code} cannot be before disbursement.`
              );
              error.code = 'P0001';
              throw error;
            }

            const balance =
              Number(loan.total_payable || 0) - Number(loan.total_paid || 0);

            if (Number(item.amount) > balance + 0.005) {
              const error = new Error(
                `${loan.customer_name}: payment cannot exceed balance Rs. ${balance.toFixed(2)}.`
              );
              error.code = 'P0001';
              throw error;
            }

            const noteParts = [
              `Group collection - ${groupInfo.rows[0].group_name}`,
              body.notes || ''
            ].filter(Boolean);

            const paymentResult = await client.query(
              `
              SELECT create_payment(
                $1,$2,$3,$4,$5,$6,
                COALESCE($7::uuid,gen_random_uuid())
              ) AS payment_id
              `,
              [
                item.loan_id,
                item.amount,
                body.payment_date,
                body.payment_method,
                noteParts.join(' · '),
                req.auth.user_id,
                item.idempotency_key || null
              ]
            );

            const saved = await client.query(
              `
              SELECT
                p.id,
                p.receipt_no,
                p.amount,
                p.payment_date,
                p.payment_method,
                greatest(
                  l.total_payable - COALESCE((
                    SELECT sum(px.amount)
                    FROM payments px
                    WHERE px.loan_id=p.loan_id
                      AND px.status='POSTED'
                  ),0),
                  0
                )::numeric(15,2) AS balance_after,
                c.customer_name,
                c.mobile,
                l.loan_code
              FROM payments p
              JOIN loans l ON l.id=p.loan_id
              JOIN customers c ON c.id=p.customer_id
              WHERE p.id=$1
              `,
              [paymentResult.rows[0].payment_id]
            );

            await enqueuePaymentWhatsApp(client, paymentResult.rows[0].payment_id, req.auth.user_id);
            created.push(saved.rows[0]);
          }

          return {
            group_name: groupInfo.rows[0].group_name,
            center_name: groupInfo.rows[0].center_name,
            count: created.length,
            total: created.reduce((sum, x) => sum + Number(x.amount || 0), 0).toFixed(2),
            payments: created
          };
        }
      );

      for (const payment of result.payments) {
        payment.whatsapp = { sent: false, queued: true, reason: 'WHATSAPP_QUEUED' };
      }
      scheduleWhatsAppDrain(res);

      res.status(201).json({
        ok: true,
        message: 'Group collection saved successfully.',
        ...result
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use('/api/payments', paymentsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/finance', financeRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/import', importerRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/agreement-pdf', agreementPdfRouter);
app.use('/api/audit', auditRouter);
app.use('/api/salary-advance', salaryAdvanceRouter);
app.use('/api/daily-closing', dailyClosingRouter);

app.use(notFound);
app.use(errorHandler);

// Vercel detects the default-exported Express app.
export default app;
