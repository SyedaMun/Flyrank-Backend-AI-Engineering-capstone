# Navigant Core - Complete Package (v8)

Every file here is the FINAL version. Copy ALL of them into your project folder, replacing the old ones.

## Files
| File | What it is |
|---|---|
| server.js | API: delivery-mode hours (In Person 5 h / Online 2 h per batch), half-year filters, admin token, test-entry filter |
| schema.js | Database structure (new: delivery_mode, batch_hours, workshop_batch + a CHECK that stops mixed mode/hours) |
| init-db.js | Creates / migrates the tables (uses schema.js) |
| seed-csv.js | Imports master_database.csv. NEW: you declare the delivery mode of each CSV batch at the top |
| phone.js | WhatsApp / phone validation (E.164) |
| ai-guard.js | Gemini course matcher (safe fallback) |
| idempotency.js | Duplicate-click shield (your original, unchanged) |
| cleanup-test-data.js | Removes test registrations (preview first) |
| navigant-gateway.js | Browser side: forms (now sends delivery mode), admin dashboard |
| index.html | The website: Constellation widget, Our Impact filters, NAVIGANT DATA block, forms |
| workshop-constellation-widget.html | The widget on its own (preview) |
| .env.example | Template for your .env |

## Deploy steps
1. Copy all files above into the project folder (replace old ones). Keep your real `.env`.
2. In `.env`: you may delete `HOURS_PER_REGISTRATION` (no longer used). Keep ADMIN_TOKEN, MANUAL_INTERNS, MANUAL_VOLUNTEER_TRAINERS.
3. Open `seed-csv.js`, find `CSV_BATCH_MODES` (top of file) and check the 4 lines: how was each October 2026 workshop delivered? Change "Online" to "In Person" where needed.
4. Run:  `node init-db.js`   (adds the new columns, keeps all data)
         `node seed-csv.js`  (re-imports the 41 learners with batch + delivery mode)
5. Restart the server (Docker: `docker compose up --build`). Browser: Ctrl+F5.
6. Check: http://localhost:5000/api/public/impact-summary  ->  "total_batches":4 and "total_coaching_hours":8 (4 online batches x 2 h).

## The hour rule (one rule everywhere)
In Person = batches x 5 hours | Online = batches x 2 hours.
- Website registrations: the form asks "How will you attend?" (required). The server saves mode + hours together; the database refuses any mismatch.
- A website registration joins the batch "course + delivery mode + calendar month", so the 2nd and 3rd learner of the same cohort do not add extra hours.
- A batch of unknown mode counts 0 hours (nothing is guessed).

## Your history data
Everything historical lives in ONE place: the "NAVIGANT DATA" script in index.html (rows: year, half, stream, topic, batches, learners, mode, volunteer trainers, interns). Add a line to add a workshop. Hours are always calculated.
`mergeLive: true` adds live database figures on top (Till Now and year filters). Set it to `false` if the live workshops are already listed in rows (otherwise 2026 is counted twice).
