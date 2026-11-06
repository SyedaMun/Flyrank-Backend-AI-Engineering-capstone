require('dotenv').config();
const SERVER_VERSION = 'navigant-server-v5-2026-10-31';
const crypto = require('crypto');
const idempotencyShield = require('./idempotency');
const { analyzeApplicationBio } = require('./ai-guard');
const { normalizePhone } = require('./phone');
const { ensureSchema } = require('./schema');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const NOTIFY_TO = process.env.NOTIFICATION_EMAIL || 'navigant.educationconsultants@gmail.com';
const emailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_GMAIL_USER,
        pass: process.env.SMTP_GMAIL_APP_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
});

// Tells you at startup whether Gmail login actually works
emailTransporter.verify()
    .then(() => console.log('✅ Gmail SMTP login verified. Alerts will go to:', NOTIFY_TO))
    .catch((e) => console.error('❌ Gmail SMTP verification FAILED:', e.message,
        '\n   Check SMTP_GMAIL_USER and SMTP_GMAIL_APP_PASS (must be a 16-char Google App Password) in .env'));

async function dispatchEmailAlert(streamTitle, recordPayload, replyTo) {
    console.log(`📡 Preparing email dispatch for stream: ${streamTitle}...`);

    let compiledDetails = "";
    for (const [key, value] of Object.entries(recordPayload)) {
        compiledDetails += `${key.toUpperCase().replace(/_/g, ' ')}: ${value}\n`;
    }

    const mailOptions = {
        from: `"Navigant Core Engine" <${process.env.SMTP_GMAIL_USER}>`,
        to: NOTIFY_TO,
        ...(replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo) ? { replyTo } : {}),
        subject: `🔔 New Navigant Core Entry: [${streamTitle}]`,
        text: `Hello Syeda Munazza Bukhari,\n\nA new record has bypassed the frontend gateway and logged successfully inside your isolated Docker database matrix.\n\n--- SUBMISSION DETAILS ---\n${compiledDetails}\nTimestamp: ${new Date().toLocaleString()}\n\nBest regards,\nYour Autonomous Backend Assistant`
    };

    try {
        await emailTransporter.sendMail(mailOptions);
        console.log(`📬 Email alert sent successfully to ${NOTIFY_TO}`);
    } catch (error) {
        console.error("❌ Email transmission alert failure:", error);
    }
}

const app = express();
const PORT = process.env.PORT || 5000;

// ---------------------------------------------------------------------------
// DELIVERY-MODE HOUR RULE - the ONLY place coaching hours are defined (mirrors the database CHECK constraint):
//   In Person  ->  Total Batches x 5 hours
//   Online     ->  Total Batches x 2 hours
// Hours are saved on every registration row (batch_hours) from its delivery mode. There is NO fallback:
// a registration without a valid delivery mode is rejected, and a batch of unknown mode counts 0 hours.
// ---------------------------------------------------------------------------
const HOURS_PER_BATCH = { 'In Person': 5, 'Online': 2 };
function normalizeMode(v) {
    const t = String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (t === 'in person') return 'In Person';
    if (t === 'online') return 'Online';
    return null;
}
// A website registration joins the batch of its course + delivery mode for the current calendar month.
const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function webBatchLabel(track, mode) {
    return `WEB-${new Date().toISOString().slice(0, 7)}-${mode === 'Online' ? 'ON' : 'IP'}-${slug(track)}`.slice(0, 60);
}
// SQL: hours of a set of rows = sum over DISTINCT batches (label + day) of that batch's saved hours
const BATCH_KEY = `NULLIF(TRIM(workshop_batch), '') || '@' || created_at::date::text`;
const BATCH_HOURS_SQL = (from, where = '') => `
    SELECT COALESCE(SUM(bh), 0)::int AS hours, COUNT(*)::int AS batches FROM (
        SELECT MAX(batch_hours) AS bh FROM ${from}
        ${where ? where + ' AND' : 'WHERE'} NULLIF(TRIM(workshop_batch), '') IS NOT NULL
        GROUP BY workshop_batch, created_at::date
    ) x`;

// Test entries: a registration whose name contains the word "test" or whose email looks like a test address
// (test@..., name+test@..., @test.*, @example.*) is saved with status 'Test: Ignored' and is NEVER counted in any stats.
const isTestEntry = (name, email) => /\btest\b/i.test(String(name || '')) || /(^test|\+test|@test\.|@example\.)/i.test(String(email || ''));
const RA = `(SELECT * FROM applicants WHERE COALESCE(status, '') NOT LIKE 'Test:%') applicants`;

// Team members managed manually (website forms are still being built).
// Hard-coded here so these counters survive any database reset. Override in .env if the team changes.
const MANUAL_INTERNS = Math.max(0, parseInt(process.env.MANUAL_INTERNS ?? '1', 10) || 0);
const MANUAL_VOLUNTEER_TRAINERS = Math.max(0, parseInt(process.env.MANUAL_VOLUNTEER_TRAINERS ?? '3', 10) || 0);

