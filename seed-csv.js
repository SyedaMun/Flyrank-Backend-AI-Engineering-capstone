/**
 * Navigant Core Engine: CSV seeding module (schema-aligned, re-runnable).
 * Imports master_database.csv into `applicants`:
 *   - phone numbers normalised to E.164 (+92...) using the same rules as the live API
 *   - workshop date becomes created_at, so month-wise trends are historically correct
 *   - gender / profession / city / email are stored for the demographic dashboards
 * Re-running UPDATES existing rows (matched by idempotency_hash), it never duplicates them.
 */
const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config();
const { normalizePhone } = require('./phone');
const { ensureSchema } = require('./schema');

const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT || 5432),
});

// Minimal RFC-4180 CSV parser (quotes, commas inside quotes, CRLF, BOM)
function parseCSV(text) {
    const rows = []; let row = [], field = '', inQ = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQ = false;
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(v => v.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some(v => v.trim() !== '')) rows.push(row);
    return rows;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseWorkshopDate(s) {                       // "09 Oct 2026" -> Date (noon UTC)
    const m = String(s || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
    if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
    return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 12, 0, 0));
}

const CITY_FIXES = { buewala: 'Burewala', burewala: 'Burewala' };
const tidyCity = (c) => {
    const t = String(c || '').trim().replace(/\s+/g, ' ');
    if (!t) return '';
    return CITY_FIXES[t.toLowerCase()] || t.replace(/\b\w/g, ch => ch.toUpperCase());
};
const PROFESSIONS = ['Student', 'Unemployed', 'Professional', 'Homemaker', 'Other'];
const tidyProfession = (p) => PROFESSIONS.find(x => x.toLowerCase() === String(p || '').trim().toLowerCase()) || (String(p || '').trim() ? 'Other' : 'Not specified');
const GENDERS = ['Female', 'Male', 'Prefer not to say'];
const tidyGender = (g) => GENDERS.find(x => x.toLowerCase() === String(g || '').trim().toLowerCase()) || 'Not specified';

// ---------------------------------------------------------------------------
// DELIVERY MODE of every batch in the CSV. The CSV has no such column, so YOU declare it here.
// In Person = 5 hours per batch, Online = 2 hours per batch (same rule as server.js and the database).
// A batch that is not listed makes the import STOP with a clear message - nothing is guessed.
// >>> CHECK THESE FOUR LINES: they say how each October 2026 workshop was delivered. <<<
// ---------------------------------------------------------------------------
const CSV_BATCH_MODES = {
    'Workshop-1': 'Online',
    'Workshop-2': 'Online',
    'Workshop-3': 'Online',
    'Workshop-4': 'Online'
};
const HOURS_PER_BATCH = { 'In Person': 5, 'Online': 2 };

// CSV "Workshop Topic" -> official catalogue name used by the live API
const TRACK_ALIASES = { 'ai essentials': 'AI Essentials & Prompt Engineering' };

