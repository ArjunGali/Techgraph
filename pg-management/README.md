# PG Management

Operations software for a multi-branch paying-guest business: rooms, tenants,
electricity, billing and payments — delivered as **one Android APK that adapts
itself to phones and tablets**.

```
Responsive client (Next.js)
        ↓ HTTPS
Secure API (Express + TypeScript)
        ↓
PostgreSQL
```

The APK never talks to PostgreSQL. It holds an API address and nothing else; it
signs in as a user, and what that user may see or do is decided on the server.

---

## The idea

Routine work should run itself. The owner should see **exceptions**: payments
waiting for approval, bills overdue, a meter not read, a room over capacity, a
tenant with no documents on file. Everything else — generating bills, sending
payment requests, chasing reminders, counting vacancies — happens without being
asked.

Three rules the whole system is built around:

1. **History is never lost.** A tenant who moves rooms gets a new stay record;
   the old one is closed, not overwritten. A price change opens a new
   effective-dated rule; the old price stays on file. A payment correction is a
   reversal entry, not a deletion. Any bill from any past month can be
   recomputed and will produce exactly the figures it was issued with.
2. **Money moves only on a decision.** A payment — screenshot and all — sits
   pending and changes no balance until an admin approves it.
3. **The calculation engine is locked.** Admins set the rates. Nobody edits the
   arithmetic.

---

## The electricity calculation

The PG's own formula, implemented step for step in
[`server/src/calc/eb.ts`](server/src/calc/eb.ts):

```
1. Total EB amount      = total units × EB rate          (default ₹12.50/unit)
2. Occupancy days       = each tenant's real days, from stay history
3. Total occupancy days = the sum of every tenant's days
4. EB per occupancy day = total EB amount ÷ total occupancy days
5. Individual tenant EB = EB per occupancy day × that tenant's days
6. Final amount         = individual EB + common charge   (default ₹150)
```

Worked through, for 100 units at ₹12.50 with three tenants of 31, 31 and 15
days in a 31-day month:

```
Units consumed: 200 - 100 = 100
Total EB amount: 100 × ₹12.50 = ₹1,250.00

Occupancy days:
  Tenant A: 31 days
  Tenant B: 31 days
  Tenant C: 15 days
Total occupancy days: 77

EB per occupancy day: ₹1,250.00 / 77 = ₹16.23

  Tenant A: 31 days → ₹503.25 + ₹150.00 = ₹653.25
  Tenant B: 31 days → ₹503.25 + ₹150.00 = ₹653.25
  Tenant C: 15 days → ₹243.50 + ₹150.00 = ₹393.50

Electricity apportioned: ₹1,250.00 (matches the meter exactly)
```

Step 2 is deliberately general. The traditional shortcut — *days stayed by the
person who left, plus the remaining members × days in the month* — is just the
one-departure case of summing each tenant's actual days. The general form gives
the same answer there and stays correct with several people joining or leaving,
tenants moving between rooms, several moves in one month, and months of 28, 29,
30 or 31 days.

**Nothing is lost or invented in the split.** Rounding each share on its own
would leak a paise here and there; shares are allocated by the largest-remainder
method, so the parts always add back to the meter total exactly. Every amount in
the system is stored as an integer number of paise.

---

## What it manages

| | |
|---|---|
| **Property** | Branches, floors, rooms of any sharing size, beds. Nothing hardcoded — an admin adds a floor or changes a capacity in the app. |
| **Tenants** | Admission, search by name/phone/ID, full stay history, room movement, vacating, documents. |
| **Vacancies** | Free now and coming free, derived from stay records. Never maintained by hand. |
| **Pricing** | Effective-dated rent per sharing size, branch or room; administered EB rate and common charge. |
| **Electricity** | Meters per floor, monthly readings, regression refused, spikes flagged. |
| **Billing** | Monthly generation, prorated rent per stay segment, full breakdown, draft → calculated → reviewed → closed. |
| **Payments** | Ledger, proofs, mandatory admin approval, partial approval, reversals, QR configuration. |
| **Messaging** | WhatsApp behind a provider adapter, bill sends, a reminder ladder that stops when a bill is paid. |
| **Operations** | Maintenance, expenses, reports, automation jobs with recorded runs, audit log. |
| **Access** | Admin / manager / staff, with per-user grants and revocations, enforced server-side. |

---

## Getting started

Requires **Node.js 20+** and **PostgreSQL 14+**.

```bash
git clone <repository>
cd pg-management
npm install

createdb pg_management
cp server/.env.example server/.env      # set DATABASE_URL and JWT_SECRET
cp web/.env.example web/.env.local

npm run migrate
npm run seed -- --demo                  # omit --demo for a clean database

npm run dev:server                      # API on :4000
npm run dev:web                         # client on :3100
```

