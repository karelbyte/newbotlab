const axios = require('axios')

const RESEND_API_KEY = process.env.RESEND_API_KEY
const CONTACT_EMAIL = process.env.LAB_CONTACT_EMAIL
const CC_EMAIL = process.env.CC_LAB_CONTACT_EMAIL
const FROM_EMAIL = process.env.MAIL_FROM || CONTACT_EMAIL

function isWithinBusinessHours() {
  const now = new Date()
  const hour = now.getHours()
  return hour >= 8 && hour < 19
}

function formatPayload(subject, htmlContent) {
  const payload = {
    from: FROM_EMAIL,
    to: CONTACT_EMAIL,
    subject,
    html: `
      <h2>Notificación de la app</h2>
      ${htmlContent}
      <p>Revisa el servidor para más detalles.</p>
    `
  }

  // Agregar CC si está configurado
  if (CC_EMAIL) {
    payload.cc = CC_EMAIL
  }

  return payload
}

async function sendErrorEmail(subject, error) {
  if (!RESEND_API_KEY || !CONTACT_EMAIL) {
    console.error('No se puede enviar correo: RESEND_API_KEY o LAB_CONTACT_EMAIL faltan en .env')
    return
  }

  if (!isWithinBusinessHours()) {
    console.log(`[EMAIL] Horario fuera de envío: no se envía email de error (${subject})`)
    return
  }

  try {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : ''
    console.error(`[EMAIL] Error reportado por email: ${subject}`)
    console.error(`[EMAIL] ${message}`)
    if (stack) console.error(`[EMAIL] ${stack}`)

    const html = `
      <p><strong>Asunto:</strong> ${subject}</p>
      <p><strong>Mensaje:</strong> ${message}</p>
      <pre style="white-space: pre-wrap;">${stack}</pre>
    `
    const payload = formatPayload(subject, html)
    await axios.post('https://api.resend.com/emails', payload, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    })
    console.log(`[EMAIL] Email de error enviado a ${CONTACT_EMAIL}`)
  } catch (sendError) {
    console.error(`[EMAIL] No se pudo enviar el email de error: ${sendError.message || sendError}`)
    if (sendError.response) {
      console.error(`[EMAIL] Resend API response status: ${sendError.response.status}`)
      console.error(`[EMAIL] Resend API response data: ${JSON.stringify(sendError.response.data)}`)
    }
  }
}

async function sendNotificationEmail(subject, message, details = '') {
  if (!RESEND_API_KEY || !CONTACT_EMAIL) {
    console.error('[EMAIL] No se puede enviar correo: RESEND_API_KEY o LAB_CONTACT_EMAIL faltan en .env')
    return
  }

  if (!isWithinBusinessHours()) {
    console.log(`[EMAIL] Horario fuera de envío: no se envía email de notificación (${subject})`)
    return
  }

  try {
    console.log(`[EMAIL] Notificación enviada por email: ${subject}`)
    console.log(`[EMAIL] ${message}`)
    if (details) console.log(`[EMAIL] ${details}`)

    const html = `
      <p><strong>Asunto:</strong> ${subject}</p>
      <p>${message}</p>
      ${details ? `<pre style="white-space: pre-wrap;">${details}</pre>` : ''}
    `
    const payload = formatPayload(subject, html)
    await axios.post('https://api.resend.com/emails', payload, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      }
    })
    console.log(`[EMAIL] Email de notificación enviado a ${CONTACT_EMAIL}`)
  } catch (sendError) {
    console.error(`[EMAIL] No se pudo enviar el email de notificación: ${sendError.message || sendError}`)
    if (sendError.response) {
      console.error(`[EMAIL] Resend API response status: ${sendError.response.status}`)
      console.error(`[EMAIL] Resend API response data: ${JSON.stringify(sendError.response.data)}`)
    }
  }
}

module.exports = {
  sendErrorEmail,
  sendNotificationEmail
}
