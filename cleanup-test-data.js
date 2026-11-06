/**
 * cleanup-test-data.js - removes TEST registrations from the database. CSV-imported learners are NEVER touched.
 *
 *   node cleanup-test-data.js              -> PREVIEW only (shows what would be deleted, deletes nothing)
 *   node cleanup-test-data.js --delete     -> deletes entries that look like tests (name has "test", email test@ / @test. / @example.)
 *   node cleanup-test-data.js --all-web --delete
 *                                          -> deletes EVERY row that came from the website forms (keeps only CSV imports)
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST || 'localhost', database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD, port: Number(process.env.DB_PORT || 5432),
});
const DELETE = process.argv.includes('--delete');
const ALL_WEB = process.argv.includes('--all-web');
const EMAIL_TEST = `email ~* '(^test|\\+test|@test\\.|@example\\.)'`;

const targets = [
    { table: 'applicants', label: 'full_name', cols: 'id, full_name AS who, email, status',
      where: ALL_WEB ? `idempotency_hash NOT LIKE 'csv\\_%'`
                     : `idempotency_hash NOT LIKE 'csv\\_%' AND (status LIKE 'Test:%' OR full_name ~* '\\mtest\\M' OR ${EMAIL_TEST})` },
    { table: 'volunteers', cols: 'id, full_name AS who, email, skills_offered AS status',
      where: ALL_WEB ? 'TRUE' : `(full_name ~* '\\mtest\\M' OR ${EMAIL_TEST})` },
    { table: 'trainers', cols: 'id, full_name AS who, email, expertise_domains AS status',
      where: ALL_WEB ? 'TRUE' : `(full_name ~* '\\mtest\\M' OR ${EMAIL_TEST})` },
    { table: 'inquiries', cols: 'id, name AS who, email, classification AS status',
      where: ALL_WEB ? 'TRUE' : `(name ~* '\\mtest\\M' OR ${EMAIL_TEST})` },
];

(async () => {
    try {
        console.log(DELETE ? '🗑️  DELETE mode' : '👀 PREVIEW mode (nothing will be deleted)', ALL_WEB ? '- scope: ALL website-form rows' : '- scope: test-looking rows only');
        let total = 0;
        for (const t of targets) {
            const { rows } = await pool.query(`SELECT ${t.cols} FROM ${t.table} WHERE ${t.where} ORDER BY id`);
            console.log(`\n${t.table}: ${rows.length} row(s)`);
            rows.forEach(r => console.log(`   #${r.id}  ${r.who}  <${r.email}>  ${r.status || ''}`));
            total += rows.length;
            if (DELETE && rows.length) await pool.query(`DELETE FROM ${t.table} WHERE ${t.where}`);
        }
        console.log(DELETE ? `\n✅ Deleted ${total} row(s). Restart the server (or wait 30 seconds) so the public numbers refresh.`
                           : `\nℹ️  ${total} row(s) found. Run again with --delete to remove them.`);
    } catch (e) { console.error('❌', e.message); process.exitCode = 1; }
    finally { await pool.end(); }
})();