async function parseAndSeedCSV() {
    try {
        await client.connect();
        console.log("📡 Connected to Navigant PostgreSQL database container...");
        await ensureSchema(client);                     // make sure new columns exist
        console.log("⏳ Processing CSV records row-by-row...");

        // Usage: node seed-csv.js [path-to-csv]
// Default: your private ./master_database.csv if it exists (real learners, never committed to Git),
// otherwise the synthetic demo data in ./seed/demo_learners.csv so anyone can run the project.
const filePath = process.argv[2] || (fs.existsSync('./master_database.csv') ? './master_database.csv' : './seed/demo_learners.csv');
        console.log('📄 Importing: ' + filePath);
        if (!fs.existsSync(filePath)) {
            console.error(`❌ Error: The file '${filePath}' was not found.`);
            return;
        }
        const rows = parseCSV(fs.readFileSync(filePath, 'utf8'));
        const headers = rows[0].map(h => h.trim().toLowerCase());
        const col = (pred) => headers.findIndex(pred);
        const idx = {
            workshop: col(h => h === 'workshops' || h === 'workshop'),
            name: col(h => h.includes('full name')),
            email: col(h => h.includes('email')),
            phone: col(h => h.includes('whatsapp') || h.includes('phone')),
            gender: col(h => h === 'gender'),
            profession: col(h => h.includes('profession')),
            city: col(h => h.includes('city') || h.includes('location')),
            topic: col(h => h === 'workshop topic'),
            subtopic: col(h => h === 'subtopic'),
            attendance: col(h => h.includes('attendance')),
            date: col(h => h === 'workshop date')
        };
        if (idx.name < 0 || idx.email < 0) throw new Error('CSV header row must contain "Full Name" and "Email Address".');
        console.log(`🎯 Layout mapped. Ingesting ${rows.length - 1} data rows...`);

        // refuse to import anything unless EVERY batch has a declared delivery mode
        const missing = new Set();
        for (let r = 1; r < rows.length; r++) {
            const c = rows[r].map(v => (v || '').trim());
            const em = (c[idx.email] || '');
            if (!c[idx.name] || !em.includes('@')) continue;
            const w = (idx.workshop >= 0 && c[idx.workshop]) || 'W-1';
            if (!HOURS_PER_BATCH[CSV_BATCH_MODES[w]]) missing.add(w);
        }
        if (missing.size) {
            throw new Error('No delivery mode declared for batch(es): ' + [...missing].join(', ') +
                '. Add them to CSV_BATCH_MODES at the top of seed-csv.js ("In Person" or "Online"), then run again.');
        }

        let written = 0, skipped = 0; const badPhones = [];
        for (let r = 1; r < rows.length; r++) {
            const c = rows[r].map(v => (v || '').trim());
            const fullName = c[idx.name], email = (c[idx.email] || '').toLowerCase();
            if (!fullName || !email.includes('@')) { skipped++; continue; }   // footer / description rows

            const rawPhone = idx.phone >= 0 ? c[idx.phone] : '';
            const phone = normalizePhone(rawPhone) || '';
            if (!phone) badPhones.push(`${fullName} (${rawPhone || 'empty'})`);

            const topic = (idx.topic >= 0 ? c[idx.topic] : '') || (idx.subtopic >= 0 ? c[idx.subtopic] : '');
            const track = TRACK_ALIASES[topic.toLowerCase()] || topic || 'AI Essentials & Prompt Engineering';
            const date = parseWorkshopDate(idx.date >= 0 ? c[idx.date] : '') || new Date();
            const isoDay = date.toISOString().slice(0, 10);
            const wId = (idx.workshop >= 0 && c[idx.workshop]) || 'W-1';
            const attended = idx.attendance >= 0 && c[idx.attendance] === 'Attended';
            const status = attended ? 'Verified: Enrolled' : 'Halted: Absent';
            const sub = idx.subtopic >= 0 ? c[idx.subtopic] : '';
            const bio = `Historical import. Workshop: ${wId}${sub ? ' / ' + sub : ''}. Registration Source: Excel CSV Ingestion Pipeline.` +
                        (phone ? '' : ` Original phone (not valid E.164): ${rawPhone || 'none'}.`);
            const hash = `csv_${wId.replace(/\s+/g, '')}_${email}_${isoDay}`;

            const result = await client.query(`
                INSERT INTO applicants
                  (idempotency_hash, full_name, email, whatsapp_number, raw_biography, extracted_track, stream_type, status,
                   gender, profession, city, created_at, workshop_batch, delivery_mode, batch_hours)
                VALUES ($1,$2,$3,$4,$5,$6,'FREE_COMMUNITY',$7,$8,$9,$10,$11,$12,$13,$14)
                ON CONFLICT (idempotency_hash) DO UPDATE SET
                   email = EXCLUDED.email, whatsapp_number = EXCLUDED.whatsapp_number, extracted_track = EXCLUDED.extracted_track,
                   status = EXCLUDED.status, gender = EXCLUDED.gender, profession = EXCLUDED.profession,
                   city = EXCLUDED.city, created_at = EXCLUDED.created_at, workshop_batch = EXCLUDED.workshop_batch,
                   delivery_mode = EXCLUDED.delivery_mode, batch_hours = EXCLUDED.batch_hours;`,
                [hash, fullName, email, phone, bio, track, status,
                 tidyGender(c[idx.gender]), tidyProfession(c[idx.profession]), tidyCity(c[idx.city]), date, wId, CSV_BATCH_MODES[wId], HOURS_PER_BATCH[CSV_BATCH_MODES[wId]]]);
            if (result.rowCount > 0) written++;
        }

        console.log(`\n📊 CSV Migration Summary:`);
        console.log(`✔️ Data rows analysed: ${rows.length - 1}`);
        console.log(`✔️ Records inserted or refreshed: ${written}`);
        console.log(`ℹ️  Rows skipped (no name/email): ${skipped}`);
        if (badPhones.length) console.log(`⚠️  ${badPhones.length} phone number(s) could not be normalised (stored empty, original kept in raw_biography):\n   - ${badPhones.join('\n   - ')}`);
        console.log(`➡️  Restart the server (or submit any form) to refresh the public impact ledger.`);
    } catch (err) {
        console.error("❌ Critical breakdown during CSV ingestion operations:", err);
        process.exitCode = 1;
    } finally {
        await client.end();
        console.log("🔌 Database client connection safely disconnected.");
    }
}

parseAndSeedCSV();
