# Navigant Core: The Decentralized Multi-Stream Operations Engine

> A self-hosted backend that runs the real website of **Navigant Education Consultants**, a remote-first social enterprise offering free community workshops for women and underserved communities.
> It receives every form, validates and protects it, stores it in PostgreSQL, alerts the team by email, and turns the data into live impact numbers, charts and a private admin dashboard.

**Author:** Syeda Munazza Bukhari · **Programme:** FlyRank Internship, Backend AI Engineering Track (graduation capstone) · **License:** MIT

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [What it does](#2-what-it-does)
3. [Architecture](#3-architecture)
4. [Tools and technologies](#4-tools-and-technologies)
5. [Quick start (run and seed)](#5-quick-start-run-and-seed)
6. [Configuration](#6-configuration)
7. [API reference](#7-api-reference)
8. [Database](#8-database)
9. [The hour rule and the impact numbers](#9-the-hour-rule-and-the-impact-numbers)
10. [Security and safety](#10-security-and-safety)
11. [How this project maps to the five FlyRank capstones](#11-how-this-project-maps-to-the-five-flyrank-capstones)
12. [Testing and evidence](#12-testing-and-evidence)
13. [Five-minute demo path](#13-five-minute-demo-path)
14. [What I learned](#14-what-i-learned)
15. [Limitations (honest)](#15-limitations-honest)
16. [Roadmap](#16-roadmap)
17. [Project structure](#17-project-structure)
18. [Privacy of the data in this repository](#18-privacy-of-the-data-in-this-repository)

---

## 1. Why this exists

Before this system, one person copied every registration into Excel by hand, checked duplicates by eye, and rebuilt the impact report for every proposal. It was slow, error-prone, and the numbers were never current.

**The 10x claim** (my own measurements and estimates from running the programme):

| Before | After |
|---|---|
| About 4 hours of manual data entry per cohort | 0 seconds: every form saves itself |
| About 12% of entries were duplicates | 0%: duplicates are stopped at the door |
| Impact report rebuilt by hand in Excel | Live counters, charts and filters on the website |
| Paid form tools and cloud services | $0: runs in my own Docker containers |

**Non-goals** (deliberately not built): payments or donations, live video or scheduling tools, and automatic WhatsApp messaging (the team contacts learners manually).

## 2. What it does

- **Four forms, four isolated database streams:** student registration, volunteer / community partner, trainer & intern application, and contact (which also carries the One-to-One Coaching (Paid) inquiries).
- **Safe intake:** server-side validation with clear 4xx answers, one international phone format (E.164) in browser, server and database, a honeypot field for bots, and an anti-duplicate shield.
- **AI guard (Google Gemini):** matches free-text course requests to the official course list. Anything it cannot match is saved as `Halted: Pending Review` instead of polluting the data.
- **Email alerts** to the team through Nodemailer (Gmail SMTP). A failing email never blocks the visitor.
- **Delivery-mode hour rule:** coaching hours are calculated, never typed in (In Person = batches x 5, Online = batches x 2), and enforced by the database.
- **Our Impact section:** live counters, a *Till Now* button, a Year filter (2019 to 2026), a half-year filter (Jan - Jun, Jul - Dec), a pie chart with percentages and a bar chart.
- **Workshop Constellation Hub:** an interactive node map of the 17 workshop topics in three colour themes (Tech & Digital Tools, Career Readiness & Growth, Academic Elevation) with a canvas particle background.
- **Private admin dashboard:** token-protected metrics, charts and the latest records of each stream.
- **Test-entry filter:** registrations whose name or email contain "test" are saved as `Test: Ignored` and never counted.

## 3. Architecture

```
Visitor's browser  (index.html + navigant-gateway.js)
   | 1. checks the form, cleans the phone number
   v
fetch() JSON  -->  Express API  (server.js, port 5000)
                      | 2. CORS allow-list + 100 KB size limit
                      | 3. validation        -> bad input = clear 400, never a 500
                      | 4. honeypot          -> bots get a fake success, nothing is saved
                      | 5. idempotency shield -> double clicks = 409
                      | 6. AI guard (Gemini)  only when the course is unclear
                      | 7. INSERT into PostgreSQL (one table per stream)
                      | 8. refresh impact_ledger
                      | 9. Nodemailer alert (never blocks the answer)
                      v
              JSON answer to the visitor

Public read side :  GET /api/public/impact-summary   (counts only, never personal data)
Admin read side  :  GET /api/admin/metrics, /api/admin/records/:stream   (X-Admin-Token)
```

Layers: HTTP routes and validation (`server.js`), data definition (`schema.js`), phone rule (`phone.js`), AI adapter (`ai-guard.js`), duplicate shield (`idempotency.js`), and the browser gateway (`navigant-gateway.js`).

## 4. Tools and technologies

| Area | Tool |
|---|---|
| Runtime / API | Node.js (18 or newer), Express, cors |
| Database | PostgreSQL (Docker Compose), `pg` driver |
| AI | Google Gemini API (`@google/genai`, free tier) |
| Email | Nodemailer with Gmail SMTP (app password) |
| Frontend | HTML5, CSS3, vanilla JavaScript (ES6+), Canvas API, Chart.js 4.4.7 (public CDN) |
| Hosting of the public site | Netlify (static) plus my own Docker server for the API |
| Config | dotenv (`.env`, never committed) |
| Tests | Node's built-in test runner (`node:test`) |
| Development | VS Code, Git and GitHub, Docker Desktop, AI assistants (see `BUILDLOG.md`) |

The whole stack is free: no paid form processor, no credit card.

## 5. Quick start (run and seed)

**Needs:** Node.js 18+, Docker Desktop, Git.

```bash
git clone https://github.com/<your-username>/flyrank-capstone-navigant-core.git
cd flyrank-capstone-navigant-core

cp .env.example .env          # Windows: copy .env.example .env
# open .env and set DB_PASSWORD and ADMIN_TOKEN (at least 8 characters).
# GEMINI_API_KEY and the SMTP values are optional (see below).

npm install
npm run db:up                 # starts PostgreSQL in Docker
npm run init                  # creates / upgrades the tables
npm run seed                  # loads 12 synthetic demo learners
npm start                     # http://localhost:5000
```

Open **http://localhost:5000**. Open the admin dashboard by typing the word `admin` on the page, using the footer **Staff Login** link, adding `#admin` to the address, or pressing Ctrl+Shift+A, then enter your `ADMIN_TOKEN`.

- **No Gemini key?** The AI guard is skipped and the course chosen in the dropdown is used.
- **No SMTP values?** The server logs a warning and carries on; alerts are simply not sent.
- **Seed data:** `npm run seed` imports `seed/demo_learners.csv` (synthetic). If a private `master_database.csv` exists next to `server.js` it is used instead.
- **Reset everything:** `node init-db.js --reset` (deletes all data).

## 6. Configuration

All settings live in `.env` (copy `.env.example`). Never commit `.env`.

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 5000) |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_NAME`, `DB_PORT` | PostgreSQL connection |
| `ADMIN_TOKEN` | Secret for every admin route (minimum 8 characters, 12+ recommended) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional AI guard |
| `SMTP_GMAIL_USER`, `SMTP_GMAIL_APP_PASS`, `NOTIFICATION_EMAIL` | Optional email alerts (Gmail app password) |
| `DEFAULT_COUNTRY_CODE` | Used for local numbers such as `0300 1234567` (default 92) |
| `MANUAL_INTERNS`, `MANUAL_VOLUNTEER_TRAINERS` | Team counters shown on the public site (default 1 and 3) |
| `ALLOWED_ORIGINS` | Comma-separated sites allowed to call the API from a browser (empty = any) |

**Hosting the page on Netlify:** a visitor's browser cannot reach `localhost`. Put your public API address in the `navigant-api-base` meta tag of `index.html` and add the Netlify address to `ALLOWED_ORIGINS`. A free Cloudflare Tunnel pointing at the Docker server keeps everything self-hosted.

## 7. API reference

| Method and path | Access | Purpose |
|---|---|---|
| `GET /api/health` | public | Server status and version |
| `POST /api/submissions` | public | Student registration (needs `delivery_mode`: `In Person` or `Online`) |
| `POST /api/volunteers` | public | Volunteer / partner application |
| `POST /api/trainers` | public | Trainer & intern application |
| `POST /api/inquiries` | public | Contact and paid-coaching inquiries |
| `GET /api/public/impact-summary` | public | Counted numbers only. Optional `?year=2026` and `&half=1` (Jan - Jun) or `&half=2` (Jul - Dec) |
| `GET /api/admin/metrics` | `X-Admin-Token` | Totals, monthly trends, track popularity, cohort density, demographics, team |
| `GET /api/admin/records/:stream` | `X-Admin-Token` | Latest records: `students`, `volunteers`, `trainers`, `inquiries` |

Status codes used: 200, 400 (validation, with a `field` name), 401 (bad token), 404, 409 (duplicate), 413 (too large), 429 (too many attempts), 503 (admin token not configured). Unexpected failures answer with a clean JSON 500, never a stack trace.

## 8. Database

PostgreSQL with a persistent volume. `schema.js` is the single definition used by `init-db.js` and by the server at start-up. It is idempotent: running it again keeps all data.

| Table | Holds |
|---|---|
| `applicants` | Student registrations, status, stream, demographics, workshop batch, delivery mode, batch hours, unique duplicate fingerprint |
| `volunteers` | Volunteer / partner applications |
| `trainers` | Trainer & intern applications |
| `inquiries` | Contact and paid-coaching inquiries |
| `impact_ledger` | Pre-counted public totals (so the public page never reads personal rows) |

Rules enforced **by the database itself**: valid international phone format; `delivery_mode` and `batch_hours` can only be a matching pair (In Person = 5, Online = 2, unknown = 0); `idempotency_hash` is unique; indexes on dates and tracks.

## 9. The hour rule and the impact numbers

One rule everywhere: **In Person = total batches x 5 hours. Online = total batches x 2 hours.**

- A registration saves its delivery mode, its batch label and its hours together. There is no fallback default: a registration without a valid mode is rejected, and a batch of unknown mode counts 0 hours.
- A website registration joins the batch "course + delivery mode + calendar month", so several learners of the same cohort add one batch and its hours once.
- Historical numbers (2019 to 2026, 54 batches, 614 learners, 183 hours) live in one block, `NAVIGANT_HISTORY` inside `index.html`. Hours there are calculated with the same rule. **Till Now** adds the live database on top. Set `mergeLive: false` in that block if the live workshops are already listed in it, otherwise they would be counted twice.
- Team numbers: a past period shows the highest number of volunteer trainers and interns active in it; *Till Now* shows today's team.

## 10. Security and safety

| Risk | Protection |
|---|---|
| Wrong or missing input | Server-side validation, clear 4xx, never a 500 |
| Bad phone numbers | One E.164 rule in `phone.js`, mirrored in the browser and in a database CHECK |
| Double clicks and retries | SHA-256 fingerprint shield (10 s) plus a unique daily hash in the database (409) |
| Bots | Hidden honeypot field |
| Oversized or broken requests | 100 KB limit, clean JSON error |
| Other sites calling the API | CORS allow-list and handled preflight |
| Strangers reading admin data | `X-Admin-Token`, constant-time comparison, fails closed when no token is set |
| Password guessing | 10 failed attempts per 15 minutes per IP, then 429 |
| Leaking source or data files | Static-file blocklist (`.js`, `.csv`, `.env`, Docker files and more) |
| SQL injection | Parameterised queries; filter values are validated numbers |
| Personal data on the public page | The public endpoint returns counts only |
| Test data in real statistics | `Test: Ignored` status; `cleanup-test-data.js` previews and removes test rows |
| Mixed-up hours | Database CHECK forces mode and hours to match |
| Email trouble blocking users | The alert runs on its own; failure is only logged |

Secrets live only in `.env`. Nothing secret is logged.

## 11. How this project maps to the five FlyRank capstones

Navigant Core merges the engineering lessons of five FlyRank briefs into one real website. The table says honestly what each part covers.

| # | Capstone theme | Closest FlyRank brief | Built | Partly or not built |
|---|---|---|---|---|
| 1 | Master Solution Core (containerised, self-hosted) | Your 10x Solution | API, database, caching, containerised stack | Authentication is one shared token; no background job; email alerts but no scheduled report |
| 2 | AI extraction and schema guard | AI Image Understanding and Content Matching Engine (applied to text) | Structured output, never-trust validation, safe rejection, retries and fallback | No per-call cost log; confidence not used as a threshold; no images or embeddings |
| 3 | Production entry gateway and widget | Embeddable Widget and Lead-Capture Platform | CORS and preflight, validation, honeypot, failure-proof email, owner dashboard | Partial rate limiting; no geo lookup; no customer-installable script |
| 4 | Anti-duplicate shield | Social Media Studio / Social Campaign Publisher | Idempotent intake in two layers | Review statuses without approve/reject buttons; no durable scheduler; no publishing adapters |
| 5 | Social impact ledger | Usage Metering and Billing Engine | Exactly-once counting, exact integer hours, rollups per period, ledger | No quotas; no Stripe |

### Concepts of the "Your 10x Solution" brief

| Concept | Status | Where |
|---|---|---|
| 1. API endpoints | Built | `server.js` routes |
| 2. Database | Built | `schema.js`, PostgreSQL volume |
| 3. Authentication | Partly | `requireAdmin` in `server.js` (shared admin token, not user accounts) |
| 4. Background jobs | Not yet | Planned (see Roadmap) |
| 5. Reporting by email | Partly | `dispatchEmailAlert` (per-submission alerts, no scheduled report) |
| 6. Caching | Built | `impact_ledger`, `Cache-Control`, 30 s refresh throttle |
| 7. LLM integration | Partly | `ai-guard.js` (schema, timeout, retries, fallback; cost log planned) |
| Swap: containerised stack | Built | `docker-compose.yml` (one swap, because background jobs did not fit yet) |

## 12. Testing and evidence

```bash
npm test
```

The suite (`tests/api.test.js`, 16 tests, no extra packages) checks: server health; the public endpoint exposes counts only; bad filters give a clean 400; admin routes refuse a missing or wrong token; bad phone, bad email and missing delivery mode give a 400 with the field name; malformed and oversized bodies never cause a 500; the honeypot; **a double submission creates exactly one record**; In Person saves 5 hours and Online 2; test registrations are not counted; and the database refuses a mismatched mode and hours.

Set `ADMIN_TOKEN` and the `DB_*` variables in `.env` to also run the admin and database tests. Proofs for the evaluator are in **EVIDENCE.md**; the AI-usage log is **BUILDLOG.md**; the machine-readable manifest is **capstone.yaml**.

## 13. Five-minute demo path

1. Open the site and click the three stream buttons in the hero (teal, green, violet); click a bubble.
2. In **Our Impact** press *Till Now*, then choose **2023** (77 learners, 20 hours, team 3 + 3) and **2026** with **Jul - Dec**.
3. Submit a form with a wrong phone number and read the clear message.
4. Submit the student form as "Test Demo" with In Person; press Submit repeatedly: one record, the other clicks are refused.
5. Type `admin`, enter the token, and explore the dashboard.

## 14. What I learned

- Treat every input, and every AI answer, as untrusted until it is validated.
- Idempotency needs two layers: a fast shield at the door and a database rule that survives restarts.
- Put each rule in one place (phone format, hour rule) and let the database enforce it again.
- Counting is a design problem: decide what a "batch", a "learner" and a "test entry" are before writing queries.
- Evidence beats claims: tests and commands that anyone can run are worth more than descriptions.
- Hosting a static site and a self-hosted API means thinking about origins, CORS and public addresses.

## 15. Limitations (honest)

- No durable scheduler or background worker yet; the Jan - Jun / Jul - Dec filter is a reporting period only.
- No AI cost log, and the AI confidence number is not used as a threshold.
- Rate limiting covers admin login and the public summary, not the submission routes.
- No geo lookup, payments, quotas, or customer-installable embeddable script.
- The duplicate shield's 10-second memory resets on restart (the database rule keeps working).
- Admin access is one shared token, not individual accounts.
- Chart.js is loaded from a public CDN, so charts need internet access.
- A Netlify-hosted page needs a public API address; `localhost` works only on my own computer.
- Historical numbers come from my own records; the delivery mode of the demo batches is declared in `seed-csv.js` because the CSV has no such column.

## 16. Roadmap

**Next (closes gaps against the FlyRank rubric)**
- [ ] Scheduled monthly impact-report email (a real background job plus a report).
- [ ] Cost log for every AI call (model, tokens, estimated cost) and use of the confidence value.
- [ ] Approve / reject buttons for `Halted: Pending Review` entries.
- [ ] Per-IP rate limit on the submission routes.

**Then (driven by the real community work)**
- [ ] Attendance tracking and downloadable certificates.
- [ ] CSV export of reports for proposals and chamber submissions.
- [ ] Urdu and mobile-first improvements for learners on low-end phones.
- [ ] Individual admin accounts instead of one shared token.
- [ ] Monitoring and automatic database backups.

## 17. Project structure

```
.
├── server.js               API, validation, security, impact summary, admin routes
├── schema.js               single definition of all tables and database rules
├── init-db.js              creates / upgrades the tables (--reset wipes)
├── seed-csv.js             imports learners from CSV (demo data by default)
├── phone.js                phone number rule (E.164)
├── ai-guard.js             Gemini course matcher with timeout, retries, fallback
├── idempotency.js          anti-duplicate shield
├── cleanup-test-data.js    previews / removes test registrations
├── navigant-gateway.js     browser side: forms, admin dashboard
├── index.html              the website (widget, impact section, data block)
├── seed/demo_learners.csv  synthetic demo learners
├── tests/api.test.js       API test suite
├── docker-compose.yml      PostgreSQL container
├── capstone.yaml           manifest for the evaluator
├── EVIDENCE.md             proof for every requirement
├── BUILDLOG.md             AI-usage log
├── .env.example            every setting with safe placeholders
└── LICENSE                 MIT
```

## 18. Privacy of the data in this repository

No real learner data is published here. `seed/demo_learners.csv` is synthetic. The private `master_database.csv`, the `.env` file and the PostgreSQL data folder are listed in `.gitignore`. The numbers in the `NAVIGANT_HISTORY` block are aggregated workshop totals with no names or contact details.

---

*Built with care for the community of Navigant Education Consultants.*