// Idempotency hashes are unique per person. Adding the day (and optional salt) means
// the same person can register again on another day or for another course.
function dailyHash(base, fallback, salt = '') {
    const day = new Date().toISOString().slice(0, 10);
    return `${base || fallback}_${day}${salt ? '_' + salt : ''}`.slice(0, 255);
}

// Logs EVERY request before anything else touches it
app.use((req, res, next) => {
    console.log(`➡️  ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: SERVER_VERSION, pid: process.pid, cwd: process.cwd() });
});

// Wraps the idempotency middleware so any failure inside it is printed, not hidden
function safeShield(req, res, next) {
    const fail = (e) => {
        console.error('❌ idempotency shield error:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Idempotency shield failure: ' + (e && e.message) });
    };
    try {
        const out = idempotencyShield(req, res, () => { console.log('🛡️  shield passed'); next(); });
        if (out && typeof out.catch === 'function') out.catch(fail);
    } catch (e) { fail(e); }
}

// Official Navigant Curriculum Streams & Services Catalog
const OFFICIAL_TRACKS = [
    // 💻 Tech & Digital Tools
    'AI Essentials & Prompt Engineering',
    'Graphic Designing',
    'Social Media Management & Digital Marketing',
    'Coding Classes (Python & JavaScript)',
    'Game Development',
    'Website Development',
    // 💼 Career Readiness & Growth
    'Professional Resume Making & Job Search Strategies',
    'Ace Your Interview Preparation',
    'Motivational & Leadership Coaching',
    'Profile Building & Personal Branding',
    'Public Speaking & Communication Skills',
    // 🎓 Academic Elevation
    'University Application Strategies',
    'How to Secure Global Scholarships',
    'IELTS Preparation Training',
    'English Language Training / Spoken English',
    'Academic Writing & Research Skills',
    'Statement of Purpose / Personal Statement Writing',
    // Courses offered in the student registration dropdown (index.html)
    'Academic Grade Restoration & Coaching',
    'Free English & Mathematics Learning',
    'Targeted IELTS Preparation',
    // 💎 Premium Paid Services (Sustaining Streams)
    'Global Academic Elite (Long-Term Academic Portal)',
    'Academic Document & Scholarship Profiling',
    'Professional Teacher Training (Institutional AI Capacity)',
    'AI Automation & Agentic Systems Consultancy'
];

// Exact match first, then the original loose match ("Graphic Design" vs "Graphic Designing")
function findOfficialTrack(value) {
    const extracted = String(value || '').toLowerCase().trim();
    if (!extracted) return null;
    const exact = OFFICIAL_TRACKS.find(t => t.toLowerCase().trim() === extracted);
    if (exact) return exact;
    if (extracted.length < 4) return null;
    return OFFICIAL_TRACKS.find(t => {
        const official = t.toLowerCase().trim();
        return official.includes(extracted) || extracted.includes(official);
    }) || null;
}

// Allowed delivery stream types
const VALID_STREAMS = ['FREE_COMMUNITY', 'PREMIUM_PAID'];

const GENDERS = ['Female', 'Male', 'Prefer not to say'];
const PROFESSIONS = ['Student', 'Unemployed', 'Professional', 'Homemaker', 'Other'];

// ---------------------------------------------------------------------------
// CORS: set ALLOWED_ORIGINS in .env (comma separated) to lock the API to your site(s).
// Empty = open to all origins (previous behaviour). Admin routes are token-protected either way.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ALLOWED_ORIGINS.length) console.warn('⚠️  ALLOWED_ORIGINS is empty: API accepts browser requests from ANY origin.');
app.use(cors({
    origin: (origin, cb) => cb(null, !origin || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Admin-Token'],
    maxAge: 600
}));
app.use(express.json({ limit: '100kb' }));

// SECURITY: express.static(__dirname) would publish server code, Excel files and data.
// Block everything that is not a website asset, then serve the rest.
const PUBLIC_JS = ['/navigant-gateway.js'];
app.use((req, res, next) => {
    let p;
    try { p = decodeURIComponent(req.path).toLowerCase(); } catch (e) { return res.status(400).send('Bad request'); }
    const blockedExt = /\.(js|json|xlsx|xls|csv|docx|md|sql|env|log|yml|yaml|lock|pem|key)$/;
    const blockedName = /(^|\/)(_?\.?env[^/]*|dockerfile|docker-compose[^/]*|package(-lock)?\.json)$/;
    if (p.startsWith('/node_modules') || p.startsWith('/.') || blockedName.test(p) || (blockedExt.test(p) && !PUBLIC_JS.includes(p))) {
        return res.status(404).send('Not found');
    }
    next();
});
app.use(express.static(__dirname, { dotfiles: 'deny' }));

// Initialize the database connection pool using our .env keys
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Auto-migrate at boot (same DDL as init-db.js, idempotent, keeps data)
const schemaReady = ensureSchema(pool, { log: (m) => console.log(m) })
    .then(() => refreshImpactLedger())
    .then(() => console.log('✔ Schema verified and impact ledger synchronised.'))
    .catch((e) => console.error('❌ Schema bootstrap failed:', e.message));

// ---------------------------------------------------------------------------
// Impact ledger: recomputed from the source tables (never drifts, safe to call any time)
// "Served" = registrations that were approved by the AI guard or verified as attended.
// ---------------------------------------------------------------------------
async function refreshImpactLedger() {
    // Learners = EVERY real row in applicants (all registrations, e.g. the 41 rows of master_database.csv).
    // Coaching hours = sum of the saved hours of every distinct batch (In Person 5 h, Online 2 h per batch).
    await pool.query(`
        INSERT INTO impact_ledger (metric_key, metric_value, updated_at)
        SELECT k, v, NOW() FROM (
            SELECT 'total_enrolled_students'::text AS k, (SELECT COUNT(*) FROM ${RA})::int AS v
            UNION ALL
            SELECT 'total_free_hours', (SELECT hours FROM (${BATCH_HOURS_SQL(RA)}) q)
            UNION ALL SELECT 'total_volunteers', (SELECT COUNT(*) FROM volunteers)::int
            UNION ALL SELECT 'total_trainers',   (SELECT COUNT(*) FROM trainers)::int
            UNION ALL SELECT 'total_interns', $1::int
            UNION ALL SELECT 'total_volunteer_trainers', $2::int
        ) t
        ON CONFLICT (metric_key) DO UPDATE SET metric_value = EXCLUDED.metric_value, updated_at = NOW();
    `, [MANUAL_INTERNS, MANUAL_VOLUNTEER_TRAINERS]);
    lastLedgerRefresh = Date.now();
}
let lastLedgerRefresh = 0;
function refreshLedgerSafe() {
    refreshImpactLedger().catch(e => console.error('⚠️ Ledger refresh failed:', e.message));
}

// ---------------------------------------------------------------------------
// Input validation (runs BEFORE the idempotency shield so a typo never burns the 10s duplicate window,
// and so the shield hashes the NORMALISED phone: "0300 1234567" == "+923001234567")
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);

function validateIntake(kind) {
    return (req, res, next) => {
        const b = req.body || {};
        const bad = (field, error) => res.status(400).json({ error, field });

        // Honeypot: bots fill the hidden field. Pretend success, store nothing.
        if (clean(b.bot_field, 50)) {
            console.warn('🍯 Honeypot triggered, submission silently dropped.');
            return res.status(200).json({ message: 'Submission processed.', system_status: 'Received' });
        }

        const name = clean(kind === 'inquiry' ? b.name : b.full_name, 100);
        const email = clean(b.email, 255).toLowerCase();
        if (!name) return bad(kind === 'inquiry' ? 'name' : 'full_name', 'Please enter your full name.');
        if (!EMAIL_RE.test(email)) return bad('email', 'Please enter a valid email address.');

        const phone = normalizePhone(b.whatsapp_number);
        if (!phone) {
            return bad('whatsapp_number',
                'Please enter a valid WhatsApp / phone number, e.g. +92 300 0000000 or 0300 0000000.');
        }

        if (kind === 'inquiry') {
            if (!clean(b.message, 5000)) return bad('message', 'Please enter a message.');
            req.body = {
                name, email, whatsapp_number: phone,
                classification: clean(b.classification, 100),
                message: clean(b.message, 5000)
            };
        } else if (kind === 'student') {
            const deliveryMode = normalizeMode(b.delivery_mode);
            if (!deliveryMode) return bad('delivery_mode', 'Please choose how you will attend: In Person or Online.');
            const gender = GENDERS.find(g => g.toLowerCase() === clean(b.gender, 30).toLowerCase()) || 'Not specified';
            const profession = PROFESSIONS.find(p => p.toLowerCase() === clean(b.profession, 60).toLowerCase())
                || (clean(b.profession, 60) ? 'Other' : 'Not specified');
            req.body = {
                full_name: name, email, whatsapp_number: phone,
                selected_course: clean(b.selected_course, 120), delivery_mode: deliveryMode,
                raw_biography: clean(b.raw_biography, 3000),
                gender, profession, city: clean(b.city, 100)
            };
        } else if (kind === 'volunteer') {
            req.body = {
                full_name: name, email, whatsapp_number: phone,
                skills_offered: clean(b.skills_offered, 1000),
                availability: clean(b.availability, 1000),
                details: clean(b.details, 5000)
            };
        } else if (kind === 'trainer') {
            req.body = {
                full_name: name, email, whatsapp_number: phone,
                expertise_domains: clean(b.expertise_domains, 1000),
                statement_of_intent: clean(b.statement_of_intent, 5000),
                linked_in_url: clean(b.linked_in_url, 500)
            };
        }
        next();
    };
}

// ---------------------------------------------------------------------------
// Admin security: X-Admin-Token vs process.env.ADMIN_TOKEN (constant-time, fail-closed, brute-force limited)
// ---------------------------------------------------------------------------
const adminFailures = new Map(); // ip -> { count, resetAt }
const ADMIN_MAX_FAILS = 10, ADMIN_WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
    const expected = String(process.env.ADMIN_TOKEN || '').trim();
    if (expected.length < 8) {
        console.error('❌ ADMIN_TOKEN missing or shorter than 8 characters in .env: admin endpoints are disabled.');
        return res.status(503).json({ error: 'Admin password is not set on the server. Add ADMIN_TOKEN (at least 8 characters) to the .env file and restart the server.' });
    }
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = adminFailures.get(ip);
    if (rec && rec.resetAt > now && rec.count >= ADMIN_MAX_FAILS) {
        res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    const supplied = String(req.get('X-Admin-Token') || '').trim();
    if (supplied && safeEqual(supplied, expected)) {
        adminFailures.delete(ip);
        res.set('Cache-Control', 'no-store');
        return next();
    }
    const cur = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + ADMIN_WINDOW_MS };
    cur.count += 1;
    adminFailures.set(ip, cur);
    console.warn(`🔒 Admin auth rejected from ${ip} (${cur.count}/${ADMIN_MAX_FAILS})`);
    return res.status(401).json({ error: 'Invalid or missing admin token.' });
}

// Light in-memory limiter for the public endpoint
const publicHits = new Map();
function publicLimiter(req, res, next) {
    const ip = req.ip || 'unknown', now = Date.now();
    const rec = publicHits.get(ip);
    if (!rec || rec.resetAt <= now) { publicHits.set(ip, { count: 1, resetAt: now + 60000 }); return next(); }
    if (++rec.count > 60) {
        res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Too many requests.' });
    }
    next();
}
setInterval(() => { const n = Date.now(); for (const [k, v] of publicHits) if (v.resetAt <= n) publicHits.delete(k); }, 120000).unref();

// A network verification test route to prove our server code talks to the database container
app.get('/api/db-test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW();');
        res.status(200).json({
            message: "Database connection verified successfully!",
            timestamp: result.rows[0].now
        });
    } catch (err) {
        console.error("Database connection failure:", err.message);
        res.status(500).json({ error: "Failed to connect to the database container." });
    }
});

// =========================================================================
// Student registrations (applicants) with AI parsing guardrails
// =========================================================================
app.post('/api/submissions', validateIntake('student'), safeShield, async (req, res) => {
    try {
        console.log("Data packet captured successfully. Passing to AI Guard...");
        const { raw_biography, full_name, email, whatsapp_number, selected_course, gender, profession, city, delivery_mode } = req.body;

        // The course the student picked in the dropdown is authoritative when it is an official track.
        // The AI guard is used for free-text / unmatched entries.
        let aiAnalysis = { matched_track: findOfficialTrack(selected_course), stream_type: 'FREE_COMMUNITY' };
        if (!aiAnalysis.matched_track) {
            try {
                aiAnalysis = (await analyzeApplicationBio(raw_biography || selected_course || '')) || aiAnalysis;
            } catch (aiErr) {
                console.error("AI Guard failure, using selected course instead:", aiErr.message);
                aiAnalysis = { matched_track: selected_course || '', stream_type: 'FREE_COMMUNITY' };
            }
            if (!aiAnalysis.matched_track && selected_course) aiAnalysis.matched_track = selected_course;
        }
        console.log("AI Extraction Results:", aiAnalysis);

        let status = 'Approved';
        let matchedTrack = findOfficialTrack(aiAnalysis.matched_track);
        if (!matchedTrack) {
            status = 'Halted: Pending Review';
            matchedTrack = 'Unrecognized/Other';
        }
        const testEntry = isTestEntry(full_name, email);
        if (testEntry) status = 'Test: Ignored';   // saved for your testing, never counted in stats
        const streamType = VALID_STREAMS.includes(aiAnalysis.stream_type) ? aiAnalysis.stream_type : 'FREE_COMMUNITY';

        const uniqueHash = dailyHash(req.idempotencyHash, `hash_${whatsapp_number}`, selected_course || '');

        // mode, batch label and batch hours are saved TOGETHER from the one rule above (never mixed, never defaulted)
        const batchHours = HOURS_PER_BATCH[delivery_mode];
        const batchLabel = webBatchLabel(matchedTrack, delivery_mode);
        const insertQuery = `
            INSERT INTO applicants
            (full_name, email, whatsapp_number, raw_biography, extracted_track, stream_type, status,
             gender, profession, city, delivery_mode, batch_hours, workshop_batch, idempotency_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id;
        `;
        const dbResult = await pool.query(insertQuery, [
            full_name, email, whatsapp_number, raw_biography || '', matchedTrack, streamType, status,
            gender, profession, city, delivery_mode, batchHours, batchLabel, uniqueHash
        ]);

        const assignedId = dbResult.rows[0].id;
        console.log(`🎉 Record successfully saved to database with ID: ${assignedId}`);
        refreshLedgerSafe();

        dispatchEmailAlert('Student Pipeline Registration', {
            Full_Name: full_name,
            Email: email,
            WhatsApp_Number: whatsapp_number,
            Course: matchedTrack,
            Delivery_Mode: delivery_mode + ' (' + batchHours + ' batch hours)',
            Profession: profession,
            Gender: gender,
            City: city || 'Not provided',
            Status: status,
            Application_Details: raw_biography
        });
        res.status(200).json({
            message: "Submission processed and saved by Navigant Core gateway!",
            database_id: assignedId,
            extracted_track: matchedTrack,
            stream_classification: streamType,
            delivery_mode,
            batch_hours: batchHours,
            system_status: testEntry ? 'Test entry (not counted in statistics)' : status
        });

    } catch (err) {
        console.error("Gateway execution crash:", err);
        if (err.code === '23505') {
            return res.status(409).json({ error: "This submission was already received today." });
        }
        res.status(500).json({ error: "Internal operational gateway failure." });
    }
});

// =========================================================================
// Multi-Stream Data Isolation Gateways (Volunteers & Trainers)
// =========================================================================
app.post('/api/volunteers', validateIntake('volunteer'), safeShield, async (req, res) => {
    try {
        console.log("Volunteer application packet captured. Processing isolation layer...");
        const { full_name, email, whatsapp_number, skills_offered, availability, details } = req.body;
        const uniqueHash = dailyHash(req.idempotencyHash, `vol_hash_${whatsapp_number}`);

        const dbResult = await pool.query(`
            INSERT INTO volunteers (full_name, email, whatsapp_number, skills_offered, availability, details, idempotency_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id;
        `, [full_name, email, whatsapp_number, skills_offered, availability, details, uniqueHash]);

        const assignedId = dbResult.rows[0].id;
        console.log(`🎉 Volunteer record successfully isolated and saved with ID: ${assignedId}`);
        refreshLedgerSafe();

        dispatchEmailAlert('Volunteer Contribution Stream', {
            Full_Name: full_name,
            Contact_Email: email,
            WhatsApp_Number: whatsapp_number,
            Contribution_Type: skills_offered || 'Not provided',
            Availability_Details: availability || 'Not provided',
            Details: details || 'Not provided'
        }, email);
        res.status(200).json({
            message: "Volunteer profile processed and isolated by Navigant Core gateway!",
            database_id: assignedId,
            system_status: "Isolated & Approved"
        });
    } catch (err) {
        console.error("Volunteer gateway execution crash:", err);
        if (err.code === '23505') {
            return res.status(409).json({ error: "This submission was already received today." });
        }
        res.status(500).json({ error: "Internal operational volunteer gateway failure." });
    }
});

app.post('/api/trainers', validateIntake('trainer'), safeShield, async (req, res) => {
    try {
        console.log("Trainer profile packet captured. Processing isolation layer...");
        const { full_name, email, whatsapp_number, expertise_domains, statement_of_intent, linked_in_url } = req.body;
        const uniqueHash = dailyHash(req.idempotencyHash, `train_hash_${whatsapp_number}`);

        const dbResult = await pool.query(`
            INSERT INTO trainers (full_name, email, whatsapp_number, expertise_domains, statement_of_intent, linked_in_url, idempotency_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id;
        `, [full_name, email, whatsapp_number, expertise_domains, statement_of_intent, linked_in_url, uniqueHash]);

        const assignedId = dbResult.rows[0].id;
        console.log(`🎉 Trainer profile successfully isolated and saved with ID: ${assignedId}`);
        refreshLedgerSafe();

        dispatchEmailAlert('Trainer / Intern Profiler', {
            Candidate_Name: full_name,
            Contact_Email: email,
            WhatsApp_Number: whatsapp_number,
            Target_Assignment: expertise_domains || 'Not provided',
            Statement_Of_Intent: statement_of_intent || 'Not provided'
        }, email);
        res.status(200).json({
            message: "Trainer profile processed and isolated by Navigant Core gateway!",
            database_id: assignedId,
            system_status: "Isolated & Approved"
        });
    } catch (err) {
        console.error("Trainer gateway execution crash:", err);
        if (err.code === '23505') {
            return res.status(409).json({ error: "This submission was already received today." });
        }
        res.status(500).json({ error: "Internal operational trainer gateway failure." });
    }
});

// =========================================================================
// Institutional / premium inquiries (contact form + One-to-One Coaching (Paid))
// =========================================================================
app.post('/api/inquiries', validateIntake('inquiry'), safeShield, async (req, res) => {
    try {
        console.log("Inquiry packet captured. Validating...");
        const { name, email, whatsapp_number, classification, message } = req.body;

        const dbResult = await pool.query(
            `INSERT INTO inquiries (name, email, whatsapp_number, classification, message)
             VALUES ($1, $2, $3, $4, $5) RETURNING id;`,
            [name, email, whatsapp_number, classification, message]
        );
        const assignedId = dbResult.rows[0].id;
        console.log(`🎉 Inquiry saved with ID: ${assignedId}`);

        dispatchEmailAlert('Institutional Inquiry', {
            Name: name,
            Email: email,
            WhatsApp_Number: whatsapp_number,
            Inquiry_Type: classification || 'Not specified',
            Message: message
        }, email);

        res.status(200).json({
            message: "Inquiry received by Navigant Core gateway!",
            database_id: assignedId
        });
    } catch (err) {
        console.error("Inquiry gateway execution crash:", err);
        res.status(500).json({ error: "Internal operational inquiry gateway failure." });
    }
});

// =========================================================================
// PUBLIC read-only impact summary: ONLY aggregated integers, never personal data.
//   GET /api/public/impact-summary                    -> all time (headline numbers come from impact_ledger)
//   GET /api/public/impact-summary?year=2026          -> that calendar year
//   GET /api/public/impact-summary?year=2026&half=2   -> H2 (Jul - Dec) of that year; half=1 is H1 (Jan - Jun)
// =========================================================================
const STREAM_RULES = [
    ['tech',     /ai essentials|ai automation|graphic|social media|digital marketing|coding|game dev|website/i],
    ['career',   /resume|job search|interview|motivational|leadership|profile building|personal branding|public speaking|communication/i],
    ['academic', /university|scholarship|ielts|english|academic|statement of purpose|personal statement/i]
];
const streamOf = (track) => (STREAM_RULES.find(([, re]) => re.test(track)) || ['other'])[0];

// Half-years: 1 = H1 (Jan - Jun), 2 = H2 (Jul - Dec)
function periodRange(year, half) {
    if (!half) return [`${year}-01-01`, `${year + 1}-01-01`];
    return half === 1 ? [`${year}-01-01`, `${year}-07-01`] : [`${year}-07-01`, `${year + 1}-01-01`];
}

app.get('/api/public/impact-summary', publicLimiter, async (req, res) => {
    try {
        let year = null, half = null;
        if (req.query.year !== undefined && req.query.year !== '') {
            year = Number(req.query.year);
            if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Invalid year.' });
            if (req.query.half !== undefined && req.query.half !== '' && req.query.half !== '0') {
                half = Number(req.query.half);
                if (![1, 2].includes(half)) return res.status(400).json({ error: 'Half must be 1 (Jan - Jun) or 2 (Jul - Dec).' });
            }
        }
        // Self-healing: if the ledger is older than 30s (e.g. after a CSV seed or DB reset) recompute it first.
        if (Date.now() - lastLedgerRefresh > 30000) await refreshImpactLedger();

        const where = year ? 'WHERE created_at >= $1::timestamp AND created_at < $2::timestamp' : '';
        const params = year ? periodRange(year, half) : [];
        const [trackQ, hoursQ, modeQ, yearsQ, ledgerQ] = await Promise.all([
            // per course: learners + distinct batches + the saved hours of those batches
            pool.query(`
                WITH r AS (
                    SELECT COALESCE(NULLIF(TRIM(extracted_track), ''), 'Unspecified') AS track,
                           NULLIF(TRIM(workshop_batch), '') AS batch, created_at::date AS d, batch_hours
                    FROM ${RA} ${where}
                ), l AS (SELECT track, COUNT(*)::int AS learners FROM r GROUP BY track),
                   b AS (SELECT track, COUNT(*)::int AS batches, COALESCE(SUM(bh), 0)::int AS hours FROM (
                            SELECT track, MAX(batch_hours) AS bh FROM r WHERE batch IS NOT NULL GROUP BY track, batch, d) z GROUP BY track)
                SELECT l.track, l.learners, COALESCE(b.batches, 0) AS batches, COALESCE(b.hours, 0) AS hours
                FROM l LEFT JOIN b USING (track)`, params),
            pool.query(BATCH_HOURS_SQL(RA, where), params),
            // batches and hours per delivery mode (+ batches whose mode is unknown, which count 0 hours)
            pool.query(`
                SELECT COALESCE(NULLIF(mode, ''), 'Unknown') AS mode, COUNT(*)::int AS batches, COALESCE(SUM(bh), 0)::int AS hours FROM (
                    SELECT MAX(delivery_mode) AS mode, MAX(batch_hours) AS bh FROM ${RA} ${where}
                    ${where ? 'AND' : 'WHERE'} NULLIF(TRIM(workshop_batch), '') IS NOT NULL
                    GROUP BY workshop_batch, created_at::date) y GROUP BY 1`, params),
            pool.query(`SELECT DISTINCT EXTRACT(YEAR FROM created_at)::int AS y FROM ${RA} ORDER BY 1 DESC`),
            pool.query(`SELECT metric_key, metric_value, updated_at FROM impact_ledger
                        WHERE metric_key = ANY($1::text[])`,
                       [['total_enrolled_students', 'total_free_hours', 'total_interns', 'total_volunteer_trainers']])
        ]);

        const m = {};
        let updatedAt = null;
        ledgerQ.rows.forEach(r => { m[r.metric_key] = r.metric_value; if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at; });

        const by_track = trackQ.rows.map(r => ({
            track: r.track, stream: streamOf(r.track), learners: r.learners, batches: r.batches, hours: r.hours
        }));
        const by_stream = { tech: { learners: 0, hours: 0, batches: 0 }, career: { learners: 0, hours: 0, batches: 0 },
                            academic: { learners: 0, hours: 0, batches: 0 }, other: { learners: 0, hours: 0, batches: 0 } };
        by_track.forEach(t => { const s = by_stream[t.stream]; s.learners += t.learners; s.hours += t.hours; s.batches += t.batches; });
        const learners = by_track.reduce((a, t) => a + t.learners, 0);
        const by_mode = { in_person: { batches: 0, hours: 0 }, online: { batches: 0, hours: 0 }, unknown: { batches: 0, hours: 0 } };
        modeQ.rows.forEach(r => {
            const k = r.mode === 'In Person' ? 'in_person' : r.mode === 'Online' ? 'online' : 'unknown';
            by_mode[k].batches += r.batches; by_mode[k].hours += r.hours;
        });

        // The team is a "today" number: shown for Till Now and for the current year only.
        const teamIncluded = !year || year === new Date().getFullYear();
        const vt = m.total_volunteer_trainers ?? MANUAL_VOLUNTEER_TRAINERS;
        const interns = m.total_interns ?? MANUAL_INTERNS;

        res.set('Cache-Control', 'public, max-age=60');
        res.status(200).json({
            period: { year, half },
            total_students_served: year ? learners : (m.total_enrolled_students ?? learners),
            total_coaching_hours: year ? hoursQ.rows[0].hours : (m.total_free_hours ?? hoursQ.rows[0].hours),
            total_batches: hoursQ.rows[0].batches,
            total_volunteer_trainers: teamIncluded ? vt : 0,
            total_interns: teamIncluded ? interns : 0,
            team_included: teamIncluded,
            // legacy aliases (kept so older pages keep working)
            total_volunteers: teamIncluded ? vt : 0,
            total_trainers: teamIncluded ? interns : 0,
            by_stream,
            by_track,
            by_mode,
            years_with_data: yearsQ.rows.map(r => r.y),
            updated_at: updatedAt ? new Date(updatedAt).toISOString() : null
        });
    } catch (err) {
        console.error('Public impact summary failure:', err.message);
        res.status(500).json({ error: 'Impact summary is temporarily unavailable.' });
    }
});

// =========================================================================
// ADMIN: analytics (token protected via X-Admin-Token)
// =========================================================================
const COHORT_CASE = `
    CASE
        WHEN extracted_track ILIKE 'AI Essentials%'  THEN 'AI Essentials'
        WHEN extracted_track ILIKE 'Graphic Design%' THEN 'Graphic Designing'
        WHEN extracted_track ILIKE '%IELTS%'         THEN 'IELTS Prep'
        ELSE 'Other Courses'
    END`;

const DEMOGRAPHIC_SQL = {
    gender: `SELECT COALESCE(NULLIF(TRIM(gender), ''), 'Not specified') AS label, COUNT(*)::int AS count
             FROM ${RA} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
    profession: `SELECT COALESCE(NULLIF(TRIM(profession), ''), 'Not specified') AS label, COUNT(*)::int AS count
                 FROM ${RA} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
    city: `SELECT COALESCE(NULLIF(CASE WHEN LENGTH(TRIM(city)) <= 3 THEN UPPER(TRIM(city)) ELSE INITCAP(TRIM(city)) END, ''), 'Not specified') AS label, COUNT(*)::int AS count
           FROM ${RA} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`
};

app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
    try {
        const [totalQ, servedQ, uniqueQ, streamQ, trackQ, cohortQ, monthQ, genderQ, profQ, cityQ, volQ, trnQ, inqQ] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total FROM ${RA};`),
            pool.query(`SELECT COUNT(*)::int AS total FROM ${RA};`),
            pool.query(`SELECT COUNT(DISTINCT whatsapp_number)::int AS total FROM ${RA} WHERE whatsapp_number <> '';`),
            pool.query(`SELECT stream_type, COUNT(*)::int AS count FROM ${RA} GROUP BY stream_type;`),
            pool.query(`
                SELECT COALESCE(NULLIF(TRIM(extracted_track), ''), 'Unspecified') AS track,
                       COUNT(*)::int AS count,
                       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)::float AS pct
                FROM ${RA} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20;`),
            pool.query(`SELECT ${COHORT_CASE} AS cohort, COUNT(*)::int AS count
                        FROM ${RA} GROUP BY 1 ORDER BY 2 DESC;`),
            pool.query(`
                WITH bounds AS (
                    SELECT date_trunc('month', COALESCE(MIN(created_at), LOCALTIMESTAMP)) AS first_m FROM ${RA}
                ), series AS (
                    SELECT generate_series(
                        GREATEST(LEAST(first_m, date_trunc('month', LOCALTIMESTAMP)),
                                 date_trunc('month', LOCALTIMESTAMP) - INTERVAL '11 months'),
                        date_trunc('month', LOCALTIMESTAMP), INTERVAL '1 month') AS m
                    FROM bounds
                ), counts AS (
                    SELECT date_trunc('month', created_at) AS m, COUNT(*)::int AS c FROM ${RA} GROUP BY 1
                )
                SELECT to_char(s.m, 'YYYY-MM') AS month, to_char(s.m, 'Mon YYYY') AS label, COALESCE(c.c, 0) AS count
                FROM series s LEFT JOIN counts c ON c.m = s.m ORDER BY s.m;`),
            pool.query(DEMOGRAPHIC_SQL.gender),
            pool.query(DEMOGRAPHIC_SQL.profession),
            pool.query(DEMOGRAPHIC_SQL.city),
            pool.query('SELECT COUNT(*)::int AS total FROM volunteers;'),
            pool.query('SELECT COUNT(*)::int AS total FROM trainers;'),
            pool.query('SELECT COUNT(*)::int AS total FROM inquiries;')
        ]);

        // Coaching hours = saved hours of every distinct batch (In Person 5 h, Online 2 h)
        const hoursQ = await pool.query(BATCH_HOURS_SQL(RA));
        const totalFreeHours = hoursQ.rows[0].hours;

        const cohortTotal = cohortQ.rows.reduce((s, r) => s + r.count, 0) || 1;

        res.status(200).json({
            metrics_refreshed_at: new Date().toISOString(),
            total_students_enrolled: totalQ.rows[0].total,        // all registrations (kept for backward compatibility)
            total_students_served: servedQ.rows[0].total,         // approved / verified only
            unique_participants: uniqueQ.rows[0].total,
            total_volunteers: volQ.rows[0].total,
            total_trainers: trnQ.rows[0].total,
            total_inquiries: inqQ.rows[0].total,
            free_technical_coaching_hours: totalFreeHours,
            total_batches: hoursQ.rows[0].batches,
            team: { volunteer_trainers: MANUAL_VOLUNTEER_TRAINERS, interns: MANUAL_INTERNS },   // same numbers the public site shows for Till Now
            stream_metrics: streamQ.rows,
            track_metrics: trackQ.rows,                            // legacy shape {track,count}
            monthly_metrics: monthQ.rows,                          // legacy shape {month,count}
            registration_trends: monthQ.rows,                      // {month,label,count} gap-filled, last 12 months
            track_popularity: trackQ.rows,                         // {track,count,pct}
            workshop_cohort_density: cohortQ.rows.map(r => ({
                cohort: r.cohort, count: r.count, pct: Math.round((1000 * r.count) / cohortTotal) / 10
            })),
            demographics: { gender: genderQ.rows, profession: profQ.rows, city: cityQ.rows }
        });
    } catch (err) {
        console.error("Metrics engine collection failure:", err);
        res.status(500).json({ error: "Failed to compile live system impact metrics." });
    }
});

