# Installation and setup

## Requirements

| | Version | Notes |
|---|---|---|
| Node.js | 20 or newer | Runs the API and builds the client |
| PostgreSQL | 14 or newer | 16 recommended |
| JDK | 21 | Only for building the APK |
| Android SDK | Platform 35 | Only for building the APK |

The database needs the `pgcrypto` and `btree_gist` extensions. Both ship with a
standard PostgreSQL install and the migrations enable them, but the connecting
role must be allowed to create extensions — or an administrator can enable them
once beforehand:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

`btree_gist` is not optional. The constraints that stop a tenant being in two
rooms on one day, or two tenants sharing a bed, are enforced by the database
rather than by application code alone.

---

## Development

```bash
npm install

createdb pg_management
cp server/.env.example server/.env
```

Edit `server/.env`:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/pg_management
JWT_SECRET=$(openssl rand -base64 48)
```

Then:

```bash
npm run migrate            # applies the five migrations
npm run seed               # branches, prices, rates, templates, jobs
# or
npm run seed -- --demo     # the above plus sample tenants and readings

npm run dev:server         # http://localhost:4000
npm run dev:web            # http://localhost:3100
```

The seed prints the account it creates. Override the password with
`SEED_ADMIN_PASSWORD`, and change it after first sign-in either way.

---

## What the seed creates

**Ekkatuthangal** — two floors, nine rooms, each floor on its own meter:

| Floor | Rooms | Beds |
|---|---|---|
| Ground | GF-6S-01 (6), GF-5S-01 (5), GF-3S-01 (3), GF-3S-02 (3), GF-1S-01 (1) | 18 |
| First | F1-5S-01 (5), F1-4S-01 (4), F1-3S-01 (3), F1-1S-01 (1) | 13 |
| **Total** | **9 rooms** | **31 beds** |

> The specification's summary line says 30 beds, but its own room list — one
> 6-sharing, two 5-sharing, one 4-sharing, three 3-sharing and two 1-sharing —
> adds up to 31. The per-room figures are given twice and agree, so they were
> taken as authoritative. If a room really is one bed smaller, correct its
> capacity in the app; nothing in the code depends on the number.

**Alandur** — three floors plus a terrace, with no rooms assumed. Add rooms and
their sharing sizes through the app once the layout is confirmed; no code change
is needed.

Also seeded: opening rent per sharing size, an EB rate of ₹12.50 per unit, a
₹150 common charge, four message templates, the reminder ladder (3rd, 5th, 7th)
and seven automation jobs.

The seed is idempotent — running it again after adding a branch will not disturb
live data.

---

## Production

### 1. Database

Use a managed PostgreSQL instance with automated backups. Set
`DATABASE_SSL=true` for any provider that requires TLS.

```bash
npm run migrate --workspace server
npm run seed --workspace server     # first deployment only, without --demo
```

Migrations are tracked in `schema_migrations` with a checksum: an applied
migration that is later edited fails the run rather than silently diverging.
Each one applies in its own transaction, so a failure leaves the database on the
last good migration.

### 2. API

```bash
npm run build --workspace server
NODE_ENV=production npm start --workspace server
```

Run it behind a TLS-terminating reverse proxy. The release APK refuses plain
HTTP, so a valid certificate is required — not optional.

Set at minimum:

```bash
NODE_ENV=production
DATABASE_URL=…
DATABASE_SSL=true
JWT_SECRET=…                       # 32+ random characters
STORAGE_DIR=/var/lib/pg-management/storage
CORS_ORIGINS=https://localhost     # the origin the packaged app sends from
```

Every variable is documented in `server/.env.example`.

**Back up `STORAGE_DIR`.** It holds payment proofs and identity documents, and
it is not in the database. Keep it off any publicly served path — files are only
ever released through an authorised, audited endpoint.

Health checks:

- `GET /api/live` — the process is up.
- `GET /api/health` — the process is up *and* the database is reachable.

### 3. Automation

`AUTOMATION_ENABLED=true` runs the scheduler inside the API process, which suits
a single instance. If you run more than one, set it to `false` on all of them
and drive the jobs externally so they do not fire in parallel:

```bash
curl -X POST https://api.example.com/api/automation/jobs/generate_monthly_bills/run \
  -H "authorization: Bearer $TOKEN"
```

Every run is recorded in `automation_runs`, whether it was scheduled or manual.

### 4. Client and APK

Set `NEXT_PUBLIC_API_BASE_URL` to the public API address, then follow
[ANDROID_BUILD.md](ANDROID_BUILD.md).

---

## First run

1. Sign in as the seeded admin and change the password.
2. Create real accounts under **Settings → Users**, and assign managers and
   staff to their branches. Role permissions are enforced by the API.
3. Check **Pricing** — set the rent for each sharing size and confirm the EB
   rate and common charge. A tenant cannot be admitted to a room whose sharing
   size has no price.
4. Configure the payment QR under **Payments** so bill messages carry it.
5. Add Alandur's rooms as its layout is confirmed.
6. Enter this month's meter readings, then generate bills.

---

## The monthly cycle

```
Enter meter readings
        ↓
Generate bills           rent prorated per stay segment, electricity by occupancy days
        ↓
Review the breakdown     every figure shown, checkable by hand
        ↓
Send payment requests    bill plus payment QR
        ↓
Tenant pays and sends a screenshot
        ↓
Payment recorded as PENDING — no balance changes
        ↓
Admin approves, in full or in part
        ↓
Ledger and bill status update
        ↓
Close the month          figures become final
```

Reminders go out on the 3rd, 5th and 7th to anyone still owing, and stop on
their own once a bill is settled.

Closing a month freezes it: later price changes and tenant movements cannot
alter its figures, and only an admin can reopen it — which requires a reason and
is written to the audit log.

---

## Backups

Two things must be backed up together:

1. The PostgreSQL database — `pg_dump` on a schedule.
2. `STORAGE_DIR` — payment proofs and identity documents.

A database restored without its storage directory will show documents that
cannot be opened.

---

## Troubleshooting

**`btree_gist` or `pgcrypto` does not exist.**
The connecting role cannot create extensions. Have an administrator enable both,
then re-run the migration.

**"No rent is configured for N sharing."**
Admission needs a price in force on the joining date. Set one under **Pricing**.

**Bills cannot be generated.**
Metered rooms need a reading for the month. The billing screen names the meters
that are missing, and a month cannot be closed until they are entered.

**"That billing month is closed."**
Working as intended. An admin can reopen it with a reason, which is audited.

**The app cannot reach the API.**
On an emulator, `localhost` means the emulator — use `10.0.2.2`. On a physical
device, use the LAN address and make sure the API listens on `0.0.0.0`. Release
builds require HTTPS.
