# Phase 7 — Staff & Labor

Status: **planned** · Depends on: Phases 0, 4, 6 · Milestone: **M8 — labor operational**

## Goal

Operational staff management: workspace-local staff profiles (optionally without platform
accounts), PIN-based clock in/out on shared devices, schedules, labor-cost-vs-sales math, and
tip pools. This phase also settles the sales-attribution story (orders carry a server).

## Dependencies

- Phase 4 (`orders.server_user_id` for attribution — add the column if not already needed).
- Phase 6 (captured tips feed tip pools).
- Phase 0 (permissions, settings).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `staffProfiles.ts` | `staff_profiles` | `workspace_id`, `user_id` text FK nullable (`ON DELETE SET NULL` — staff may have no login), `display_name`, `pin_hash` (hashed, never plaintext), `job_title`, `hourly_rate` int minor units, `is_active`, unique `(workspace_id, user_id)` where not null |
| `timeClockEntries.ts` | `time_clock_entries` | `staff_profile_id` FK, `clock_in_at`, `clock_out_at` nullable, `breaks` jsonb (`[{ start, end }]`), `source` enum `pin|api`, `note` |
| `scheduledShifts.ts` | `scheduled_shifts` | `workspace_id`, `staff_profile_id`, `section_id` nullable, `starts_at`/`ends_at`, `published_at` nullable, `note` |
| `tipPools.ts` | `tip_pools` | `workspace_id`, `business_date`, `period` enum `shift|day|week`, `rule` enum `hours|points|equal`, `total_amount` int, `status` enum `open|closed`, `closed_at` |
| `tipPoolShares.ts` | `tip_pool_shares` | `tip_pool_id`, `staff_profile_id`, `points` numeric nullable, `payout_amount` int, `paid_at` nullable |

## Invariants & rules

- **PIN auth is not session auth**: PIN endpoints identify *staff*, not users; they require an
  authenticated workspace context (a logged-in device account) plus the profile PIN. PIN
  never replaces `checkLevelPermissions` for management routes.
- **Clock** (scope 66): one open entry per profile; overlapping entries refused (409);
  clock-out closes with optional break segments; entries are correctable by managers only
  via adjustment rows (append pattern like the stock ledger — keep originals).
- **Labor cost** (scope 68): `Σ worked minutes × hourly_rate` (integer minor units) within a
  business day; labor % = labor cost ÷ net sales (Phase 8 consumes).
- **Attribution** (scope 69): `orders.server_user_id` set from the session user at order
  creation (never client body); used by sales-by-server reports.
- **Tip pools** (scope 70–71): pool captures tips from `payments.tip_amount` over a period;
  shares by hours worked (from time clock), declared points, or equal split; payout marks
  `paid_at`; closing a pool is immutable-history (reopening not allowed).
- **Roles & permissions** (scope 65, 72): platform roles stay in membership tables;
  `job_title` is descriptive only — authorization never reads it.

## API surface

Mounted after the tenant middlewares.

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/staff` · GET/PATCH/DELETE `/{staffId}` | delete = deactivate; `PUT /{staffId}/pin` (hashes server-side) |
| POST | `/workspace/staff/{staffId}/clock-in` · `/clock-out` | PIN in body; 409 on overlap/open entry |
| GET | `/workspace/labor/time-clock?staffId=&from=&to=` | entries + computed cost |
| GET/POST | `/workspace/labor/shifts` · GET/PATCH/DELETE `/{shiftId}` · POST `/publish` | schedule CRUD |
| GET | `/workspace/labor/cost?from=&to=` | labor cost vs sales summary |
| GET/POST | `/workspace/labor/tip-pools` · POST `/{id}/close` · POST `/{id}/payouts` | pool create (period), close computes shares, payout marks paid |

## Services

`StaffProfilesService` (incl. PIN hashing — same hashing discipline as auth), `TimeClockService`,
`ShiftsService`, `LaborCostService` (pure math over entries + orders), `TipPoolsService`.

## Permissions

`staff:read`, `staff:manage` (profiles/PINs), `labor:clock` (clock in/out — any operational
member for themselves, `staff:manage` to correct others), `labor:schedule:*`,
`labor:tips:*`. Enforced via `requireLevelPermissions`; self-service clock routes verify
`staff_profile_id` maps to the PIN entered, not to the caller's claims.

## Audit & events

`defineActivity`: `staffProfileActivity`, `timeClockActivity` (corrections only — ins/outs are
chatty), `shiftActivity`, `tipPoolActivity`. Events: `labor.clock_in/out`,
`labor.shift.published`, `labor.tip_pool.closed` — Phase 8 consumes for labor reports.

## Testing plan

- PIN flow: wrong PIN → 401/403; overlap rejection; break math.
- Labor cost golden tests (rates, minutes, business-day boundary).
- Tip pool distribution per rule (hours/points/equal) + payout immutability after close.
- Attribution: server stamped from session, not body.
- Tenancy + permission rejections; deactivation semantics.

## Definition of done

- [ ] Five tables migrated; PINs hashed; entries append-only with manager corrections.
- [ ] Clock in/out, schedules, labor cost, tip pools operable.
- [ ] Orders attribute servers; tips flow from Phase 6 ledger into pools.
- [ ] Tests green, typecheck clean; docs updated (Staff & Labor → **Built**).