The seed prints the credentials it creates. **Change the password immediately.**

`--demo` adds sample tenants including one who moves rooms mid-month and one who
leaves on the 15th, plus meter readings — enough to generate a month of bills
and see the apportionment working.

Full instructions, including production deployment: [docs/INSTALLATION.md](docs/INSTALLATION.md).

---

## Building the Android APK

Locally, with the Android SDK installed:

```bash
npm run android:debug     # debug APK, for testing
npm run android:release   # signed release APK, for distribution
```

Without the SDK, let CI do it: **Actions → Build PG Management APK → Run
workflow**, then download the `pg-management-apk` artifact from the finished
run.

Keystore creation, signing, verification and troubleshooting:
[docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md).

---

## One APK, both form factors

There is no phone build and no tablet build, and no setting for the user to
choose. The client reads the width it has been given and lays itself out
accordingly:

| Width | Navigation | Layout |
|---|---|---|
| < 768px | Bottom tab bar | One column, full-width forms, bottom sheets, compact cards |
| ≥ 768px | Persistent sidebar | Multi-column grids, two-pane master-detail, full tables |

Components that can appear in more than one place measure **their own**
container rather than the window, so a table in a tablet's master pane renders
as cards while the same table with the page to itself renders as a table.

Rotating a device or dropping the app into a split-screen window re-lays out the
running UI: the activity is `resizeableActivity` and handles its own
configuration changes.

Verified with headless Chromium at 320, 390, 430, 768 and 1280px — correct
navigation model at every width, no horizontal page scrolling anywhere, and no
tap target under 40px.

Light, dark and system themes are supported throughout, applied before the first
paint so a dark-mode device never flashes white on launch.

---

## Tests

```bash
# Calculation engine — pure, needs no database
npm test

# Workflows — against a real PostgreSQL database.
# Uses a throwaway database and truncates it between suites, so point it
# somewhere disposable.
createdb pg_management_test
cp server/.env.test.example server/.env.test   # then edit DATABASE_URL
DATABASE_URL=postgresql://…/pg_management_test npm run migrate --workspace server
npm run test:integration --workspace server
```

**102 tests.** 67 cover the calculation engine — the specification's worked
example step by step, mid-month joins and departures, single and repeated room
moves, every month length, leap years, timezone independence, meter regression,
and property tests asserting an apportioned split always adds back to the exact
total. 35 run against a real database and cover admission and capacity limits,
transactional rollback, the move workflow's history guarantees, billing across
real stay history, effective-dated pricing, the payment lifecycle, month
closing, the permission matrix and the audit trail.

---

## Layout

```
pg-management/
├── server/              API — the only component with database credentials
│   └── src/
│       ├── calc/        The locked calculation engine. Pure, no I/O.
│       ├── db/          Migrations, seed, connection pool
│       ├── lib/         Errors, permissions, audit, storage
│       ├── middleware/  Authentication, authorisation, error handling
│       ├── modules/     One folder per domain
│       └── tests/       Integration tests
├── web/                 Responsive client, statically exported
│   ├── app/             One folder per screen
│   ├── components/      Adaptive shell and the UI kit
│   └── lib/             API client, auth, theme, layout hooks
├── android/             Capacitor Android project
└── docs/                Installation, Android build, data model
```

---

## Single-user mode

The owner runs this on their own phone, so the app signs itself in on launch and
opens on the dashboard. There is no sign-in screen in normal use.

Authentication is not switched off by this. The server still authenticates every
request, still enforces role permissions, and still records who did what — the
app simply stops asking the owner to prove who they are on their own device. The
credentials are compiled into the APK, so **treat the APK as sensitive**, and
leave `NEXT_PUBLIC_AUTO_LOGIN_EMAIL` and `NEXT_PUBLIC_AUTO_LOGIN_PASSWORD` blank
to get the ordinary sign-in screen back.

A screen appears before the dashboard only when something needs attention: the
server cannot be reached (it asks for the address, nothing else), or the built-in
credentials were refused (it asks someone to sign in).

---

## Security

- Authentication on every endpoint; there is no unauthenticated view of anything.
- Permissions enforced in the API. Hiding a button is a convenience, never the control.
- Identity documents are reachable only through an authorised, audited endpoint,
  are never listed in search results, and are never sent over WhatsApp. Only a
  masked identifier is stored in a queryable column.
- Financial endpoints are guarded against duplicate submission by an idempotency
  key and a unique transaction reference per tenant.
- Release builds refuse plain HTTP.
- No credential is ever compiled into the APK.
