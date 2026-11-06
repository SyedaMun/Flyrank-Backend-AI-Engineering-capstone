/**
 * Navigant Core - API tests (Node's built-in test runner, no extra packages).
 *
 *   1. start the database and the server  (see README, "Quick start")
 *   2. npm test
 *
 * Optional environment variables:
 *   BASE_URL     where the server runs               (default http://localhost:5000)
 *   ADMIN_TOKEN  same value as in .env               (enables the admin tests)
 *   DB_*         same values as in .env              (enables the database-rule test)
 *
 * Every registration made here uses the word "Test" in the name, so the system saves it as
 * 'Test: Ignored' and it is never counted in any statistic.
 */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const ADMIN = (process.env.ADMIN_TOKEN || '').trim();
const uid = () => Math.random().toString(36).slice(2, 10);
const post = (path, body, raw) => fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body)
});
const getJson = async (path, headers) => { const r = await fetch(BASE + path, { headers }); return { status: r.status, body: await r.json() }; };
const student = (over = {}) => ({
    full_name: 'Test Student ' + uid(), email: `test.${uid()}@example.com`, whatsapp_number: '0300 1234567',
    selected_course: 'Graphic Designing', delivery_mode: 'Online', ...over
});

test('server is up', async () => {
    const { status, body } = await getJson('/api/health');
    assert.equal(status, 200); assert.equal(body.ok, true);
});

test('public impact summary exposes only counted numbers, never personal data', async () => {
    const { status, body } = await getJson('/api/public/impact-summary');
    assert.equal(status, 200);
    for (const k of ['total_students_served', 'total_coaching_hours', 'total_batches']) assert.equal(typeof body[k], 'number', k);
    assert.ok(!/email|phone|whatsapp|full_name/i.test(JSON.stringify(body)), 'no personal field may appear');
});

test('public filters: bad year or half-year gives a clean 400, never a 500', async () => {
    assert.equal((await getJson('/api/public/impact-summary?year=abc')).status, 400);
    assert.equal((await getJson('/api/public/impact-summary?year=2026&half=3')).status, 400);
    assert.equal((await getJson('/api/public/impact-summary?year=2026;DROP')).status, 400);
});

test('half-year filter answers for that period', async () => {
    const h1 = await getJson('/api/public/impact-summary?year=2026&half=1');
    const h2 = await getJson('/api/public/impact-summary?year=2026&half=2');
    assert.deepEqual(h1.body.period, { year: 2026, half: 1 });
    assert.deepEqual(h2.body.period, { year: 2026, half: 2 });
});

test('admin endpoints refuse a missing or a wrong token', async () => {
    for (const path of ['/api/admin/metrics', '/api/admin/records/students']) {
        assert.equal((await getJson(path)).status, 401, path + ' without token');
        assert.equal((await getJson(path, { 'X-Admin-Token': 'definitely-wrong' })).status, 401, path + ' wrong token');
    }
});

test('admin metrics work with the right token', { skip: !ADMIN && 'set ADMIN_TOKEN to run' }, async () => {
    const { status, body } = await getJson('/api/admin/metrics', { 'X-Admin-Token': ADMIN });
    assert.equal(status, 200); assert.equal(typeof body.total_students_enrolled, 'number');
    assert.ok(Array.isArray(body.registration_trends));
});

test('validation: bad phone number -> 400 naming the field', async () => {
    const r = await post('/api/submissions', student({ whatsapp_number: 'abc' }));
    const b = await r.json(); assert.equal(r.status, 400); assert.equal(b.field, 'whatsapp_number');
});

test('validation: bad email -> 400', async () => {
    const r = await post('/api/submissions', student({ email: 'not-an-email' }));
    assert.equal(r.status, 400); assert.equal((await r.json()).field, 'email');
});

test('delivery mode is required: no fallback default for hours', async () => {
    const r = await post('/api/submissions', student({ delivery_mode: '' }));
    const b = await r.json(); assert.equal(r.status, 400); assert.equal(b.field, 'delivery_mode');
});

test('malformed JSON -> 400, never 500', async () => {
    const r = await post('/api/submissions', null, '{ this is not json');
    assert.equal(r.status, 400);
});

test('oversized body -> clean 4xx, never 500', async () => {
    const r = await post('/api/submissions', student({ raw_biography: 'x'.repeat(300000) }));
    assert.ok([400, 413].includes(r.status), 'got ' + r.status);
});

test('honeypot: a bot gets a fake success', async () => {
    const r = await post('/api/inquiries', { name: 'Test Bot', email: 'bot@example.com', bot_field: 'i am a bot' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).system_status, 'Received');
});

test('idempotency: the same registration sent twice creates exactly one record', async () => {
    const payload = student();
    const first = await post('/api/submissions', payload);
    const second = await post('/api/submissions', payload);
    assert.equal(first.status, 200, 'first request');
    assert.equal(second.status, 409, 'second request must be refused');
    const b = await first.json();
    assert.equal(b.delivery_mode, 'Online'); assert.equal(b.batch_hours, 2);
});

test('In Person saves 5 batch hours, Online saves 2 (never mixed)', async () => {
    const a = await (await post('/api/submissions', student({ delivery_mode: 'In Person' }))).json();
    const b = await (await post('/api/submissions', student({ delivery_mode: 'online' }))).json();
    assert.deepEqual([a.delivery_mode, a.batch_hours], ['In Person', 5]);
    assert.deepEqual([b.delivery_mode, b.batch_hours], ['Online', 2]);
});

test('test registrations are never counted in the statistics', async () => {
    const year = new Date().getFullYear();
    const before = (await getJson('/api/public/impact-summary?year=' + year)).body.total_students_served;
    const r = await post('/api/submissions', student());
    assert.equal(r.status, 200);
    assert.match((await r.json()).system_status, /not counted/i);
    const after = (await getJson('/api/public/impact-summary?year=' + year)).body.total_students_served;
    assert.equal(after, before);
});

test('the database itself refuses a mismatched delivery mode and hours', { skip: !process.env.DB_NAME && 'set DB_* to run' }, async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    try {
        await assert.rejects(
            pool.query(`INSERT INTO applicants (idempotency_hash, full_name, whatsapp_number, stream_type, delivery_mode, batch_hours)
                        VALUES ($1, 'Mix', '+923001112222', 'FREE_COMMUNITY', 'Online', 5)`, ['test-mix-' + uid()]),
            (e) => e.constraint === 'applicants_mode_hours_chk');
    } finally { await pool.end(); }
});
