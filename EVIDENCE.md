# BUILDLOG.md: AI-usage log

**Draft written from the real build history. Please read it once and correct anything that does not match what you personally did. Honesty is graded, perfection is not.**

## Tools used

- **Claude (Anthropic):** pair-programming assistant for most of the code, tests, charts and documentation in this repository.
- **Google AI mode and ChatGPT:** produced an earlier README draft in a tutorial style (replaced by this one).
- **Google Gemini API:** used *inside* the product (the AI guard), not to write the code.
- VS Code, Git and GitHub, Docker Desktop, Node.js, PostgreSQL.

## What I decided myself

- The product itself: which forms and streams a real community programme needs, the official course list, the cultural-consent and privacy boundaries, the non-goals.
- The business rules: *In Person = 5 hours per batch, Online = 2 hours per batch*; which team numbers to show; which numbers count as "real" statistics.
- The master dataset (2019 to 2026) and its half-year and delivery-mode structure, and what to show in the Our Impact filters.
- What goes on the website and what is claimed in the documentation.

## Where AI helped

| Area | What the AI did | What I checked or changed |
|---|---|---|
| Intake gateway | Wrote the validation, honeypot, E.164 phone rule, CORS handling and the browser gateway | Tested every form on the real website and with bad input |
| Database | Wrote `schema.js` migrations and CHECK rules | Ran init and seed scripts against my own database |
| Hour rule | Implemented the per-batch hour logic and the database constraint | Declared the delivery mode of my own CSV batches |
| Impact filters and charts | Built the year / half-year logic, the pie percentages and the data block | Compared the numbers with my Excel sheet |
| Constellation widget | Built the canvas animation, layout maths and live-data merge | Looked at it on my own screen and asked for changes |
| Tests | Wrote the API test suite (16 tests) | Ran them and read the failures |
| Documentation | Drafted the README, evidence template and capstone mapping | Removed claims that were not built (scheduler, cost log, SDG graph) |

## Where the AI was wrong, and what we changed

1. **Hidden analytics bug:** the first AI guard returned a hard-coded course ("Graphic Designing") when the Gemini call failed, so every failure polluted the track statistics. Found in a code review and changed to return `null` and use the course the student picked.
2. **Seeding duplicated learners:** the first CSV import used a different duplicate key and read the wrong topic column, so re-running it could double the learners (41 became 82). Replaced with a proper CSV parser and a stable key.
3. **Lost "type admin" shortcut:** replacing the old browser gateway silently removed a shortcut I relied on. The AI had not seen the old file. It was rebuilt, and the token check was kept on purpose.
4. **Overstated documentation:** my first manifest claimed a durable scheduler, AI cost logging, a `/admin` route and an SDG graph. None of these existed. They were removed from the documentation and listed under Limitations and Roadmap.
5. **Edit slip:** one AI edit deleted two helper definitions in `server.js`; the server crashed with a `ReferenceError` on start-up and the fix was applied after running it.
6. **Test runner slip:** the first test command pointed at a folder, which Node treated as one failing test; fixed by naming the test file.
7. **Unreadable chart:** the first bar chart put 41 learners next to 3 team members and 2,441 learners next to 3, making bars invisible. Redesigned to learners and hours by stream on two axes.
8. **Environment gap:** the AI could not run my Docker setup or view the pixels of my website, so I verified those parts myself.

## What I verified myself

- All forms on the live site, the admin dashboard and the email alert.
- The numbers on the Our Impact section against my Excel history.
- `docker compose` start-up on my machine.

### Automated Test Suite Proof (16/16 Passing)
> flyrank-backend-ai-engineering-capstone@1.0.0 test
> node --test tests/api.test.js

◇ injected env (13) from .env
✔ server is up (217.2141ms)
✔ public impact summary exposes only counted numbers, never personal data (625.766ms)
✔ public filters: bad year or half-year gives aclean 400, never a 500 (38.2658ms)
✔ half-year filter answers for that period (228.2896ms)
✔ admin endpoints refuse a missing or a wrong token (59.2975ms)
✔ admin metrics work with the right token (1041.0216ms)
✔ validation: bad phone number -> 400 naming the field (160.9823ms)
✔ validation: bad email -> 400 (12.9734ms)
✔ delivery mode is required: no fallback default for hours (16.6379ms)
✔ malformed JSON -> 400, never 500 (21.3238ms)
✔ oversized body -> clean 4xx, never 500 (24.8664ms)
✔ honeypot: a bot gets a fake success (19.7262ms)
✔ idempotency: the same registration sent twice creates exactly one record (19.457ms)
✔ In Person saves 5 batch hours, Online saves 2 (never mixed) (11.803ms)
✔ test registrations are never counted in the statistics (20.1224ms)
✔ the database itself refuses a mismatched delivery mode and hours (459.9959ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1456.709

---

## Honest note

AI wrote a large share of the code. I can explain every file in this repository: what it does, why it exists, and how it connects to the others.
