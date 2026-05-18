const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const PERSISTENT_PATH = process.env.PERSISTENT_PATH || '';
const DB_FILE = PERSISTENT_PATH 
    ? path.join(PERSISTENT_PATH, 'local_bot.db') 
    : path.join(__dirname, 'local_bot.db');

// Asegurar que la carpeta persistente exista si se especifica
if (PERSISTENT_PATH && !fs.existsSync(PERSISTENT_PATH)) {
    fs.mkdirSync(PERSISTENT_PATH, { recursive: true });
}

let dbPromise = null;

async function getLocalDb() {
    if (!dbPromise) {
        dbPromise = open({
            filename: DB_FILE,
            driver: sqlite3.Database
        }).then(async (db) => {
            // Activar Foreign Keys en SQLite
            await db.exec('PRAGMA foreign_keys = ON;');
            
            // Crear tablas normalizadas para el bot clínico
            await db.exec(`
                CREATE TABLE IF NOT EXISTS clients (
                    phone TEXT PRIMARY KEY,
                    name TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS analyses_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_phone TEXT,
                    barcode TEXT,
                    status_id INTEGER, -- 1: Pendiente, 2: Entregado
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (client_phone) REFERENCES clients(phone)
                );

                CREATE TABLE IF NOT EXISTS promotions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    position TEXT, -- WELCOME, POST_NAME, PRE_DELIVERY
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS campaigns (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT,
                    image_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS top_analyses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    number INTEGER UNIQUE,
                    name TEXT,
                    description TEXT,
                    price TEXT,
                    image_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS agenda (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_phone TEXT,
                    analysis_name TEXT,
                    schedule_text TEXT,
                    schedule_date TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (client_phone) REFERENCES clients(phone)
                );
            `);

            // Migración segura para bases de datos existentes
            try {
                await db.exec('ALTER TABLE agenda ADD COLUMN schedule_date TEXT;');
            } catch (e) {
                // Columna ya existe
            }

            return db;
        });
    }
    return dbPromise;
}

// ========================
// Módulo de Clientes (Pacientes)
// ========================
async function getUser(phone) {
    const db = await getLocalDb();
    return db.get('SELECT * FROM clients WHERE phone = ?', [phone]);
}

async function getAllClients() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM clients');
}

async function createUser(phone, name) {
    const db = await getLocalDb();
    await db.run('INSERT OR REPLACE INTO clients (phone, name) VALUES (?, ?)', [phone, name]);
}

// ========================
// Módulo de Logs de Consultas
// ========================
async function logAnalysisQuery(phone, barcode, statusId) {
    try {
        const db = await getLocalDb();
        await db.run('INSERT INTO analyses_logs (client_phone, barcode, status_id) VALUES (?, ?, ?)', [phone, barcode, statusId]);
        console.log(`[DB LOG] Consulta registrada - Teléfono: ${phone} | Código: ${barcode} | Estado: ${statusId}`);
    } catch (err) {
        console.error('[DB LOG] Error al registrar log de consulta:', err.message);
    }
}

// ========================
// Módulo de Promociones (Banners del Chat)
// ========================
async function getActivePromotions(position) {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions WHERE position = ? AND active = 1', [position]);
}

async function getAllPromotions() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM promotions ORDER BY created_at DESC');
}

async function addPromotion(text, image_url, position) {
    const db = await getLocalDb();
    await db.run('INSERT INTO promotions (text, image_url, position) VALUES (?, ?, ?)', [text, image_url, position]);
}

async function updatePromotion(id, active) {
    const db = await getLocalDb();
    await db.run('UPDATE promotions SET active = ? WHERE id = ?', [active, id]);
}

async function deletePromotion(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM promotions WHERE id = ?', [id]);
}

// ========================
// Módulo de Campañas
// ========================
async function addCampaign(text, image_url) {
    const db = await getLocalDb();
    await db.run('INSERT INTO campaigns (text, image_url) VALUES (?, ?)', [text, image_url]);
}

