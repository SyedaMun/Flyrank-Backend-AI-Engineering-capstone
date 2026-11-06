const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper function to pause execution for a brief moment during a retry
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function analyzeApplicationBio(rawBiography, retries = 2) {
    try {
        const prompt = `
        Analyze this applicant's text submission and extract their requested course or service path.
        Applicant Submission: "${rawBiography}"
        
        Rules:
        - For 'matched_track', select the exact name of the course (e.g., 'Graphic Designing'). If completely unrelated, use null.
        - For 'stream_type', select 'FREE_COMMUNITY' or 'PREMIUM_PAID'.
        `;

        // Create a timeout promise that forces an error if the network hangs for more than 5 seconds
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED')), 5000)
        );

        // Race the Gemini API request against our 5-second timeout clock
        const apiPromise = ai.models.generateContent({
            model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        matched_track: { type: 'STRING', nullable: true },
                        stream_type: { type: 'STRING', enum: ['FREE_COMMUNITY', 'PREMIUM_PAID'] },
                        confidence: { type: 'INTEGER' }
                    },
                    required: ['matched_track', 'stream_type', 'confidence']
                }
            }
        });

        const response = await Promise.race([apiPromise, timeoutPromise]);
        const result = JSON.parse(response.text.trim());
        return result;

    } catch (err) {
        // If the API times out or returns a busy 503 spike, trigger our auto-retry system
        if ((err.message.includes('TIMEOUT_EXCEEDED') || err.message.includes('503')) && retries > 0) {
            console.warn(`⚠️ AI Guard call delayed or busy. Retrying in 2 seconds... (${retries} attempts left)`);
            await delay(2000);
            return analyzeApplicationBio(rawBiography, retries - 1);
        }
        
        console.error("❌ AI Schema Guard Falling Back to Default:", err.message);
        // Clean fallback defaults so the server NEVER freezes when the network drops
        // IMPORTANT: return null (NOT a real track). A hard-coded track here silently labelled every
        // failed AI call as 'Graphic Designing' and polluted the track-popularity analytics.
        // server.js falls back to the course the student picked in the dropdown.
        return { matched_track: null, stream_type: 'FREE_COMMUNITY', confidence: 0 };
    }
}

module.exports = { analyzeApplicationBio };
