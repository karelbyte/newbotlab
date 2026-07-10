const pino = require('pino');
const axios = require('axios');
const { rmSync, existsSync } = require('fs');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { readdirSync, statSync, unlinkSync } = require('fs');
const v8 = require('v8');
const db = require('../localDb.js');

const PERSISTENT_PATH = process.env.PERSISTENT_PATH || '';
const SESSION_PATH = PERSISTENT_PATH 
  ? path.join(PERSISTENT_PATH, 'sessions') 
  : path.join(__dirname, '../sessions');

const PROMOS_IMGS_PATH = PERSISTENT_PATH 
  ? path.join(PERSISTENT_PATH, 'promos_imgs') 
  : path.join(__dirname, '../promos_imgs');

// Asegurar que la carpeta de sesiones exista
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

const API_URL = process.env.API_URL || 'https://storelab.laboratorioclinicointegral.com/api';

const GREETINGS = ['hola', 'saludos', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'hello'];

// Estados de sesión en memoria
const userSessions = new Map();

// Control de throttle para notificaciones de cambios de conexión (evitar correos duplicados)
const notificationThrottle = new Map();
const THROTTLE_TIME = 30 * 60 * 1000; // 30 minutos
const QR_NOTIFICATION_THROTTLE_KEY = 'qr_notification';
const QR_NOTIFICATION_STATE_FILE = path.join(SESSION_PATH, 'last_qr_notification.json');

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let botRestartTimeout = null;
let sockInstance = null; // Instancia global activa de Baileys

