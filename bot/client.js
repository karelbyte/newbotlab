const pino = require('pino')
const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const { rmSync, existsSync } = require('fs')
const path = require('path')
const { sendErrorEmail, sendNotificationEmail } = require('../errorNotifier.js')

const SESSION_PATH = path.join(__dirname, '../sessions')
const API_URL = 'https://storelab.laboratorioclinicointegral.com/api'

const prisma = new PrismaClient()

const GREETINGS = ['hola', 'saludos', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'hello']

// estados por usuario: 'waiting_code' o null
const userState = new Map()

function isGreeting(text) {
  const normalized = text.toLowerCase().trim()
  return GREETINGS.some(g => normalized.includes(g))
}

async function getClientName(phone, fallback) {
  const normalizedPhone = phone.replace(/[^0-9]/g, '')
  const localPhone = normalizedPhone.slice(-10)

  try {
    const client = await prisma.client.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          { phone: localPhone }
        ]
      }
    })
    if (client?.name) {
      return client.name
    }
  } catch (err) {
    console.log('[DB] Error querying client:', err.message)
    await sendErrorEmail('Error consultando cliente en DB', err)
  }

  try {
    const apiPhone = localPhone
    const response = await axios.get(`${API_URL}/get-service/${apiPhone}`, {
      timeout: 20000
    })
    const data = response.data
    const name = data?.datatos?.name || data?.name || data?.nombre || data?.cliente?.nombre || data?.client?.name
    if (name) {
      console.log('[API] Cliente encontrado por teléfono:', apiPhone, name)
      try {
        await prisma.client.upsert({
          where: { phone: localPhone },
          update: { name },
          create: { phone: localPhone, name }
        })
      } catch (saveErr) {
        console.warn('[DB] No se pudo guardar cliente API en DB:', saveErr.message)
      }
      return name
    }
    console.log('[API] Cliente no encontrado en API para teléfono:', apiPhone, data)
  } catch (err) {
    console.log('[API] Error consultando cliente en API:', err.message)
  }

  return fallback
}

async function handleCode(sock, from, phone, code) {
  const localPhone = phone.slice(-10)
  console.log(`Consultando resultados - Código: ${code} | Telf: ${localPhone}`)

  // indicador de "escribiendo..." mientras consulta
  await sock.sendPresenceUpdate('composing', from)
  await sock.sendMessage(from, { text: `🔍 Consultando tu código *${code}*...` })

  try {
    // Primero intenta consultar la DB local
    let result = await prisma.result.findUnique({
      where: { barcode: code }
    })

    // Si no está en DB, consulta la API
    if (!result) {
      try {
        const response = await axios.get(`${API_URL}/get-service-by-barcode/${localPhone}/${code}`, {
          timeout: 30000
        })
        const data = response.data
        if (data && data.barcode) {
          // Guarda en DB para futuras consultas
          result = await prisma.result.upsert({
            where: { barcode: code },
            update: {
              phone: localPhone,
              status_id: data.status_id || 2,
              urls: data.urls || null
            },
            create: {
              barcode: code,
              phone: localPhone,
              status_id: data.status_id || 2,
              urls: data.urls || null
            }
          })
          console.log('[API] Resultado guardado en DB desde API:', code)
        }
      } catch (apiErr) {
        console.log('[API] Error consultando resultado en API:', apiErr.message)
      }
    }

    if (!result || result.phone !== localPhone) {
      console.log('Resultado: Código no encontrado en DB')
      await sock.sendMessage(from, { text: `❌ No se encontró el código: *${code}*` })
      try {
        await prisma.queryLog.create({
          data: {
            phone: localPhone,
            barcode: code,
            found: false,
            status_id: result?.status_id ?? null,
            message: 'Código no encontrado'
          }
        })
        console.log('[DB] QueryLog creado: código no encontrado', code)
      } catch (logErr) {
        console.error('[DB] No se pudo guardar QueryLog:', logErr)
      }
    } else if (result.status_id === 1) {
      await sock.sendMessage(from, { text: `🚫 Pendiente de pago. Contacte al (755) 108 48 00.` })
      try {
        await prisma.queryLog.create({
          data: {
            phone: localPhone,
            barcode: code,
            found: true,
            status_id: result.status_id,
            message: 'Pendiente de pago'
          }
        })
        console.log('[DB] QueryLog creado: pendiente de pago', code)
      } catch (logErr) {
        console.error('[DB] No se pudo guardar QueryLog:', logErr)
      }
    } else if (result.status_id === 2) {
      console.log('Resultado: Entregando documentos', result.urls)
      try {
        await prisma.queryLog.create({
          data: {
            phone: localPhone,
            barcode: code,
            found: true,
            status_id: result.status_id,
            message: 'Resultado encontrado y entrega iniciada'
          }
        })
        console.log('[DB] QueryLog creado: resultado encontrado', code)
      } catch (logErr) {
        console.error('[DB] No se pudo guardar QueryLog de éxito:', logErr)
      }

      let entregados = 0
      const urls = result.urls || []
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]['path' + i]
        if (!url) continue
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 })
          const buffer = Buffer.from(response.data)
          const docName = urls[i]['name' + i] || `Resultado ${i + 1}`
          const filename = docName.replace(/[,\s]+/g, '_').replace(/_+/g, '_') + '.pdf'
          await sock.sendMessage(from, {
            document: buffer,
            mimetype: 'application/pdf',
            fileName: filename,
            caption: `📄 ${docName}`
          })
          entregados++
        } catch (err) {
          console.log(`Error descargando PDF ${url}:`, err.message)
          if (err.response?.status === 404) {
            await sock.sendMessage(from, { text: `⚠️ El resultado aún no está disponible. Comunícate con nosotros al *(755) 108 48 00*.` })
          } else {
            await sock.sendMessage(from, { text: `📄 Documento ${i + 1}: ${url}` })
            entregados++
          }
        }
      }
      if (entregados > 0) {
        await sock.sendMessage(from, { text: `✅ Resultados entregados.` })
      }
    }
  } catch (err) {
    console.log('Error consultando DB:', err.message)
    await sendErrorEmail(`Error procesando código ${code}`, err)
    await sock.sendMessage(from, { text: `⚠️ Error consultando resultados. Intenta más tarde.` })
    try {
      await prisma.queryLog.create({
        data: {
          phone: localPhone,
          barcode: code,
          found: false,
          status_id: null,
          message: `Error al consultar: ${err.message}`
        }
      })
      console.log('[DB] QueryLog creado: error al consultar', code)
    } catch (logErr) {
      console.error('[DB] No se pudo guardar QueryLog de error:', logErr)
    }
  } finally {
    await sock.sendPresenceUpdate('paused', from)
  }

  userState.set(from, 'waiting_code')
  await sock.sendMessage(from, { text: `¿Tienes otro código que consultar? Indícalo o escribe *no* para terminar.` })
}