async function getAllCampaigns() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM campaigns ORDER BY created_at DESC');
}

async function deleteCampaign(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM campaigns WHERE id = ?', [id]);
}

// ========================
// Módulo de Análisis Top
// ========================
async function addTopAnalysis(number, name, description, price, image_url) {
    const db = await getLocalDb();
    await db.run('INSERT INTO top_analyses (number, name, description, price, image_url) VALUES (?, ?, ?, ?, ?)', [number, name, description, price, image_url]);
}

async function getAllTopAnalyses() {
    const db = await getLocalDb();
    return db.all('SELECT * FROM top_analyses ORDER BY number ASC');
}

async function getTopAnalysisByNumber(number) {
    const db = await getLocalDb();
    return db.get('SELECT * FROM top_analyses WHERE number = ?', [number]);
}

async function deleteTopAnalysis(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM top_analyses WHERE id = ?', [id]);
}

// ========================
// Módulo de Agenda
// ========================
async function addAgenda(client_phone, analysis_name, schedule_text, schedule_date) {
    const db = await getLocalDb();
    await db.run('INSERT INTO agenda (client_phone, analysis_name, schedule_text, schedule_date) VALUES (?, ?, ?, ?)', [client_phone, analysis_name, schedule_text, schedule_date]);
}

async function getAllAgendas() {
    const db = await getLocalDb();
    return db.all(`
        SELECT a.id, a.client_phone, c.name as client_name, a.analysis_name, a.schedule_text, a.schedule_date, a.created_at 
        FROM agenda a 
        LEFT JOIN clients c ON a.client_phone = c.phone 
        ORDER BY a.created_at DESC
    `);
}

async function getAgendasByDate(dateStr) {
    const db = await getLocalDb();
    return db.all(`
        SELECT a.id, a.client_phone, c.name as client_name, a.analysis_name, a.schedule_text, a.schedule_date, a.created_at 
        FROM agenda a 
        LEFT JOIN clients c ON a.client_phone = c.phone 
        WHERE a.schedule_date = ?
    `, [dateStr]);
}

async function deleteAgenda(id) {
    const db = await getLocalDb();
    await db.run('DELETE FROM agenda WHERE id = ?', [id]);
}

// ========================
// Módulo de Analítica Clínica
// ========================
async function getAnalyticsStats() {
    const db = await getLocalDb();
    
    // Total de consultas entregadas (status_id = 2) o realizadas
    const totalQuotes = await db.get('SELECT COUNT(*) as count FROM analyses_logs WHERE status_id = 2');
    
    // Análisis más agendados (Top 10)
    const topProducts = await db.all(`
        SELECT analysis_name as descrip, COUNT(*) as count 
        FROM agenda 
        GROUP BY analysis_name 
        ORDER BY count DESC 
        LIMIT 10
    `);

    // Actividad diaria de descargas exitosas (últimos 7 días)
    const dailyActivity = await db.all(`
        SELECT DATE(created_at) as date, COUNT(*) as count 
        FROM analyses_logs 
        WHERE status_id = 2 
        GROUP BY DATE(created_at) 
        ORDER BY date DESC 
        LIMIT 7
    `);

    // Pacientes únicos registrados
    const totalClients = await db.get('SELECT COUNT(*) as count FROM clients');

    return {
        totalQuotes: totalQuotes.count,
        topProducts,
        dailyActivity: dailyActivity.reverse(),
        totalClients: totalClients.count
    };
}

module.exports = {
    getLocalDb,
    getUser,
    createUser,
    getAllClients,
    logAnalysisQuery,
    getActivePromotions,
    getAllPromotions,
    addPromotion,
    updatePromotion,
    deletePromotion,
    addCampaign,
    getAllCampaigns,
    deleteCampaign,
    addTopAnalysis,
    getAllTopAnalyses,
    getTopAnalysisByNumber,
    deleteTopAnalysis,
    addAgenda,
    getAllAgendas,
    getAgendasByDate,
    deleteAgenda,
    getAnalyticsStats
};