// ADMIN: latest records per stream (powers the dashboard tabs). Whitelisted columns only; no hashes.
const RECORD_QUERIES = {
    students:   `SELECT id, full_name, email, whatsapp_number, extracted_track, status, profession, gender, city, created_at
                 FROM applicants ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    volunteers: `SELECT id, full_name, email, whatsapp_number, skills_offered, details, created_at
                 FROM volunteers ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    trainers:   `SELECT id, full_name, email, whatsapp_number, expertise_domains, statement_of_intent, created_at
                 FROM trainers ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
    inquiries:  `SELECT id, name, email, whatsapp_number, classification, message, created_at
                 FROM inquiries ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`
};
app.get('/api/admin/records/:stream', requireAdmin, async (req, res) => {
    const sql = RECORD_QUERIES[req.params.stream];
    if (!sql) return res.status(404).json({ error: 'Unknown stream. Use students, volunteers, trainers or inquiries.' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    try {
        const { rows } = await pool.query(sql, [limit, offset]);
        res.status(200).json({ stream: req.params.stream, limit, offset, count: rows.length, rows });
    } catch (err) {
        console.error('Admin records failure:', err.message);
        res.status(500).json({ error: 'Failed to load records.' });
    }
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
    console.error('❌ Unhandled Express error:', err);
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
        return res.status(err.status || 400).json({ error: 'Invalid request body.' });
    }
    res.status(500).json({ error: 'Unhandled server error.' });
});
process.on('unhandledRejection', (r) => console.error('❌ unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('❌ uncaughtException:', e));

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Navigant Core Engine [${SERVER_VERSION}] is running safely on port ${PORT} (pid ${process.pid})`);
    });
}
module.exports = { app, pool, schemaReady };
