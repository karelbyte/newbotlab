import 'dotenv/config'
import express from 'express'
import QRCode from 'qrcode'
import { startBot, botState } from './bot/client.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// página principal: muestra QR o estado conectado
app.get('/', (req, res) => {
  if (botState.connected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>✅ Bot conectado a WhatsApp</h2>
        <p>El bot está activo y escuchando mensajes.</p>
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
        // refresca solo la imagen cada 3s con timestamp para evitar caché
        function refreshQR() {
          const img = document.getElementById('qrimg')
          img.src = '/qr?t=' + Date.now()
        }
        setInterval(refreshQR, 3000)

        // si el bot se conectó, recarga la página completa
        setInterval(() => {
          fetch('/status').then(r => r.json()).then(d => {
            if (d.connected) location.reload()
          })
        }, 4000)
      </script>
    </head>
    <body style="font-family:sans-serif;text-align:center;padding:50px">
      <h2>📱 Bot laboratorio clinico integral - Escanea el QR con WhatsApp</h2>
      <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
      <img id="qrimg" src="/qr?t=${Date.now()}" alt="QR Code" style="width:300px;height:300px">
      <p style="color:#888;font-size:13px">El QR se actualiza automáticamente</p>
    </body></html>
  `)
})

// estado del bot para polling desde el frontend
app.get('/status', (req, res) => {
  res.json({ connected: botState.connected })
})

// endpoint que devuelve el QR como imagen PNG
app.get('/qr', async (req, res) => {
  if (!botState.qr) {
    return res.status(404).send('QR no disponible')
  }
  try {
    const png = await QRCode.toBuffer(botState.qr)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'no-cache, no-store')
    res.send(png)
  } catch (err) {
    res.status(500).send('Error generando QR')
  }
})

app.listen(PORT, () => {
  console.log(`Servidor Express en puerto ${PORT}`)
})

startBot().catch(console.error)
