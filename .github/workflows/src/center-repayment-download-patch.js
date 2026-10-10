import express from 'express';

const REPAYMENT_DOWNLOAD_FUNCTION = Buffer.from('ZnVuY3Rpb24gZG93bmxvYWRDZW50ZXIoaWQpewogIGNvbnN0IGM9KHN0YXRlLmNlbnRlcnN8fFtdKS5maW5kKHg9PlN0cmluZyh4LmlkKT09PVN0cmluZyhpZCkpOwogIGlmKCFjKXJldHVybjsKCiAgY29uc3QgZGVmYXVsdERhdGU9KHR5cGVvZiB0b2RheT09PSdmdW5jdGlvbicpP3RvZGF5KCk6bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsMTApOwogIGNvbnN0IGRhdGU9d2luZG93LnByb21wdCgnUmVwYXltZW50IFNoZWV0IGRhdGUgKFlZWVktTU0tREQpJyxkZWZhdWx0RGF0ZSk7CiAgaWYoIWRhdGUpcmV0dXJuOwoKICBjb25zdCB1cmw9Jy9hcGkvcmVwb3J0cy9kb3dubG9hZC9yZXBheW1lbnQtc2hlZXQ/Y2VudGVyX2lkPScrCiAgICBlbmNvZGVVUklDb21wb25lbnQoYy5pZCkrCiAgICAnJmRhdGU9JysKICAgIGVuY29kZVVSSUNvbXBvbmVudChkYXRlKTsKICBjb25zdCBsaW5rPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICBsaW5rLmhyZWY9dXJsOwogIGxpbmsuZG93bmxvYWQ9J0pLX1JlcGF5bWVudF8nK1N0cmluZyhjLmNlbnRlcl9uYW1lfHwnQ2VudGVyJykucmVwbGFjZSgvW15hLXowLTlfLV0rL2dpLCdfJykrJ18nK2RhdGUrJy5wZGYnOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobGluayk7CiAgbGluay5jbGljaygpOwogIGxpbmsucmVtb3ZlKCk7Cn0K', 'base64').toString('utf8');

const originalSend = express.response.send;

express.response.send = function centerRepaymentDownloadPatch(body) {
  try {
    const requestPath = this.req?.path || this.req?.url || '';
    if (typeof body === 'string' && requestPath.startsWith('/app.js')) {
      const start = body.indexOf('function downloadCenter(id)');
      const end = body.indexOf('\nasync function deleteCenter', start);
      if (start !== -1 && end !== -1) {
        body = body.slice(0, start) + REPAYMENT_DOWNLOAD_FUNCTION + body.slice(end);
      }
      body = body.replaceAll(
        'title="Download"\n                      aria-label="Download"',
        'title="Repayment Sheet"\n                      aria-label="Repayment Sheet"'
      );
    }
  } catch (_) {}
  return originalSend.call(this, body);
};
