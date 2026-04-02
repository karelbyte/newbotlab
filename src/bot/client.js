import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import pino from 'pino'
import axios from 'axios'
import { fileURLToPath } from 'url'
import { rmSync, existsSync } from 'fs'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_PATH = path.join(__dirname, '../../sessions')
const API_URL = 'https://storelab.laboratorioclinicointegral.com/api'

const GREETINGS = ['hola', 'saludos', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'hello']

// estados por usuario: 'waiting_code' o null
const userState = new Map()

function isGreeting(text) {
  const normalized = text.toLowerCase().trim()
  return GREETINGS.some(g => normalized.includes(g))
}

async function getClientName(phone, fallback) {
  try {
    const localPhone = phone.slice(-10)
    const res = await axios.get(`${API_URL}/get-service/${localPhone}`, { timeout: 12000 })
    return res.data?.name || fallback
  } catch {
    return fallback
  }
}

async function handleCode(sock, from, phone, code) {
  const localPhone = phone.slice(-10)
  console.log(`Consultando resultados - Código: ${code} | Telf: ${localPhone}`)

  // indicador de "escribiendo..." mientras consulta
  await sock.sendPresenceUpdate('composing', from)
  await sock.sendMessage(from, { text: `🔍 Consultando tu código *${code}*...` })

  try {
    const { data } = await axios.get(`${API_URL}/get-service-by-barcode/${localPhone}/${code}`, { timeout: 12000 })

    if (!data || !data.id) {
      console.log('Resultado: Código no encontrado en API')
      await sock.sendMessage(from, { text: `❌ No se encontró el código: *${code}*` })
    } else if (data.status_id === 1) {
      await sock.sendMessage(from, { text: `🚫 Pendiente de pago. Contacte al (755) 108 48 00.` })
    } else if (data.status_id === 2) {
      console.log('Resultado: Entregando documentos', data.urls)
      let entregados = 0
      for (let i = 0; i < data.urls.length; i++) {
        const url = data.urls[i]['path' + i]
        if (!url) continue
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 })
          const buffer = Buffer.from(response.data)
          const docName = data.urls[i]['name' + i] || `Resultado ${i + 1}`
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
    console.log('Error consultando API:', err.message)
    await sock.sendMessage(from, { text: `⚠️ Error consultando resultados. Intenta más tarde.` })
  } finally {
    await sock.sendPresenceUpdate('paused', from)
  }

  userState.set(from, 'waiting_code')
  await sock.sendMessage(from, { text: `¿Tienes otro código que consultar? Indícalo o escribe *no* para terminar.` })
}

export const botState = {
  qr: null,
  connected: false
}

export async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      botState.qr = qr
      botState.connected = false
      console.log('Nuevo QR generado')
    }
    if (connection === 'close') {
      botState.connected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Conexión cerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect) {
        startBot()
      } else {
        // logout: limpiar sesión y reiniciar para mostrar QR nuevo
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
      console.log('Bot conectado a WhatsApp')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
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
        ''

      // si el usuario está esperando ingresar su código
      if (userState.get(from) === 'waiting_code') {
        if (['no', 'no gracias', 'nope', 'nel'].includes(text.toLowerCase().trim())) {
          userState.delete(from)
          await sock.sendMessage(from, { text: `Hasta luego 👋\n\nGracias por contactar a *Laboratorio Clínico Integral*.\nRecuerda que estamos en:\n📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Lunes a Viernes 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n📧 contacto@laboratorioclinicointegral.com\n\n¡Que tenga un excelente día! 😊` })
          continue
        }
        userState.delete(from)
        const code = text.toUpperCase().trim()
        await handleCode(sock, from, phone, code)
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
      }
    }
  })
}