const botState = {
  qr: null,
  connected: false,
  hasConnected: false
}

async function startBot() {
  const baileys = await import('@whiskeysockets/baileys')
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
  } = baileys

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      botState.qr = qr
      botState.connected = false
      console.log('Nuevo QR generado')
      await sendNotificationEmail(
        'Bot WhatsApp requiere escaneo QR',
        'Se ha generado un nuevo QR porque la sesión no está activa o la sesión anterior fue invalidada.',
        `Estado de conexión: ${connection}`
      ).catch(err => console.error('Error enviando notificación de QR:', err))
    }
    if (connection === 'close') {
      botState.connected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect) {
        await sendNotificationEmail(
          'Bot WhatsApp reconectando sin escaneo',
          'La conexión se cerró temporalmente y el bot intentará reconectar usando la sesión existente.',
          `Código de cierre: ${statusCode}`
        ).catch(err => console.error('Error enviando notificación de reconexión sin QR:', err))
        startBot()
      } else {
        await sendNotificationEmail(
          'Bot WhatsApp requiere nuevo escaneo QR',
          'La sesión fue cerrada por WhatsApp y se borrará la sesión local para generar un nuevo QR.',
          `Código de cierre: ${statusCode}`
        ).catch(err => console.error('Error enviando notificación de reconexión con QR:', err))
        console.log('Sesión cerrada por el usuario, limpiando sesión...')
        botState.qr = null
        if (existsSync(SESSION_PATH)) {
          rmSync(SESSION_PATH, { recursive: true, force: true })
        }
        startBot()
      }
    }
    if (connection === 'open') {
      botState.qr = null
      botState.connected = true
      botState.hasConnected = true
      console.log('Bot conectado a WhatsApp')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue

        const from = msg.key.remoteJid
        const phone = (msg.key.senderPn || from)
          .replace('@s.whatsapp.net', '')
          .replace('@g.us', '')
          .replace('@lid', '')

        const name = msg.pushName || 'desconocido'
        console.log(`Mensaje recibido de: +${phone} (${name})`)

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          ''

        console.log('[BOT] texto recibido:', text)

        const normalizedText = text.toLowerCase().trim()
        const codeCandidate = text.toUpperCase().trim()

        // si el usuario está esperando ingresar su código
        if (userState.get(from) === 'waiting_code') {
          if (['no', 'no gracias', 'nope', 'nel'].includes(normalizedText)) {
            userState.delete(from)
            const clientName = await getClientName(phone, null)
            const farewellName = clientName ? ` ${clientName}` : ''
            await sock.sendMessage(from, { text: `Hasta luego${farewellName} 👋\n\nGracias por contactar a *Laboratorio Clínico Integral*.\nRecuerda que estamos en:\n📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Lunes a Viernes 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n📧 contacto@laboratorioclinicointegral.com\n\n¡Que tenga un excelente día! 😊` })
            continue
          }
          userState.delete(from)
          await handleCode(sock, from, phone, codeCandidate)
          continue
        }

        if (isGreeting(text)) {
          const clientName = await getClientName(phone, null)
          await sock.sendMessage(from, { text: `*Laboratorio Clínico Integral*` })
          if (clientName) {
            await sock.sendMessage(from, { text: `📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Horario: 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n📧 contacto@laboratorioclinicointegral.com\n\nBienvenido 👋\n\*${clientName}* ` })
          } else {
            await sock.sendMessage(from, { text: `📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Horario: 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n📧 contacto@laboratorioclinicointegral.com\n\nBienvenido 👋` })
          }
          userState.set(from, 'waiting_code')
          await sock.sendMessage(from, { text: `Indica tu código de análisis:` })
          continue
        }

        if (/^[A-Z0-9-]{4,}$/.test(codeCandidate)) {
          await handleCode(sock, from, phone, codeCandidate)
          continue
        }

        await sock.sendMessage(from, {
          text: `No reconozco ese mensaje. Envía tu código de análisis o escribe *hola* para comenzar.`
        })
      }
    } catch (err) {
      console.error('Error manejando mensaje de WhatsApp:', err)
      await sendErrorEmail('Error manejando mensaje de WhatsApp', err)
    }
  })
}

module.exports = {
  botState,
  startBot
}