function getLastQrNotificationTime() {
  try {
    if (!existsSync(QR_NOTIFICATION_STATE_FILE)) return 0;
    const data = fs.readFileSync(QR_NOTIFICATION_STATE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return parsed?.lastTime || 0;
  } catch (err) {
    console.error('[QR] No se pudo leer el timestamp de notificación:', err.message);
    return 0;
  }
}

function setLastQrNotificationTime(time) {
  try {
    fs.writeFileSync(QR_NOTIFICATION_STATE_FILE, JSON.stringify({ lastTime: time }), 'utf8');
  } catch (err) {
    console.error('[QR] No se pudo guardar el timestamp de notificación:', err.message);
  }
}

function canSendNotification(notificationType, throttleTime = THROTTLE_TIME) {
  const now = Date.now();
  let lastTime = notificationThrottle.get(notificationType) || 0;

  if (notificationType === QR_NOTIFICATION_THROTTLE_KEY) {
    lastTime = Math.max(lastTime, getLastQrNotificationTime());
  }

  if (now - lastTime < throttleTime) {
    console.log(`[THROTTLE] Notificación '${notificationType}' fue enviada hace poco, ignorando.`);
    return false;
  }

  notificationThrottle.set(notificationType, now);
  if (notificationType === QR_NOTIFICATION_THROTTLE_KEY) {
    setLastQrNotificationTime(now);
  }

  return true;
}

function scheduleBotRestart(delay = 30000) {
  if (botRestartTimeout) {
    console.log('[BOT] Reinicio de bot ya programado, ignorando nuevo intento.');
    return;
  }

  botRestartTimeout = setTimeout(async () => {
    botRestartTimeout = null;
    console.log(`[BOT] Reiniciando bot tras ${delay / 1000}s...`);
    try {
      await startBot();
    } catch (err) {
      console.error('Error reiniciando bot:', err);
    }
  }, delay);
}

function isGreeting(text) {
  const normalized = text.toLowerCase().trim();
  return GREETINGS.some(g => normalized.includes(g));
}

async function getClientName(phone, fallback) {
  const normalizedPhone = phone.replace(/[^0-9]/g, '');
  const localPhone = normalizedPhone.slice(-10);

  try {
    const apiPhone = localPhone;
    const response = await axios.get(`${API_URL}/get-service/${apiPhone}`, {
      timeout: 20000
    });
    const data = response.data;
    const name = data?.datatos?.name || data?.name || data?.nombre || data?.cliente?.nombre || data?.client?.name;
    if (name) {
      console.log('[API] Cliente encontrado por teléfono:', apiPhone, name);
      return name;
    }
    console.log('[API] Cliente no encontrado en API para teléfono:', apiPhone, data);
  } catch (err) {
    console.log('[API] Error consultando cliente en API:', err.message);
  }

  return fallback;
}

// Determinar si nos encontramos fuera del horario laboral (Lun-Vie 7am-5pm)
function isOutsideBusinessHours() {
  const now = new Date();
  const day = now.getDay(); // 0 = Domingo, 6 = Sábado
  const hour = now.getHours();
  if (day === 0 || day === 6) return true;
  if (hour < 7 || hour >= 17) return true;
  return false;
}

// ==========================================
// PROCESADOR UNIFICADO DE MENSAJES (MÁQUINA DE ESTADOS)
// ==========================================
async function processMessage(sock, from, phone, text, pushName = 'desconocido', dryRun = false) {
  const responses = [];
  const normalizedText = text.toLowerCase().trim();
  const codeCandidate = text.toUpperCase().trim();

  // Helper local para responder o acumular en dryRun
  async function reply(msg) {
    if (dryRun) {
      responses.push(msg);
    } else if (sock) {
      try {
        if (msg.type === 'text') {
          console.log(`[REPLY] Enviando texto a ${from}: "${msg.text?.substring(0, 60)}..."`);
          await sock.sendMessage(from, { text: msg.text });
          console.log(`[REPLY] ✅ Texto enviado a ${from}`);
        } else if (msg.type === 'image') {
          let absolutePath = msg.url;
          if (!existsSync(absolutePath)) {
            if (msg.url.startsWith('/promos_imgs/')) {
              absolutePath = path.join(PROMOS_IMGS_PATH, msg.url.replace('/promos_imgs/', ''));
            } else {
              const webPath = msg.url.startsWith('/') ? msg.url.slice(1) : msg.url;
              absolutePath = path.join(__dirname, '..', webPath);
            }
          }
          console.log(`[REPLY] Enviando imagen a ${from}: ${absolutePath}`);
          await sock.sendMessage(from, { image: { url: absolutePath }, caption: msg.text });
          console.log(`[REPLY] ✅ Imagen enviada a ${from}`);
        } else if (msg.type === 'pdf') {
          console.log(`[REPLY] Enviando PDF a ${from}: ${msg.fileName}`);
          await sock.sendMessage(from, {
            document: { url: msg.url },
            mimetype: 'application/pdf',
            fileName: msg.fileName,
            caption: msg.text
          });
          console.log(`[REPLY] ✅ PDF enviado a ${from}`);
        }
      } catch (err) {
        console.error(`[REPLY] ❌ Error enviando mensaje a ${from}:`, err.message, err.stack?.split('\n')[1]);
      }
    } else {
      console.warn(`[REPLY] ⚠️ sock no disponible, no se pudo enviar mensaje a ${from}`);
    }
  }

  // Obtener o crear sesión en memoria con limpieza por inactividad (24 horas)
  let session = userSessions.get(from);
  const SESSION_TIMEOUT = 24 * 60 * 60 * 1000;
  if (session && session.lastActive && (Date.now() - session.lastActive > SESSION_TIMEOUT)) {
    userSessions.delete(from);
    session = null;
  }

  if (!session) {
    session = { state: null, name: null, lastActive: Date.now() };
    userSessions.set(from, session);
  }

  // Actualizar marca de tiempo
  session.lastActive = Date.now();

  // Detección de Palabras Clave (FAQ / Ayuno / Ubicación)
  // Solo se disparan si el usuario está en un estado neutral (null o waiting_code)
  const cleanText = normalizedText.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Quitar acentos
  const isNeutralState = session.state === null || session.state === 'waiting_code';

  // SALUDO: siempre tiene prioridad, sin importar el estado actual
  if (isGreeting(text)) {
    console.log(`[BOT] Saludo detectado de +${phone}, reseteando estado de sesión`);
    // Resetear sesión para que el saludo siempre arranque flujo limpio
    userSessions.delete(from);
    session = { state: null, name: null, lastActive: Date.now() };
    userSessions.set(from, session);

    let clientName = null;
    if (!dryRun) {
      const client = await db.getUser(phone);
      clientName = client?.name;
      if (!clientName) {
        clientName = await getClientName(phone, null);
        if (clientName) {
          await db.createUser(phone, clientName);
        }
      }
    } else {
      clientName = session.name;
    }

    const logoPath = path.join(__dirname, '../lab.jpg');
    if (fs.existsSync(logoPath)) {
      await reply({ type: 'image', url: dryRun ? '/lab.jpg' : logoPath, text: `*Laboratorio Clínico Integral* 🏥` });
    } else {
      await reply({ type: 'text', text: `*Laboratorio Clínico Integral* 🏥` });
    }

    const welcomePromos = await db.getActivePromotions('WELCOME');
    for (const promo of welcomePromos) {
      await reply({
        type: promo.image_url ? 'image' : 'text',
        url: promo.image_url,
        text: promo.text
      });
    }

    let greetingNotice = '';
    if (isOutsideBusinessHours()) {
      greetingNotice = `⚠️ *Aviso de Horario:* Actualmente nuestras oficinas físicas están cerradas (Lun-Vie 7am-5pm). Sin embargo, nuestro sistema automático está activo 24/7 para entregarte resultados o agendar tu cita. 🤖\n\n`;
    }

    await reply({
      type: 'text',
      text: `${greetingNotice}📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Horario: Lunes a Viernes 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n\n${clientName ? `Bienvenido 👋 *${clientName}*` : 'Bienvenido 👋'}`
    });

    if (clientName) {
      session.state = 'waiting_code';
      await reply({ type: 'text', text: `Indica tu *Código de análisis*, escribe *AGENDAR* para pedir una cita, o *VER* para revisar nuestros servicios:` });
    } else {
      session.state = 'asking_name';
      await reply({ type: 'text', text: `Para poder brindarte un mejor servicio, ¿cuál es tu nombre y apellido?` });
    }
    return responses;
  }
  
  if (isNeutralState) {
    if (['ayuno', 'requisito', 'requisitos', 'preparacion', 'prepararse'].some(k => cleanText.includes(k))) {
      await reply({
        type: 'text',
        text: `🧪 *Guía de Preparación y Ayuno* 🏥\n\nPara garantizar la precisión de tus análisis, por favor sigue estas indicaciones generales:\n\n💉 *Análisis de Sangre (Glucosa, Lípidos, Perfil Tiroideo):*\n- Requiere de **8 a 12 horas** de ayuno estricto.\n- No bebas alcohol ni fumes desde el día anterior.\n- Solo puedes beber un poco de agua simple (sin azúcar, café ni té).\n\n🧪 *Examen de Orina:*\n- Recolecta la primera orina de la mañana.\n- Usa un frasco estéril (disponible en farmacias).\n- Descarta el primer chorro y recolecta el chorro medio.\n\n🤰 *Pruebas de Embarazo (en Sangre):*\n- No requiere ayuno. Puedes realizártela a cualquier hora del día.\n\nSi tienes dudas sobre algún otro estudio específico, ¡pregúntame! 😊`
      });
      return responses;
    }
    
    if (['ubicacion', 'donde estan', 'donde queda', 'mapa', 'direccion', 'dirección'].some(k => cleanText.includes(k))) {
      await reply({
        type: 'text',
        text: `📍 *Nuestra Ubicación* 🏥\n\nEstamos ubicados en:\n*Saturno 15, Zona Industrial, Zihuatanejo, Gro.*\n\n🗺️ *Google Maps:*\nhttps://maps.google.com/?q=17.6464,-101.5478\n\n🕐 Nuestro horario de atención es de Lunes a Viernes de 7:00 AM a 5:00 PM. ¡Te esperamos! 😊`
      });
      return responses;
    }
  }

  // 1. ASKING_NAME: Capturar el nombre del nuevo paciente
  if (session.state === 'asking_name') {
    const name = text.trim();
    if (!dryRun) {
      await db.createUser(phone, name);
    } else {
      session.name = name;
    }

    await reply({ type: 'text', text: `¡Gracias *${name}*! Te hemos registrado en nuestro sistema.` });

    // Inyectar banner promocional POST_NAME si existe alguno
    const postNamePromos = await db.getActivePromotions('POST_NAME');
    for (const promo of postNamePromos) {
      await reply({
        type: promo.image_url ? 'image' : 'text',
        url: promo.image_url,
        text: promo.text
      });
    }

    session.state = 'waiting_code';
    await reply({ type: 'text', text: `Indica tu *Código de análisis*, escribe *AGENDAR* para pedir una cita, o *VER* para revisar nuestros servicios:` });
    return responses;
  }

  // 2. WAITING_CODE: Capturar cancelación, código de barras o catálogo
  if (session.state === 'waiting_code') {
    if (['no', 'no gracias', 'nope', 'nel', 'cancelar', 'fin', 'terminar'].includes(normalizedText)) {
      userSessions.delete(from);
      let clientName = session.name;
      if (!clientName && !dryRun) {
        const client = await db.getUser(phone);
        clientName = client?.name;
      }
      const farewellName = clientName ? ` ${clientName}` : '';
      await reply({
        type: 'text',
        text: `Hasta luego${farewellName} 👋\n\nGracias por contactar a *Laboratorio Clínico Integral*.\nRecuerda que estamos en:\n📍 Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n🕐 Lunes a Viernes 7:00am - 5:00pm\n🌐 https://laboratorioclinicointegral.com/\n📧 contacto@laboratorioclinicointegral.com\n\n¡Que tenga un excelente día! 😊`
      });
      return responses;
    }

    if (normalizedText === 'agendar') {
      session.state = 'waiting_agenda_name';
      await reply({ type: 'text', text: `¿Para qué análisis o estudio médico te gustaría agendar tu cita? (ej: Perfil Tiroideo, Glucosa, etc.) o escribe el número de la opción del catálogo.\n\nSi deseas cancelar escribe *no*.` });
      return responses;
    }

    if (normalizedText === 'ver' || normalizedText === 'catálogo' || normalizedText === 'catalogo') {
      const topAnalyses = await db.getAllTopAnalyses();
      if (topAnalyses.length === 0) {
        await reply({ type: 'text', text: `Por el momento no tenemos análisis destacados en catálogo. Ingresa tu código de barras o escribe *AGENDAR*:` });
        return responses;
      }

      await reply({ type: 'text', text: `📋 *Catálogo de Análisis Top*:\nAquí tienes nuestros análisis más solicitados:` });
      for (const analysis of topAnalyses) {
        const textMsg = `*Opción N° ${analysis.number}* - 🧬 *${analysis.name}*\n${analysis.description}\n💰 Precio: ${analysis.price}`;
        if (analysis.image_url) {
          await reply({ type: 'image', url: analysis.image_url, text: textMsg });
        } else {
          await reply({ type: 'text', text: textMsg });
        }
      }

      await reply({ type: 'text', text: `Si te interesa alguno de estos o buscas otro estudio, escribe *AGENDAR* para pedir una cita, o ingresa tu código de resultados.` });
      return responses;
    }

    await handleCodeQuery(sock, from, phone, codeCandidate, reply, dryRun);
    return responses;
  }

  // AGENDA FLOW: Nombre del análisis
  if (session.state === 'waiting_agenda_name') {
    if (['no', 'cancelar', 'salir'].includes(normalizedText)) {
      session.state = 'waiting_code';
      await reply({ type: 'text', text: `Entendido. Indica tu *Código de análisis*, escribe *AGENDAR* o *VER*:` });
      return responses;
    }

    const inputNumber = parseInt(normalizedText);
    if (!isNaN(inputNumber)) {
      const analysisObj = await db.getTopAnalysisByNumber(inputNumber);
      if (analysisObj) {
        session.selectedAnalysisName = analysisObj.name;
      } else {
        session.selectedAnalysisName = text.trim();
      }
    } else {
      session.selectedAnalysisName = text.trim();
    }

    session.state = 'waiting_agenda_day';
    await reply({ type: 'text', text: `Excelente elección: *${session.selectedAnalysisName}*.\n\nPara agendar tu cita, dime primero: ¿Qué **día** deseas venir? (Escribe solo el número del día, ej: 23)` });
    return responses;
  }

  // AGENDA FLOW: Día
  if (session.state === 'waiting_agenda_day') {
    const day = parseInt(normalizedText);
    if (isNaN(day) || day < 1 || day > 31) {
      await reply({ type: 'text', text: `Por favor ingresa un número de día válido (del 1 al 31).` });
      return responses;
    }

    const now = new Date();
    let month = now.getMonth();
    let year = now.getFullYear();

    // Si el día introducido es menor al día actual, asumimos que es para el mes siguiente
    if (day < now.getDate()) {
      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }

    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    session.agendaDay = day;
    session.agendaMonthName = monthNames[month];
    session.agendaYear = year;
    
    session.state = 'waiting_agenda_time';
    await reply({ type: 'text', text: `Perfecto, será el ${day} de ${session.agendaMonthName}.\n\nAhora dime: ¿A qué **hora** te gustaría asistir? (ej: 9:20 am, o 4:00 pm)` });
    return responses;
  }

  // AGENDA FLOW: Hora
  if (session.state === 'waiting_agenda_time') {
    session.agendaTime = text.trim();
    session.state = 'waiting_agenda_confirm';
    await reply({ type: 'text', text: `Resumen de tu cita:\n🧬 Análisis: *${session.selectedAnalysisName}*\n📅 Fecha: *${session.agendaDay} de ${session.agendaMonthName}*\n🕒 Hora: *${session.agendaTime}*\n\n¿Confirmas esta cita? (Responde *si* o *no*)` });
    return responses;
  }

  // AGENDA FLOW: Confirmación
  if (session.state === 'waiting_agenda_confirm') {
    if (['si', 'sí', 'yes', 'claro', 'ok', 'confirmar', 'confirmo'].includes(normalizedText)) {
      const scheduleText = `${session.agendaDay} de ${session.agendaMonthName} de ${session.agendaYear} a las ${session.agendaTime}`;
      const monthNum = String(session.agendaMonth + 1).padStart(2, '0');
      const dayNum = String(session.agendaDay).padStart(2, '0');
      const yearNum = session.agendaYear;
      const scheduleDate = `${yearNum}-${monthNum}-${dayNum}`;
      
      if (!dryRun) {
        await db.addAgenda(phone, session.selectedAnalysisName, scheduleText, scheduleDate);

        // Intentar notificar por correo al laboratorio sobre la nueva cita
        try {
          const client = await db.getUser(phone);
          const clientName = client?.name || 'Paciente';
          const subject = 'Nueva cita agendada';
          const message = `Se ha agendado una nueva cita:\n\nPaciente: ${clientName}\nTeléfono: ${phone}\nAnálisis: ${session.selectedAnalysisName}\nFecha y hora: ${scheduleText}`;
          const details = `schedule_date=${scheduleDate}`;

          // Log de confirmación de cita (sin envío de email)
          console.log(`[CITA CONFIRMADA] Teléfono: ${phone}, Paciente: ${client?.name || 'Paciente'}, Análisis: ${session.selectedAnalysisName}, Fecha: ${scheduleText}`);
        } catch (err) {
          console.error('Error preparando o enviando email de cita:', err);
        }
      }

      session.state = 'waiting_code';
      await reply({ type: 'text', text: `✅ ¡Tu cita ha sido agendada exitosamente para el ${scheduleText}!\nTe esperamos en laboratorio.\n\nSi necesitas consultar resultados, indica tu código de análisis.` });
    } else {
      session.state = 'waiting_code';
      await reply({ type: 'text', text: `Cita cancelada. Si necesitas algo más, indica tu *Código de análisis*, escribe *AGENDAR* o *VER*.` });
    }
    return responses;
  }

  // 4. INGRESO DIRECTO DE CÓDIGO (Ej: "BARCODE123")
  if (/^[A-Z0-9-]{4,}$/.test(codeCandidate)) {
    session.state = 'waiting_code';
    await handleCodeQuery(sock, from, phone, codeCandidate, reply, dryRun);
    return responses;
  }

  // 5. RESPUESTA POR DEFECTO
  await reply({
    type: 'text',
    text: `No reconozco ese mensaje. Envía tu *Código de análisis* o escribe *hola* para comenzar.`
  });
  return responses;
}

// Helper interno para procesar consultas de análisis clínicos
async function handleCodeQuery(sock, from, phone, code, reply, dryRun) {
  const localPhone = phone.slice(-10);
  console.log(`[BOT] Consultando resultados - Código: ${code} | Telf: ${localPhone} | DryRun: ${dryRun}`);

  if (!dryRun && sock) {
    await sock.sendPresenceUpdate('composing', from);
  }
  
  await reply({ type: 'text', text: `🔍 Consultando tu código *${code}*...` });

  try {
    const response = await axios.get(`${API_URL}/get-service-by-barcode/${localPhone}/${code}`, {
      timeout: 30000
    });
    const data = response.data;

    if (!data || !data.barcode) {
      console.log('[BOT] Código no encontrado en API.');
      await reply({ type: 'text', text: `❌ No se encontró el código: *${code}*` });
    } else {
      // Registrar log local de la consulta
      if (!dryRun) {
        await db.logAnalysisQuery(phone, code, data.status_id);
      }

      if (data.status_id === 1) {
        await reply({ type: 'text', text: `🚫 Pendiente de pago. Contacte al (755) 108 48 00.` });
      } else if (data.status_id === 2) {
        console.log('[BOT] Resultados listos. Entregando documentos.');

        // Inyectar banner promocional PRE_DELIVERY
        const preDeliveryPromos = await db.getActivePromotions('PRE_DELIVERY');
        for (const promo of preDeliveryPromos) {
          await reply({
            type: promo.image_url ? 'image' : 'text',
            url: promo.image_url,
            text: promo.text
          });
        }

        let entregados = 0;
        const urls = data.urls || [];
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i]['path' + i];
          if (!url) continue;
          const docName = urls[i]['name' + i] || `Resultado ${i + 1}`;

          if (dryRun) {
            // En simulador no descargamos streams, pasamos el url directo para previsualizar
            await reply({
              type: 'pdf',
              url: url,
              fileName: docName,
              text: `📄 ${docName}`
            });
            entregados++;
          } else {
            try {
              const fileResponse = await axios.get(url, { responseType: 'stream', timeout: 30000 });
              const filename = path.join(os.tmpdir(), `${docName.replace(/[\/,\s]+/g, '_')}_${Date.now()}.pdf`);

              const writer = fs.createWriteStream(filename);
              fileResponse.data.pipe(writer);

              await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
              });

              await reply({
                type: 'pdf',
                url: filename,
                fileName: docName,
                text: `📄 ${docName}`
              });

              fs.unlinkSync(filename);
              entregados++;
            } catch (err) {
              console.log(`Error descargando PDF ${url}:`, err.message);
              if (err.response?.status === 404) {
                await reply({ type: 'text', text: `⚠️ El resultado aún no está disponible. Comunícate al *(755) 108 48 00*.` });
              } else {
                await reply({ type: 'text', text: `📄 Documento ${i + 1}: ${url}` });
                entregados++;
              }
            }
          }
        }

        if (entregados > 0) {
          await reply({ type: 'text', text: `✅ Resultados entregados.` });
        }
      }
    }
  } catch (err) {
    console.error('[BOT] Error al procesar código en API:', err.message);
    await reply({ type: 'text', text: `⚠️ Error consultando resultados. Intenta más tarde.` });
  } finally {
    if (!dryRun && sock) {
      await sock.sendPresenceUpdate('paused', from);
    }
  }

  // Volver a preguntar si desea agregar otro código
  const session = userSessions.get(from);
  if (session) {
    session.state = 'waiting_code';
  }
  await reply({ type: 'text', text: `¿Tienes otro código que consultar? Indícalo, escribe *AGENDAR* para pedir una cita, *VER* para revisar servicios, o *no* para terminar.` });
}

