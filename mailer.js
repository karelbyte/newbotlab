const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LAB_CONTACT_EMAIL = process.env.LAB_CONTACT_EMAIL;
const CC_EMAIL = process.env.CC_LAB_CONTACT_EMAIL;
const FROM_EMAIL = process.env.MAIL_FROM || LAB_CONTACT_EMAIL;
// Los correos de cita se envían directamente si están configuradas las credenciales (RESEND_API_KEY y LAB_CONTACT_EMAIL).

function formatPayload(subject, htmlContent, to) {
  const payload = {
    from: FROM_EMAIL,
    to: to,
    subject,
    html: `
      <h2>Notificación de la app</h2>
      ${htmlContent}
      <p>Revisa el servidor para más detalles.</p>
    `
  };

  if (CC_EMAIL) payload.cc = CC_EMAIL;

  return payload;
}

async function sendAppointmentEmail(subject, message, details = '', to = LAB_CONTACT_EMAIL) {
  // No hay flag de desactivación: intentaremos enviar si hay API key y destinatario configurados.

  if (!RESEND_API_KEY || !to) {
    console.error('[MAILER] No se puede enviar correo: faltan RESEND_API_KEY o LAB_CONTACT_EMAIL');
    return;
  }

  try {
    console.log(`[MAILER] Enviando email de cita: ${subject} -> ${to}`);
    const html = `
      <p><strong>Asunto:</strong> ${subject}</p>
      <p>${message.replace(/\n/g, '<br/>')}</p>
      ${details ? `<pre style="white-space: pre-wrap;">${details}</pre>` : ''}
    `;

    const payload = formatPayload(subject, html, to);
    await axios.post('https://api.resend.com/emails', payload, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[MAILER] Email de cita enviado a ${to}`);
  } catch (err) {
    console.error('[MAILER] Error enviando email de cita:', err.message || err);
    if (err.response) {
      console.error('[MAILER] Resend API status:', err.response.status);
      console.error('[MAILER] Resend API data:', JSON.stringify(err.response.data));
    }
  }
}

module.exports = { sendAppointmentEmail };
