const crypto = require('crypto');

// A temporary local memory cache to track incoming signatures for 10 seconds
const submissionCache = new Map();

function idempotencyShield(req, res, next) {
    const { email, whatsapp_number } = req.body;

    // If an application doesn't have identifiers, pass it through to regular checks
    if (!email && !whatsapp_number) {
        return next();
    }

     // Generate a unique cryptographic signature hash from contact info AND the specific target form endpoint
    const identityString = `${email || ''}-${whatsapp_number || ''}-${req.originalUrl}`;
    const hash = crypto.createHash('sha256').update(identityString).digest('hex');

    // Check if this exact person hit submit within our 10-second protection window
    if (submissionCache.has(hash)) {
        console.warn(`[SHIELD DETECTED] Duplicate click blocked for signature: ${hash}`);
        return res.status(409).json({
            error: "Duplicate submission detected! Please wait a moment before trying again."
        });
    }

    // Securely cache the signature hash and remove it after 10 seconds
    submissionCache.set(hash, true);
    setTimeout(() => submissionCache.delete(hash), 10000);

    // Save the hash on the request object so we can write it to our database later
    req.idempotencyHash = hash;
    next();
}

module.exports = idempotencyShield;
