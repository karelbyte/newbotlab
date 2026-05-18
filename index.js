require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { startBot, botState, processMessage, userSessions, sendBroadcast, getSockInstance } = require('./bot/client.js');
const { sendErrorEmail } = require('./errorNotifier.js');
const db = require('./localDb.js');

const IGNORE_TIMEOUT_UNHANDLED_REJECTIONS = !['false', '0', 'no', 'off'].includes(String(process.env.IGNORE_TIMEOUT_UNHANDLED_REJECTIONS || 'true').toLowerCase());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Directorios Estáticos y Ruta Dinámica de Cargas
const PERSISTENT_PATH = process.env.PERSISTENT_PATH || '';
const PROMOS_IMGS_PATH = PERSISTENT_PATH 
  ? path.join(PERSISTENT_PATH, 'promos_imgs') 
  : path.join(__dirname, 'promos_imgs');

// Asegurar que la carpeta de promociones exista
if (!fs.existsSync(PROMOS_IMGS_PATH)) {
  fs.mkdirSync(PROMOS_IMGS_PATH, { recursive: true });
}

app.use('/promos_imgs', express.static(PROMOS_IMGS_PATH));

// Configuración de Multer para carga de imágenes promocionales y de campañas
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, PROMOS_IMGS_PATH);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// ==========================================
// RUTAS DE VISTAS (HTML)
// ==========================================

// Servir lab.png para el simulador y vistas si existe
app.get('/lab.webp', (req, res) => {
  const logoPath = path.join(__dirname, 'lab.webp');
  if (fs.existsSync(logoPath)) {
    res.sendFile(logoPath);
  } else {
    res.status(404).send('Logo no disponible');
  }
});

// Página Principal: Centro de Control (Hub)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'hub.html'));
});

// Administrador de Promociones / Banners
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Gestor de Campañas Masivas
app.get('/campaigns', (req, res) => {
  res.sendFile(path.join(__dirname, 'campaigns.html'));
});

// Reportes y Analíticas Clínicas
app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'analytics.html'));
});

// Simulador de Chat Virtual
app.get('/simulator', (req, res) => {
  res.sendFile(path.join(__dirname, 'simulator.html'));
});

// Administrador de Análisis Top
app.get('/top-analyses-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'top_analyses.html'));
});

// Administrador de Agenda
app.get('/agenda-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'agenda.html'));
});

