const pino = require('pino')
const axios = require('axios')
const { rmSync, existsSync } = require('fs')
const path = require('path')
const os = require('os')
const { sendErrorEmail, sendNotificationEmail } = require('../errorNotifier.js')
const fs = require('fs')
const { readdirSync, statSync, unlinkSync } = require('fs')
const v8 = require('v8')

const SESSION_PATH = path.join(__dirname, '../sessions')
const API_URL = process.env.API_URL || 'https://storelab.laboratorioclinicointegral.com/api'

const GREETINGS = ['hola', 'saludos', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'hello']

// estados por usuario: 'waiting_code' o null
const userState = new Map()

// Control de throttle para notificaciones de cambios de conexión (evitar correos duplicados)
const notificationThrottle = new Map()
const THROTTLE_TIME = 30 * 60 * 1000 // 30 minutos

let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5

function canSendNotification(notificationType) {
  const now = Date.now()
  const lastTime = notificationThrottle.get(notificationType) || 0
  if (now - lastTime < THROTTLE_TIME) {
    console.log(`[THROTTLE] Notificación '${notificationType}' fue enviada hace poco, ignorando.`)
    return false
  }
  notificationThrottle.set(notificationType, now)
  return true
}

function isGreeting(text) {
  const normalized = text.toLowerCase().trim()
  return GREETINGS.some(g => normalized.includes(g))
}

async function getClientName(phone, fallback) {
  const normalizedPhone = phone.replace(/[^0-9]/g, '')
  const localPhone = normalizedPhone.slice(-10)

  try {
    const apiPhone = localPhone
    const response = await axios.get(`${API_URL}/get-service/${apiPhone}`, {
      timeout: 20000
    })
    const data = response.data
    const name = data?.datatos?.name || data?.name || data?.nombre || data?.cliente?.nombre || data?.client?.name
    if (name) {
      console.log('[API] Cliente encontrado por teléfono:', apiPhone, name)
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
    const response = await axios.get(`${API_URL}/get-service-by-barcode/${localPhone}/${code}`, {
      timeout: 30000
    })
    const data = response.data

    if (!data || !data.barcode) {
      console.log('Resultado: Código no encontrado')
      await sock.sendMessage(from, { text: `❌ No se encontró el código: *${code}*` })
    } else if (data.status_id === 1) {
      await sock.sendMessage(from, { text: `🚫 Pendiente de pago. Contacte al (755) 108 48 00.` })
    } else if (data.status_id === 2) {
      console.log('Resultado: Entregando documentos', data.urls)

      let entregados = 0
      const urls = data.urls || []
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]['path' + i]
        if (!url) continue
        try {
          const response = await axios.get(url, { responseType: 'stream', timeout: 30000 })
          const docName = urls[i]['name' + i] || `Resultado ${i + 1}`
          const filename = path.join(os.tmpdir(), `${docName.replace(/[\/,\s]+/g, '_')}_${Date.now()}.pdf`)

          // Guardar archivo temporalmente en disco
          const writer = fs.createWriteStream(filename)
          response.data.pipe(writer)

          await new Promise((resolve, reject) => {
            writer.on('finish', resolve)
            writer.on('error', reject)
          })

          await sock.sendMessage(from, {
            document: { url: filename },
            mimetype: 'application/pdf',
            fileName: docName,
            caption: `📄 ${docName}`
          })

          // Eliminar archivo temporal
          fs.unlinkSync(filename)
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
    console.log('Error consultando API:', err.message)
    await sendErrorEmail(`Error procesando código ${code}`, err)
    await sock.sendMessage(from, { text: `⚠️ Error consultando resultados. Intenta más tarde.` })
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
      if (!botState.hasConnected && canSendNotification('qr_generated')) {
        await sendNotificationEmail(
          'Bot WhatsApp requiere escaneo QR',
          'Se ha generado un nuevo QR porque la sesión no está activa o la sesión anterior fue invalidada.',
          `Estado de conexión: ${connection}`
        ).catch(err => console.error('Error enviando notificación de QR:', err))
      }
    }
    if (connection === 'close') {
      botState.connected = false
      botState.qr = null // Asegurar que el QR se reinicie correctamente
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        console.log(`Intentando reconectar automáticamente... (Intento ${reconnectAttempts} de ${MAX_RECONNECT_ATTEMPTS})`)
        startBot()
      } else {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.error('Se alcanzó el límite máximo de intentos de reconexión.')
        }
        if (!botState.hasConnected && canSendNotification('reconnect_with_qr')) {
          await sendNotificationEmail(
            'Bot WhatsApp requiere nuevo escaneo QR',
            'La sesión fue cerrada por WhatsApp y se borrará la sesión local para generar un nuevo QR.',
            `Código de cierre: ${statusCode}`
          ).catch(err => console.error('Error enviando notificación de reconexión con QR:', err))
        }
        console.log('Sesión cerrada por el usuario, limpiando sesión...')
        botState.qr = null
        botState.hasConnected = false
        if (existsSync(SESSION_PATH)) {
          rmSync(SESSION_PATH, { recursive: true, force: true })
        }
        reconnectAttempts = 0 // Reset attempts after manual intervention
        startBot()
      }
    }
    if (connection === 'open') {
      botState.qr = null
      botState.connected = true
      botState.hasConnected = true
      reconnectAttempts = 0 // Reset attempts on successful connection
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

// Limpieza periódica de mapas para evitar acumulación de memoria
setInterval(() => {
  const THROTTLE_CLEANUP_TIME = 2 * 60 * 60 * 1000; // 2 horas
  const now = Date.now();

  // Limpiar notificationThrottle
  for (const [key, lastTime] of notificationThrottle.entries()) {
    if (now - lastTime > THROTTLE_CLEANUP_TIME) {
      notificationThrottle.delete(key);
    }
  }

  // Limpiar userState
  for (const [key, state] of userState.entries()) {
    if (state === null) {
      userState.delete(key);
    }
  }
}, 60 * 60 * 1000); // Ejecutar cada hora

// Limpieza periódica de sesiones antiguas
setInterval(() => {
  const SESSION_EXPIRATION_TIME = 7 * 24 * 60 * 60 * 1000; // 7 días
  const now = Date.now();

  try {
    const files = readdirSync(SESSION_PATH);
    for (const file of files) {
      const filePath = path.join(SESSION_PATH, file);
      const stats = statSync(filePath);
      if (now - stats.mtimeMs > SESSION_EXPIRATION_TIME) {
        unlinkSync(filePath);
        console.log(`Sesión eliminada: ${file}`);
      }
    }
  } catch (err) {
    console.error('Error limpiando sesiones antiguas:', err);
  }
}, 24 * 60 * 60 * 1000); // Ejecutar cada 24 horas

// Monitorear uso de memoria cada 5 minutos
setInterval(logMemoryUsage, 5 * 60 * 1000);

function logMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();

  console.log('[MEMORY USAGE]');
  console.log(`RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Total: ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log(`External: ${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Heap Limit: ${(heapStats.heap_size_limit / 1024 / 1024).toFixed(2)} MB`);
}

module.exports = {
  botState,
  startBot
}
