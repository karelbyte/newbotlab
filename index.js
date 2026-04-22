require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const { startBot, botState } = require('./bot/client.js')
const { sendErrorEmail } = require('./errorNotifier.js')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
})

// página principal: muestra QR o estado conectado
app.get('/', (req, res) => {
  if (botState.hasConnected) {
    return res.send(`
      <html>
      <head>
        <script>
          setInterval(async () => {
            try {
              const res = await fetch('/status', { cache: 'no-store' })
              const data = await res.json()
              if (!data.hasConnected) window.location.reload()
            } catch (err) {}
          }, 5000)
        </script>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>✅ Bot conectado a WhatsApp</h2>
        <p>El bot está activo y escuchando mensajes.</p>
        <p>Estado actual: ${botState.connected ? 'Conectado' : 'Desconectado (intentando reconectar)'}</p>
      </body></html>
    `)
  }

  if (!botState.qr) {
    return res.send(`
      <html>
      <head><meta http-equiv="refresh" content="3"></head>
      <body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>⏳ Iniciando bot...</h2>
        <p>Esperando QR, recargando en 3 segundos...</p>
      </body></html>
    `)
  }

  res.send(`
    <html>
    <head>
      <title>WhatsApp Bot - Escanear QR</title>
      <script>
        function refreshQR() {
          const img = document.getElementById('qrimg')
          img.src = '/qr?t=' + Date.now()
        }

        async function checkStatus() {
          try {
            const res = await fetch('/status', { cache: 'no-store' })
            const data = await res.json()
            console.log('[BOT UI] status:', data)
            if (data.hasConnected) {
              window.location.replace('/')
            }
          } catch (err) {
            console.warn('[BOT UI] Error consultando estado:', err)
          }
        }

        window.addEventListener('load', () => {
          refreshQR()
          checkStatus()
          setInterval(refreshQR, 10000) // 10 segundos
          setInterval(checkStatus, 2000)
        })
      </script>
    </head>
    <body style="font-family:sans-serif;text-align:center;padding:50px">
      <h2>📱 Bot laboratorio clinico integral - Escanea el QR con WhatsApp</h2>
      <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
      <p style="color:#555;">Estado: esperando conexión. Se recargará cuando el bot se conecte.</p>
      <img id="qrimg" src="/qr?t=${Date.now()}" alt="QR Code" style="width:300px;height:300px" onerror="setTimeout(refreshQR,1000)">
      <p style="color:#888;font-size:13px">El QR se actualiza automáticamente</p>
    </body></html>
  `)
})

// estado del bot para polling desde el frontend
app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate')
  res.json({ connected: botState.connected, hasConnected: botState.hasConnected })
})

// endpoint que devuelve el QR como imagen PNG
app.get('/qr', async (req, res) => {
  if (!botState.qr) {
    return res.status(404).send('QR no disponible')
  }
  try {
    const png = await QRCode.toBuffer(botState.qr)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate')
    res.send(png)
  } catch (err) {
    res.status(500).send('Error generando QR')
  }
})

app.use((err, req, res, next) => {
  console.error('Express error:', err)
  void sendErrorEmail('Express error', err)
  res.status(500).json({ error: 'Ocurrió un error en el servidor' })
})

process.on('uncaughtException', err => {
  console.error('uncaughtException:', err)
  void sendErrorEmail('uncaughtException', err)
  process.exit(1)
})

process.on('unhandledRejection', reason => {
  console.error('unhandledRejection:', reason)
  const error = reason instanceof Error ? reason : new Error(String(reason))
  void sendErrorEmail('Unhandled rejection', error)
})

app.listen(PORT, () => {
  console.log(`Servidor Express en puerto ${PORT}`)
})

startBot().catch(err => {
  console.error('Error iniciando bot:', err)
  void sendErrorEmail('Error inicializando bot', err)
})