// Vincular QR de WhatsApp (Rebranding Clínico)
app.get('/connection', (req, res) => {
  if (botState.hasConnected) {
    return res.send(`
      <html>
      <head>
        <title>Conexión de WhatsApp | Laboratorio Clínico</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Inter', sans-serif;
            background-color: #f3f4f6;
            color: #1f2937;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background-image: radial-gradient(circle at top right, #e2effd, transparent 40%);
          }
          .card {
            background: white;
            padding: 40px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,80,157,0.08);
            text-align: center;
            max-width: 450px;
            width: 90%;
            border: 1px solid rgba(0,0,0,0.03);
          }
          h2 { color: #00509D; margin-top: 0; font-weight: 800; }
          p { color: #6b7280; font-size: 15px; line-height: 1.5; }
          .btn {
            display: inline-block;
            margin-top: 25px;
            background: #00509D;
            color: white;
            padding: 12px 24px;
            border-radius: 10px;
            text-decoration: none;
            font-weight: 600;
            font-size: 14px;
            transition: background 0.2s;
          }
          .btn:hover { background: #003F7A; }
          .badge {
            background: #dcfce7;
            color: #15803d;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            display: inline-block;
            margin-bottom: 20px;
          }
        </style>
        <script>
          setInterval(async () => {
            try {
              const res = await fetch('/status', { cache: 'no-store' });
              const data = await res.json();
              if (!data.hasConnected) window.location.reload();
            } catch (err) {}
          }, 5000);
        </script>
      </head>
      <body>
        <div class="card">
          <span class="badge">🟢 Servicio Activo</span>
          <h2>✅ Bot Conectado a WhatsApp</h2>
          <p>El asistente virtual está enlazado correctamente y listo para entregar resultados de análisis clínicos.</p>
          <p style="font-size: 13px; color: #9ca3af;">Estado: ${botState.connected ? 'Conectado' : 'Reconectando...'}</p>
          <a href="/" class="btn">Volver al Centro de Control</a>
        </div>
      </body></html>
    `);
  }

  if (!botState.qr) {
    return res.send(`
      <html>
      <head>
        <title>Iniciando Conexión...</title>
        <meta http-equiv="refresh" content="3">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Inter', sans-serif;
            background-color: #f3f4f6;
            color: #1f2937;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
          }
          .card {
            background: white;
            padding: 40px;
            border-radius: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.05);
            text-align: center;
          }
          h2 { color: #00509D; margin-top: 0; }
          .loader {
            border: 4px solid #f3f3f3;
            border-top: 4px solid #00509D;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="loader"></div>
          <h2>⏳ Inicializando WhatsApp Socket...</h2>
          <p>Generando código QR de vinculación, recargando automáticamente...</p>
        </div>
      </body></html>
    `);
  }

  res.send(`
    <html>
    <head>
      <title>WhatsApp Bot - Escanear QR</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Inter', sans-serif;
          background-color: #f3f4f6;
          color: #1f2937;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background-image: radial-gradient(circle at top right, #e2effd, transparent 40%);
        }
        .card {
          background: white;
          padding: 40px;
          border-radius: 20px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.05);
          text-align: center;
          max-width: 480px;
          width: 90%;
          border: 1px solid rgba(0,0,0,0.03);
        }
        h2 { color: #00509D; font-weight: 800; margin-top: 0; }
        p { color: #4b5563; font-size: 14.5px; line-height: 1.5; }
        img {
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 10px;
          background: white;
          box-shadow: 0 4px 6px rgba(0,0,0,0.02);
          margin: 20px 0;
        }
        .btn-back {
          display: inline-block;
          margin-top: 15px;
          color: #00509D;
          text-decoration: none;
          font-weight: 600;
          font-size: 13.5px;
        }
      </style>
      <script>
        function refreshQR() {
          const img = document.getElementById('qrimg');
          img.src = '/qr?t=' + Date.now();
        }

        async function checkStatus() {
          try {
            const res = await fetch('/status', { cache: 'no-store' });
            const data = await res.json();
            if (data.hasConnected) {
              window.location.replace('/connection');
            }
          } catch (err) {}
        }

        window.addEventListener('load', () => {
          refreshQR();
          checkStatus();
          setInterval(refreshQR, 10000);
          setInterval(checkStatus, 2500);
        });
      </script>
    </head>
    <body>
      <div class="card">
        <h2>📱 Vincular WhatsApp</h2>
        <p>Abre WhatsApp en tu teléfono → Configuración → Dispositivos vinculados → Escanea el código QR de abajo.</p>
        <img id="qrimg" src="/qr?t=${Date.now()}" alt="Código QR" style="width:260px;height:260px;" onerror="setTimeout(refreshQR,1000)">
        <p style="color:#9ca3af;font-size:12px;">El código QR se actualiza automáticamente cada 10 segundos.</p>
        <a href="/" class="btn-back">← Volver al Centro de Control</a>
      </div>
    </body></html>
  `);
});

// ==========================================
// ENDPOINTS DE CONTROL Y QR
// ==========================================

// Endpoint para polling de estado
app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
  res.json({ connected: botState.connected, hasConnected: botState.hasConnected });
});

// Servir la imagen QR generada por Baileys
app.get('/qr', async (req, res) => {
  if (!botState.qr) {
    return res.status(404).send('QR no disponible');
  }
  try {
    const png = await QRCode.toBuffer(botState.qr);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
    res.send(png);
  } catch (err) {
    res.status(500).send('Error generando QR');
  }
});

