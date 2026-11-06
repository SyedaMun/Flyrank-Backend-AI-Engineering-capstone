/**
 * schema.js - the ONE place that defines the PostgreSQL schema.
 * Used by init-db.js (CLI) and server.js (auto-migrate at boot), so they can never drift apart.
 * Everything is idempotent: safe to run on an existing database, existing rows are kept.
 */
const PHONE_CHECK = "whatsapp_number ~ '^(\\+[1-9][0-9]{7,14})?$'";

async function addPhoneConstraint(pool, table, name) {
    // NOT VALID = enforced for every NEW insert/update, legacy rows are left untouched.
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
                ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${PHONE_CHECK}) NOT VALID;
            END IF;
        END $$;`);
}

async function ensureSchema(pool, { reset = false, log = () => {} } = {}) {
    if (reset) {
        log('⚠️  --reset flag detected: dropping existing tables.');
        await pool.query('DROP TABLE IF EXISTS applicants, volunteers, trainers, inquiries, impact_ledger;');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS applicants (
            id SERIAL PRIMARY KEY,
            idempotency_hash VARCHAR(255) UNIQUE NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            whatsapp_number VARCHAR(50) NOT NULL,
            raw_biography TEXT,
            extracted_track VARCHAR(100),
            stream_type VARCHAR(20) NOT NULL,
            status VARCHAR(30) DEFAULT 'Pending Review',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS email VARCHAR(255) NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS gender VARCHAR(30) NOT NULL DEFAULT 'Not specified';`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS profession VARCHAR(60) NOT NULL DEFAULT 'Not specified';`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS city VARCHAR(100) NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS workshop_batch VARCHAR(60) NOT NULL DEFAULT '';`);
    // Delivery mode of the batch + the hours saved for it. One rule, enforced by the database itself:
    //   In Person = 5 hours per batch | Online = 2 hours per batch | unknown (legacy rows) = '' and 0
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(20) NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE applicants ADD COLUMN IF NOT EXISTS batch_hours INT NOT NULL DEFAULT 0;`);
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applicants_mode_hours_chk') THEN
                ALTER TABLE applicants ADD CONSTRAINT applicants_mode_hours_chk CHECK (
                    (delivery_mode = 'In Person' AND batch_hours = 5) OR
                    (delivery_mode = 'Online'    AND batch_hours = 2) OR
                    (delivery_mode = ''          AND batch_hours = 0)
                );
            END IF;
        END $$;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_applicants_created_at ON applicants (created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_applicants_track ON applicants (extracted_track);`);
    await addPhoneConstraint(pool, 'applicants', 'applicants_phone_fmt_chk');
    log("✔ Table 'applicants' ready.");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS volunteers (
            id SERIAL PRIMARY KEY,
            idempotency_hash VARCHAR(255) UNIQUE NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            whatsapp_number VARCHAR(255) NOT NULL,
            skills_offered TEXT,
            availability TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
    await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS email VARCHAR(255) NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE volunteers ADD COLUMN IF NOT EXISTS details TEXT;`);
    await addPhoneConstraint(pool, 'volunteers', 'volunteers_phone_fmt_chk');
    log("✔ Table 'volunteers' ready.");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS trainers (
            id SERIAL PRIMARY KEY,
            idempotency_hash VARCHAR(255) UNIQUE NOT NULL,
            full_name VARCHAR(100) NOT NULL,
            whatsapp_number VARCHAR(255) NOT NULL,
            expertise_domains TEXT,
            linked_in_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
    await pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS email VARCHAR(255) NOT NULL DEFAULT '';`);
    await pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS statement_of_intent TEXT;`);
    await addPhoneConstraint(pool, 'trainers', 'trainers_phone_fmt_chk');
    log("✔ Table 'trainers' ready.");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS inquiries (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) NOT NULL,
            classification VARCHAR(100),
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
    await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(255) NOT NULL DEFAULT '';`);
    await addPhoneConstraint(pool, 'inquiries', 'inquiries_phone_fmt_chk');
    log("✔ Table 'inquiries' ready.");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS impact_ledger (
            id SERIAL PRIMARY KEY,
            metric_key VARCHAR(50) UNIQUE NOT NULL,
            metric_value INT DEFAULT 0 NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
    await pool.query(`
        INSERT INTO impact_ledger (metric_key, metric_value) VALUES
            ('total_enrolled_students', 0),
            ('total_free_hours', 0),
            ('total_volunteers', 0),
            ('total_trainers', 0)
        ON CONFLICT (metric_key) DO NOTHING;`);
    log("✔ Table 'impact_ledger' ready (counters initialised).");
}

module.exports = { ensureSchema };