// ==========================================
// SISTEMA DE DIFUSIÓN MASIVA (CAMPAÑAS ANTIBAN)
// ==========================================
async function sendBroadcast(sock, clients, text, imagePath) {
  if (!sock) throw new Error('WhatsApp Bot no conectado');
  console.log(`[CAMPAÑA] Iniciando difusión masiva a ${clients.length} pacientes.`);

  for (const client of clients) {
    const jid = client.phone.includes('@') ? client.phone : `${client.phone}@s.whatsapp.net`;

    if (jid.includes('simulator')) {
      console.log(`[CAMPAÑA] Saltando contacto de simulador virtual: ${jid}`);
      continue;
    }

    try {
      console.log(`[CAMPAÑA] Enviando a: ${jid}...`);
      const personalizedText = text.replace(/\[nombre\]/gi, client.name || 'Paciente');

      if (imagePath) {
        let absolutePath = imagePath;
        if (!existsSync(absolutePath)) {
          if (imagePath.startsWith('/promos_imgs/')) {
            absolutePath = path.join(PROMOS_IMGS_PATH, imagePath.replace('/promos_imgs/', ''));
          } else {
            absolutePath = path.join(__dirname, '..', imagePath);
          }
        }
        await sock.sendMessage(jid, { image: { url: absolutePath }, caption: personalizedText });
      } else {
        await sock.sendMessage(jid, { text: personalizedText });
      }

      console.log(`[CAMPAÑA] ✅ Enviado a: ${jid}`);

      // Retardo antiban aleatorio de 4 a 8 segundos
      const delay = Math.floor(Math.random() * 4000) + 4000;
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (err) {
      console.error(`[CAMPAÑA] ❌ Error al enviar a ${jid}:`, err.message);
    }
  }
}

const botState = {
  qr: null,
  connected: false,
  hasConnected: false
};

async function startBot() {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion
    } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      qrTimeout: 40000,
      defaultQueryTimeoutMs: 60000
    });

    sockInstance = sock; // Guardar referencia activa

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      try {
        if (qr) {
          botState.qr = qr;
          botState.connected = false;
          console.log('[QR] Nuevo código QR generado');
          if (!botState.hasConnected && canSendNotification('qr_notification')) {
            console.log('[QR] Sesión no conectada, requiere escaneo de QR por el administrador');
          }
        }
        if (connection === 'close') {
          botState.connected = false;
          botState.qr = null;
          sockInstance = null;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log('Conexión cerrada. Reconectando:', shouldReconnect);
          if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`Intentando reconectar automáticamente... (Intento ${reconnectAttempts} de ${MAX_RECONNECT_ATTEMPTS})`);
            scheduleBotRestart(20000);
          } else {
            if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
              console.error('Se alcanzó el límite máximo de intentos de reconexión.');
            }
            if (!botState.hasConnected && canSendNotification(QR_NOTIFICATION_THROTTLE_KEY)) {
              console.log('[QR] Sesión cerrada por WhatsApp, se generará nuevo QR');
            }
            console.log('[SESSION] Sesión cerrada por el usuario, limpiando sesión...');
            botState.qr = null;
            botState.hasConnected = false;
            // Limpiar archivos de credenciales de Baileys
            if (existsSync(SESSION_PATH)) {
              rmSync(SESSION_PATH, { recursive: true, force: true });
              console.log('[SESSION] Archivos de sesión de Baileys eliminados');
            }
            // Limpiar estados de conversación en memoria
            userSessions.clear();
            notificationThrottle.clear();
            console.log('[SESSION] Estados de conversación y throttle en memoria limpiados');
            reconnectAttempts = 0;
            scheduleBotRestart(60000);
          }
        }
        if (connection === 'open') {
          botState.qr = null;
          botState.connected = true;
          botState.hasConnected = true;
          reconnectAttempts = 0;
          sockInstance = sock;
          console.log('Bot conectado a WhatsApp');
        }
      } catch (err) {
        console.error('[CONNECTION ERROR]', err);
      }
    });

    sock.ev.on('creds.update', async (creds) => {
      try {
        await saveCreds(creds);
      } catch (err) {
        console.error('[CREDS ERROR] Error guardando credenciales:', err);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        // ── DIAGNÓSTICO 1: ¿Llega el evento a Baileys? ──
        console.log(`[DIAG] messages.upsert disparado | type="${type}" | cantidad de mensajes: ${messages.length}`);

        if (type !== 'notify') {
          console.log(`[DIAG] Ignorado: type="${type}" no es "notify"`);
          return;
        }

        for (const msg of messages) {
          // ── DIAGNÓSTICO 2: Estructura cruda del mensaje ──
          console.log(`[DIAG] Mensaje crudo recibido:`, JSON.stringify({
            fromMe: msg.key?.fromMe,
            remoteJid: msg.key?.remoteJid,
            senderPn: msg.key?.senderPn,
            pushName: msg.pushName,
            messageType: msg.message ? Object.keys(msg.message) : null,
            status: msg.status
          }));

          if (!msg.message) {
            console.log('[DIAG] Ignorado: msg.message está vacío (sin contenido)');
            continue;
          }
          if (msg.key.fromMe) {
            console.log('[DIAG] Ignorado: mensaje enviado por el propio bot (fromMe=true)');
            continue;
          }

          const from = msg.key.remoteJid;
          // Si el JID es @lid (ID de dispositivo vinculado), usar senderPn para responder
          // Los mensajes enviados a @lid no son entregados por WhatsApp
          const replyJid = msg.key.senderPn || from;

          const phone = (msg.key.senderPn || from)
            .replace('@s.whatsapp.net', '')
            .replace('@g.us', '')
            .replace('@lid', '');

          const name = msg.pushName || 'desconocido';
          console.log(`[DIAG] Procesando mensaje de: +${phone} (${name}) | JID original: ${from} | JID respuesta: ${replyJid}`);

          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            '';

          // ── DIAGNÓSTICO 3: ¿Se extrajo texto? ──
          console.log(`[DIAG] Texto extraído: "${text}" | Tipo de mensaje detectado: ${
            msg.message.conversation ? 'conversation' :
            msg.message.extendedTextMessage ? 'extendedText' :
            msg.message.imageMessage ? 'image' :
            msg.message.documentMessage ? 'document' :
            'DESCONOCIDO - keys: ' + Object.keys(msg.message).join(', ')
          }`);

          if (!text) {
            console.log('[DIAG] Ignorado: no se pudo extraer texto del mensaje.');
            continue;
          }

          // ── DIAGNÓSTICO 4: Entrando a processMessage ──
          console.log(`[DIAG] Llamando processMessage para +${phone} con texto: "${text}"`);
          await processMessage(sock, replyJid, phone, text, name, false);
          console.log(`[DIAG] processMessage completado para +${phone}`);
        }
      } catch (err) {
        console.error('[MESSAGES ERROR] Error manejando mensaje de WhatsApp:', err);
      }
    });
  } catch (err) {
    console.error('[BOT STARTUP ERROR]', err);
    scheduleBotRestart(30000);
  }
}