// ==========================================
// APIS DE AVISOS Y PROMOCIONES (SQLITE CRUD)
// ==========================================
app.get('/api/promotions', async (req, res) => {
  try {
    const promos = await db.getAllPromotions();
    res.json(promos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/promotions', upload.single('image'), async (req, res) => {
  try {
    const { text, position } = req.body;
    const imageUrl = req.file ? `/promos_imgs/${req.file.filename}` : null;
    await db.addPromotion(text, imageUrl, position);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/promotions/:id', async (req, res) => {
  try {
    await db.updatePromotion(req.params.id, req.body.active);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/promotions/:id', async (req, res) => {
  try {
    await db.deletePromotion(req.params.id);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// APIS DE CAMPAÑAS MASIVAS (SQLITE CRUD)
// ==========================================
app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await db.getAllCampaigns();
    res.json(campaigns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/campaigns', upload.single('image'), async (req, res) => {
  try {
    const { text } = req.body;
    const imageUrl = req.file ? `/promos_imgs/${req.file.filename}` : null;
    await db.addCampaign(text, imageUrl);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await db.deleteCampaign(req.params.id);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lanzamiento asíncrono en background de campaña masiva
app.post('/api/campaigns/:id/send', async (req, res) => {
  try {
    const sock = getSockInstance();
    if (!sock || !botState.connected) {
      return res.status(400).json({ error: 'El bot de WhatsApp no está conectado o el socket no se ha inicializado.' });
    }

    const dbConn = await db.getLocalDb();
    const campaign = await dbConn.get('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaña no encontrada' });
    }

    const clients = await db.getAllClients();
    if (clients.length === 0) {
      return res.status(400).json({ error: 'No hay pacientes registrados en la base de datos para realizar envíos.' });
    }

    // Ejecutar en segundo plano (non-blocking)
    sendBroadcast(sock, clients, campaign.text, campaign.image_url)
      .then(() => console.log(`[CAMPAÑA] Envíos terminados para la campaña ID: ${campaign.id}`))
      .catch(err => console.error('[CAMPAÑA] Error durante envío masivo:', err));

    res.json({ success: true, targets: clients.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// ENDPOINT DE ANALÍTICAS
// ==========================================
app.get('/api/analytics', async (req, res) => {
  try {
    const stats = await db.getAnalyticsStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// APIS DE ANÁLISIS TOP (SQLITE CRUD)
// ==========================================
app.get('/api/top-analyses', async (req, res) => {
  try {
    const analyses = await db.getAllTopAnalyses();
    res.json(analyses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/top-analyses', upload.single('image'), async (req, res) => {
  try {
    const { number, name, description, price } = req.body;
    const imageUrl = req.file ? `/promos_imgs/${req.file.filename}` : null;
    await db.addTopAnalysis(number, name, description, price, imageUrl);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/top-analyses/:id', async (req, res) => {
  try {
    await db.deleteTopAnalysis(req.params.id);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// APIS DE AGENDA (SQLITE CRUD)
// ==========================================
app.get('/api/agenda', async (req, res) => {
  try {
    const agendas = await db.getAllAgendas();
    res.json(agendas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agenda/export', async (req, res) => {
  try {
    const agendas = await db.getAllAgendas();
    let csv = 'ID,Telefono,Paciente,Analisis,Fecha_Hora_Cita,Fecha_Registro\n';
    for (const a of agendas) {
      const phone = a.client_phone || '';
      const name = (a.client_name || 'Paciente').replace(/,/g, ' ');
      const analysis = (a.analysis_name || '').replace(/,/g, ' ');
      const schedule = (a.schedule_text || '').replace(/,/g, ' ');
      const created = a.created_at || '';
      csv += `${a.id},"${phone}","${name}","${analysis}","${schedule}","${created}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=agenda_citas.csv');
    res.status(200).send('\uFEFF' + csv);
  } catch (err) {
    console.error('Error exportando agenda:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agenda/:id', async (req, res) => {
  try {
    await db.deleteAgenda(req.params.id);
    res.sendStatus(200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// ENDPOINTS DEL SIMULADOR DE CHAT
// ==========================================

// Limpiar sesión virtual de pruebas
app.post('/chat/reset', (req, res) => {
  userSessions.delete('simulator_preview');
  res.json({ success: true });
});

// Procesar conversación en dryRun (simulado)
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'El mensaje es requerido' });

    // Invoca processMessage con dryRun = true
    const responses = await processMessage(
      null, // sin socket real
      'simulator_preview', // ID de chat simulador
      '5555555555', // teléfono virtual del paciente simulado
      message,
      'Paciente Simulador',
      true // dryRun = true
    );

    res.json({ responses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// CAPTURA DE ERRORES Y MANEJO DE SEÑALES
// ==========================================

app.use((err, req, res, next) => {
  console.error('Express error:', err);
  void sendErrorEmail('Express error', err);
  res.status(500).json({ error: 'Ocurrió un error en el servidor' });
});

process.on('uncaughtException', err => {
  console.error('uncaughtException:', err);
  void sendErrorEmail('uncaughtException', err);
  process.exit(1);
});

function shouldReportUnhandledRejection(reason) {
  if (!IGNORE_TIMEOUT_UNHANDLED_REJECTIONS) return true;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const message = String(error.message || '');
  const payloadMessage = String(reason?.output?.payload?.message || '');

  const isTimeoutError = /timed out/i.test(message) || /request time-?out/i.test(message) || /timed out/i.test(payloadMessage);
  if (isTimeoutError) {
    console.log('[UNHANDLED REJECTION] Ignorado por timeout:', message || payloadMessage);
    return false;
  }
  return true;
}

process.on('unhandledRejection', reason => {
  console.error('unhandledRejection:', reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));

  if (!shouldReportUnhandledRejection(reason)) {
    return;
  }

  const now = Date.now();
  if (!global.lastUnhandledRejectionEmail || now - global.lastUnhandledRejectionEmail > 60 * 60 * 1000) { // 1 hour
    global.lastUnhandledRejectionEmail = now;
    void sendErrorEmail('Unhandled rejection', error);
  } else {
    console.log('[THROTTLE] Unhandled rejection email throttled');
  }
});

// ==========================================
// INICIALIZACIÓN DEL SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log(`Servidor Express en puerto ${PORT}`);
});

startBot().catch(err => {
  console.error('Error iniciando bot:', err);
  void sendErrorEmail('Error inicializando bot', err);
});
