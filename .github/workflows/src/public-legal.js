function legalPage({ title, intro, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>${title} | JK Investment</title>
  <style>
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f5f7f6;color:#17211e;line-height:1.65}
    header{background:#0b3d32;color:#fff;padding:24px 20px;border-bottom:4px solid #c9a227}
    header .wrap{max-width:920px;margin:0 auto}
    header a{color:#fff;text-decoration:none;font-weight:800;letter-spacing:.03em}
    main{max-width:920px;margin:28px auto;padding:0 20px 48px}
    article{background:#fff;border:1px solid #dce4e1;border-radius:14px;padding:28px;box-shadow:0 8px 28px rgba(11,61,50,.06)}
    h1{font-size:30px;line-height:1.2;margin:0 0 8px;color:#0b3d32}
    h2{font-size:18px;margin:28px 0 8px;color:#163f36}
    p,li{font-size:15px}
    .meta{color:#66736f;font-size:13px;margin-bottom:22px}
    .intro{font-size:16px;color:#364541}
    a{color:#0b6b57}
    footer{max-width:920px;margin:0 auto;padding:0 20px 36px;color:#6b7773;font-size:12px}
  </style>
</head>
<body>
  <header><div class="wrap"><a href="/app">JK INVESTMENT</a></div></header>
  <main>
    <article>
      <h1>${title}</h1>
      <div class="meta">Effective date: 1 October 2026 · Last updated: 1 October 2026</div>
      <p class="intro">${intro}</p>
      ${body}
    </article>
  </main>
  <footer>JK Investment · This page is publicly available for transparency and Google OAuth disclosure.</footer>
</body>
</html>`;
}

export function registerPublicLegalPages(app) {
  app.get('/privacy', (req, res) => {
    res.type('html').send(legalPage({
      title: 'Privacy Policy',
      intro: 'This Privacy Policy explains how the JK Investment system handles information used to manage lending operations and the Google Drive backup integration.',
      body: `
        <h2>1. Information handled by the system</h2>
        <p>JK Investment may store business records entered by authorized staff, including customer contact and identification details, guarantor details, center and group information, loan records, repayment and payment records, charges, expenses, investor records, audit records, and operational backup data.</p>

        <h2>2. How information is used</h2>
        <p>Information is used to operate the JK Investment loan-management system, maintain financial records, prepare reports, process repayments, support auditing and security, and create backups needed for business continuity.</p>

        <h2>3. Google Drive backup access</h2>
        <p>The application can connect to a Google account using OAuth so that authorized JK Investment backups can be uploaded to Google Drive. Google authorization data and access tokens are used only to authenticate the backup connection and perform the requested backup-storage function.</p>
        <p>Google user data obtained through this integration is not sold, used for advertising, or shared with third parties for unrelated purposes. Access can be revoked at any time from the connected Google Account's security settings.</p>

        <h2>4. Data protection</h2>
        <p>Reasonable technical and organizational safeguards are used to protect application data and backup credentials. Access to the operational system is restricted to authorized users. Backup credentials and tokens are not intentionally displayed to end users.</p>

        <h2>5. Data retention</h2>
        <p>Business and backup records are retained for as long as reasonably necessary for lending operations, accounting, auditing, recovery, legal obligations, and business continuity. Backup files may be deleted by an authorized administrator when they are no longer required.</p>

        <h2>6. Your choices and access</h2>
        <p>Authorized users can revoke the application's Google access through Google Account permissions. Requests concerning personal information held in JK Investment records should be directed to the JK Investment administrator.</p>

        <h2>7. Third-party services</h2>
        <p>The system may rely on infrastructure and services such as Google Drive for backup storage and hosting/database providers for application operation. Those providers process information under their own applicable terms and privacy practices.</p>

        <h2>8. Changes to this policy</h2>
        <p>This policy may be updated when the system, backup process, or legal requirements change. The latest version will remain available at this URL.</p>

        <h2>9. Contact</h2>
        <p>For privacy or Google OAuth questions, contact the JK Investment administrator using the support contact shown on the Google authorization screen.</p>
      `
    }));
  });

  app.get('/terms', (req, res) => {
    res.type('html').send(legalPage({
      title: 'Terms of Service',
      intro: 'These Terms govern authorized use of the JK Investment web application and its backup features.',
      body: `
        <h2>1. Authorized use</h2>
        <p>The JK Investment system is intended for authorized business users. Users must use their own permitted account and must not attempt to bypass access controls, security checks, or role restrictions.</p>

        <h2>2. Business records</h2>
        <p>Users are responsible for entering accurate customer, loan, repayment, expense, and other operational information. The application helps record and calculate business information, but authorized staff remain responsible for reviewing entries and reports before relying on them.</p>

        <h2>3. Account security</h2>
        <p>Users must protect login credentials, two-factor authentication methods, and connected Google accounts. Suspected unauthorized access should be addressed promptly by changing credentials, revoking sessions, or revoking Google access as appropriate.</p>

        <h2>4. Google Drive backups</h2>
        <p>When an authorized administrator connects Google Drive, the application may create and upload backup files to the selected Drive location. The connected Google account remains subject to Google's own terms, storage limits, permissions, and availability.</p>

        <h2>5. Availability and backups</h2>
        <p>The service is designed to support normal business operation, but uninterrupted availability cannot be guaranteed. Authorized users should monitor backup status and retain appropriate recovery copies for important business records.</p>

        <h2>6. Prohibited use</h2>
        <p>Users must not use the application to gain unauthorized access, damage or disrupt the service, introduce malicious software, misuse customer information, or use the system in violation of applicable law.</p>

        <h2>7. Changes</h2>
        <p>Features and these Terms may be updated as the JK Investment system evolves. Continued authorized use after an update means the current Terms apply to that use.</p>

        <h2>8. Contact</h2>
        <p>Questions about these Terms should be directed to the JK Investment administrator using the support contact shown on the Google authorization screen.</p>
      `
    }));
  });
}
