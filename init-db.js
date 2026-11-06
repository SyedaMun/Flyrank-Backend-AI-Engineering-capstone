const { Pool } = require('pg');
require('dotenv').config();
const { ensureSchema } = require('./schema');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Usage:
//   node init-db.js          -> creates missing tables / columns, keeps existing data
//   node init-db.js --reset  -> DROPS everything and rebuilds (data loss!)
const RESET = process.argv.includes('--reset');

(async () => {
    try {
        console.log('Connecting to database container to build core schemas...');
        await ensureSchema(pool, { reset: RESET, log: (m) => console.log(m) });
        console.log('⚡ All database models are built and ready!');
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('❌ Database initialization failed:', err.message);
        process.exit(1);
    }
})();
