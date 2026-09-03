# Data model

Everything below is in PostgreSQL. The Android app never touches it — the API is
the only component with credentials.

**Money is stored as integer paise** (₹1 = 100 paise) in every column. A bill
total is therefore exact; floating-point rupees would drift after a few thousand
bills.

**Dates are `DATE`, not timestamps.** Billing is calendar-driven: a stay from 1
to 15 August is fifteen days regardless of clock time or server timezone. The
connection parses `DATE` as a plain `YYYY-MM-DD` string so no timezone can shift
it by a day.

---

## Property

```
branches ──< floors ──< rooms ──< beds
                 │        │
                 └──< eb_meters <┘   (rooms point at the meter that bills them)
```

Nothing about the shape is fixed in code. `rooms.sharing_capacity` is a plain
integer, so 1-, 2-, 6- or any future N-sharing room works without a change.
Records are deactivated or archived rather than deleted, so historical stays and
bills keep resolving to a real room.

---

## Stay history

`tenant_stays` is the record everything else is derived from — occupancy,
vacancy, rent proration and the electricity split all read it.

One row per continuous occupancy of one room by one tenant. **A move never edits
a row**: the old stay is closed with an `end_date` and a new row is inserted.
`end_date` is inclusive, and `NULL` means still resident.

`sharing_capacity` and `monthly_rent_paise` are snapshotted onto each row, so a
bill stays reproducible even if the room is later reconfigured or repriced.

Two exclusion constraints enforce this in the database, not merely in code:

```sql
-- A tenant cannot be in two places on the same day
EXCLUDE USING gist (tenant_id WITH =, daterange(start_date, end_date, '[]') WITH &&)

-- A bed cannot hold two tenants on the same day
EXCLUDE USING gist (bed_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
```

A move on 16 August closes the previous stay on the 15th, so the two periods meet
exactly: no day is counted twice and none is lost.

---

## Pricing

`price_rules` and `charge_rates` are effective-dated and never updated in place.
Setting a new price closes the current rule the day before the new one starts.

A price rule may target, most specific first:

1. one room
2. one sharing size in one branch
3. one sharing size anywhere
4. a branch default

An exclusion constraint stops two rules for the same scope being in force on the
same day, so "the price on 5 August" always has exactly one answer.

`charge_rates` holds the administered EB rate and common charge. These are
*inputs* to the calculation engine; the arithmetic that consumes them is not
editable from the application.

---

## Electricity

`eb_readings` carries one reading per meter per month. `units_consumed` is a
generated column, so it can never disagree with the two readings behind it. A
reading below its predecessor is refused; one far above the meter's recent norm
is accepted but flagged for the owner's attention list.

---

## Billing

```
billing_periods ──< bills ──< bill_items
                      │
                      └──< bill_calculations   (the full working, as JSON)

billing_periods ──< eb_calculations            (per meter, the whole split)
```

`bill_calculations.breakdown` stores the complete working — every stay segment,
every occupancy day, the per-day figure and the line-by-line explanation — so
the numbers shown to the owner and messaged to a tenant can be reproduced
verbatim years later. Both tables record the `engine_version` that produced
them.

A period moves `draft → calculated → reviewed → closed`. Closing freezes it;
reopening is admin-only, needs a reason, and is audited.

---

## Payments

```
payments ──< payment_proofs
    │
    └──< payment_approvals
```

`direction` is `+1` for anything that reduces what a tenant owes and `-1` for
anything that increases it. A balance is a **sum over this table**, never a
mutable counter.

A payment enters as `pending_approval` and affects nothing. Only approval writes
`approved_amount_paise`, which is what the ledger counts — so a partial approval
banks exactly what the admin saw arrive.

**Corrections never delete.** Reversing an approved payment leaves the original
row in place and posts a contra entry with the opposite direction; the ledger
sums `approved` and `reversed` entries together, so the pair nets to zero
exactly once.

Two guards against double-banking: a unique `idempotency_key`, and a unique
transaction reference per tenant across everything not rejected.

---

## Documents

`tenant_documents` stores only a **masked** identifier (`XXXX XXXX 9012`) in a
queryable column. The file itself lives under `STORAGE_DIR` with a generated
name, is never served statically, and is released only through a
permission-checked endpoint that writes an audit row *before* sending a byte.

---

## Operations and audit

`whatsapp_messages` records every send with the provider that handled it, so
moving from the local stub to a live provider leaves history intact and
attributable. `automation_jobs` and `automation_runs` record every run, its
result and any error.

`audit_logs` is written **inside the same transaction** as the change it
describes, so a committed change always has its log row and a rolled-back one
leaves none behind. Before and after values are stored as JSON.

---

## Migrations

| File | Contents |
|---|---|
| `001_core_identity_and_property.sql` | Users, roles, permissions, branches, floors, meters, rooms, beds |
| `002_tenants_and_stay_history.sql` | Tenants, stay history with its exclusion constraints, documents |
| `003_pricing_and_electricity.sql` | Effective-dated prices, administered rates, meter readings |
| `004_billing_and_payments.sql` | Periods, bills, items, breakdowns, ledger, proofs, approvals, QR |
| `005_operations_and_audit.sql` | Messaging, reminders, automation, maintenance, expenses, audit, settings |

Each runs in its own transaction and is recorded with a checksum; editing an
applied migration fails the next run rather than diverging silently.