// Limpieza periódica de mapas para evitar acumulación de memoria
setInterval(() => {
  const THROTTLE_CLEANUP_TIME = 2 * 60 * 60 * 1000; // 2 horas
  const now = Date.now();

  for (const [key, lastTime] of notificationThrottle.entries()) {
    if (now - lastTime > THROTTLE_CLEANUP_TIME) {
      notificationThrottle.delete(key);
    }
  }

  for (const [key, session] of userSessions.entries()) {
    if (session.state === null) {
      userSessions.delete(key);
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

// Recordatorios automáticos de citas ejecutados diariamente a las 8:00 AM
let lastRemindersRunDate = '';
function startAppointmentReminders() {
  console.log('[RECORDATORIOS] Scheduler de recordatorios de citas iniciado.');
  setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      
      // Ejecutar solo si son las 8:00 AM y no ha corrido hoy
      if (now.getHours() === 8 && lastRemindersRunDate !== todayStr) {
        lastRemindersRunDate = todayStr;
        console.log('[RECORDATORIOS] Iniciando envío de recordatorios diarios...');
        
        if (!sockInstance || !botState.connected) {
          console.log('[RECORDATORIOS] El bot no está conectado. Postponiendo envío.');
          lastRemindersRunDate = ''; // Permitir reintentar en el siguiente intervalo si se conecta
          return;
        }

        // Obtener la fecha de mañana en formato YYYY-MM-DD
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
        
        const agendas = await db.getAgendasByDate(tomorrowStr);
        console.log(`[RECORDATORIOS] Se encontraron ${agendas.length} citas para mañana (${tomorrowStr}).`);

        for (const agenda of agendas) {
          try {
            const clientName = agenda.client_name || 'Paciente';
            const reminderText = `🔔 *Recordatorio de Cita* 🏥\n\nHola *${clientName}*, te recordamos que tienes una cita agendada para el día de **mañana** para tu estudio:\n\n🧬 *${agenda.analysis_name}*\n🕐 Fecha y Hora: *${agenda.schedule_text}*\n\n📍 Dirección: Saturno 15, Zona Industrial, Zihuatanejo, Gro.\n\nTe esperamos con la preparación indicada. Si tienes dudas sobre tu ayuno o preparación, puedes escribirme *AYUNO*. 😊`;
            
            await sockInstance.sendMessage(agenda.client_phone, { text: reminderText });
            console.log(`[RECORDATORIOS] Recordatorio enviado exitosamente a ${agenda.client_phone}`);
            // Esperar 3 segundos para evitar spam
            await new Promise(r => setTimeout(r, 3000));
          } catch (sendErr) {
            console.error(`[RECORDATORIOS] Error al enviar recordatorio a ${agenda.client_phone}:`, sendErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[RECORDATORIOS] Error general en el scheduler de recordatorios:', err.message);
    }
  }, 10 * 60 * 1000); // Revisar cada 10 minutos
}

startAppointmentReminders();

module.exports = {
  botState,
  startBot,
  processMessage,
  userSessions,
  sendBroadcast,
  getSockInstance: () => sockInstance
};
