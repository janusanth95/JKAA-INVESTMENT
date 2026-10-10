import 'dotenv/config';

const GRAPH_VERSION =
  process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';

const ACCESS_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN || '';

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || '';

const TEMPLATE_NAME =
  process.env.WHATSAPP_PAYMENT_TEMPLATE || 'payment_received';

const TEMPLATE_LANGUAGE =
  process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';

function normalizeSriLankaMobile(value) {
  const raw = String(value || '').replace(/[^0-9+]/g, '');

  if (!raw) return '';

  if (raw.startsWith('+')) {
    return raw.slice(1);
  }

  if (raw.startsWith('94')) {
    return raw;
  }

  if (raw.startsWith('0')) {
    return '94' + raw.slice(1);
  }

  return raw;
}

function formatAmount(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }

  return number.toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export async function sendPaymentReceivedWhatsApp({
  customerName,
  mobile,
  amount,
  paymentDate,
  paymentMethod,
  balanceAfter
}) {
  const to = normalizeSriLankaMobile(mobile);

  if (!to) {
    return {
      sent: false,
      skipped: true,
      reason: 'NO_CUSTOMER_MOBILE'
    };
  }

  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    return {
      sent: false,
      skipped: true,
      reason: 'WHATSAPP_NOT_CONFIGURED'
    };
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),

    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },

    body: JSON.stringify({
      messaging_product: 'whatsapp',

      to,

      type: 'template',

      template: {
        name: TEMPLATE_NAME,

        language: {
          code: TEMPLATE_LANGUAGE
        },

        components: [
          {
            type: 'body',

            parameters: [
              {
                type: 'text',
                text: String(customerName || '')
              },

              {
                type: 'text',
                text: formatAmount(amount)
              },

              {
                type: 'text',
                text: String(paymentDate || '')
              },

              {
                type: 'text',
                text: String(paymentMethod || '')
              },

              {
                type: 'text',
                text: formatAmount(balanceAfter)
              }
            ]
          }
        ]
      }
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('WhatsApp API error:', {
      status: response.status,
      error:
        data?.error?.message ||
        'Unknown WhatsApp API error'
    });

    return {
      sent: false,
      skipped: false,
      reason: 'WHATSAPP_API_ERROR',
      status: response.status
    };
  }

  if (!data?.messages?.[0]?.id) {
    return { sent: false, skipped: false, reason: 'WHATSAPP_INVALID_RESPONSE' };
  }

  return {
    sent: true,
    skipped: false,
    messageId:
      data?.messages?.[0]?.id || null
  };
}
