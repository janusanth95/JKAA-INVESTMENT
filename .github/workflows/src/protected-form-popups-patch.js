import express from 'express';

const previousSend = express.response.send;

function protectFormPopup(body, functionName) {
  const start = body.indexOf(functionName);
  if (start === -1) return body;

  const open = body.indexOf('openModal(`', start);
  if (open === -1) return body;

  const nextFunction = body.indexOf('\nfunction ', start + functionName.length);
  if (nextFunction !== -1 && open > nextFunction) return body;

  const marker = "modal.dataset.protected='1';\n  ";
  if (body.slice(Math.max(start, open - marker.length - 8), open).includes("modal.dataset.protected='1'")) {
    return body;
  }

  return body.slice(0, open) + marker + body.slice(open);
}

express.response.send = function protectedImportantFormsPatch(body) {
  try {
    const requestPath = this.req?.path || this.req?.url || '';
    if (typeof body === 'string' && requestPath.startsWith('/app.js')) {
      body = body.replace(
        "function closeModal(){modal.classList.add('hidden');modalBody.innerHTML='';document.querySelector('#modalBackdrop .modal')?.classList.remove('loan-create-modal')}",
        "function closeModal(){modal.classList.add('hidden');modalBody.innerHTML='';delete modal.dataset.protected;document.querySelector('#modalBackdrop .modal')?.classList.remove('loan-create-modal')}"
      );

      body = body.replace(
        "modal.onclick=e=>{if(e.target===modal)closeModal()};",
        "modal.onclick=e=>{if(e.target===modal && modal.dataset.protected!=='1')closeModal()};"
      );

      body = protectFormPopup(body, 'function showCustomerForm');
      body = protectFormPopup(body, 'function showLoanForm');
    }
  } catch (_) {}

  return previousSend.call(this, body);
};
