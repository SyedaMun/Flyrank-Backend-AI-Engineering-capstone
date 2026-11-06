/**
 * phone.js - single source of truth for WhatsApp / phone validation (server side).
 * Output is always E.164: "+" then 8-15 digits, e.g. +923001234567.
 * Set DEFAULT_COUNTRY_CODE in .env (default 92 = Pakistan) for numbers typed in national format.
 */
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '92').replace(/\D/g, '') || '92';
const E164 = /^\+[1-9][0-9]{7,14}$/;

function normalizePhone(input) {
    if (input === null || input === undefined) return null;
    const raw = String(input).trim();
    if (!raw || raw.length > 30) return null;
    if (/[^\d\s+\-().]/.test(raw)) return null;       // letters / symbols are rejected

    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    let out;
    if (raw.startsWith('+')) out = '+' + digits;                         // already international
    else if (digits.startsWith('00')) out = '+' + digits.slice(2);       // 0092...
    else if (digits.startsWith('0')) out = '+' + DEFAULT_CC + digits.slice(1); // 0300... national
    else if (DEFAULT_CC === '92' && digits.length === 10 && digits.startsWith('3')) out = '+92' + digits; // 300...
    else if (digits.startsWith(DEFAULT_CC) && digits.length >= DEFAULT_CC.length + 8) out = '+' + digits;  // 92300...
    else return null;

    if (!E164.test(out)) return null;
    // Pakistani mobiles: +92 3XX XXXXXXX -> exactly 10 national digits
    if (out.startsWith('+92') && out[3] === '3' && out.length !== 13) return null;
    return out;
}

module.exports = { normalizePhone, E164 };
