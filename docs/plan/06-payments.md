# Phase 6 — Payments & Billing

Status: **planned** · Depends on: Phases 0, 4 · Milestone: **M7 — money settled (full POS loop)**

## Goal

Settle checks: an immutable payment ledger with multiple tenders, split and partial payments,
separate tip capture, refunds/voids with audit, cash drawer sessions, and the end-of-day
close. This phase completes the core POS loop: seat → order → fire → bump → **pay** → dirty
→ clean.

## Dependencies

- Phase 4 (orders/checks to settle; completion guard consumes payment events).
- Phase 0 (workspace currency; `domain_events`).
- No processor integration yet — this phase records money movement; card-present handoff is
  Phase 9 (recorded via a `processor` tender + reference, still ledger-only).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `payments.ts` | `payments` | **append-only ledger**; `workspace_id`, `check_id` FK, `direction` enum `charge|refund`, `parent_payment_id` nullable (refunds point at the charge), `tender` enum `cash|card|mobile|gift|house_account|loyalty` (`loyalty` reserved for Phase 9 redemption), `amount` int > 0, `tip_amount` int default 0, `processor_reference` text nullable (never card data), `status` enum `captured|voided` (the one sanctioned update: the `captured → voided` flag with reason), `actor_user_id`, `created_at` only |
| `cashDrawerSessions.ts` | `cash_drawer_sessions` | `workspace_id`, `opened_by`, `opening_float` int, `opened_at`, `closed_at` nullable, `counted_total`, `expected_total`, `over_short` int (computed at close) |
| `cashDrawerEvents.ts` | `cash_drawer_events` | `session_id`, `type` enum `pay_in|pay_out|no_sale`, `amount` int, `reason`, `actor_user_id`, `created_at` |
| `businessDays.ts` | `business_days` | `workspace_id`, `business_date` date (in workspace tz), `opened_at`/`closed_at`, `totals_snapshot` jsonb (tender sums, order counts) — EOD close artifact, unique `(workspace_id, business_date)` |

Service charges: workspace-level config column (`service_charge_percent` basis points) added
in Phase 0 settings or here; tax comes from Phase 1 tax classes.

## Invariants & rules

- **Immutability**: payments are never deleted and their content never changes; the single
  sanctioned update is flipping `status` `captured → voided` (with a reason). Every other
  correction is a new refund row (`direction = refund`, `parent_payment_id`) — both paths
  permission-gated and audited (scope 80–81).
- `amount + tip_amount` per charge; tips are recorded **separately from sales** (scope 79) and
  never counted in sales totals — only in tender/tip reports.
- **Split payments** (scope 75): N payment rows against one check until
  `Σ charges − Σ refunds ≥ check total`; **partial payments** (scope 76) are allowed to
  underpay only when the check stays open. Overpayment on cash → change due computed and
  returned (change is not a ledger row; document the drawer treatment).
- Check settlement flips `checks.status → paid` and publishes `payment.check.settled`; the
  Phase 4 completion guard + Phase 3 table-state subscriber react.
- **Cash drawer** (scope 82): one open session per workspace; cash payments attach to it;
  close computes `expected = opening_float + cash charges − cash refunds ± pay_in/out` vs
  `counted_total` → `over_short`.
- **EOD close** (scope 83): closes the business day in the workspace timezone (Phase 0
  boundary setting), snapshots totals per tender into `business_days`, refuses while checks/
  sessions are unsettled (or flags them, per implementation decision — decide, document).
- **Card data is never stored** (scope 85): processor references only.

## API surface

Mounted after the tenant middlewares.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspace/payments?checkId=&from=&to=` | ledger read |
| POST | `/workspace/orders/{orderId}/checks/{checkId}/pay` | body `{ payments: [{ tender, amount, tipAmount? }] }`, `Idempotency-Key` header (Phase 4 replay semantics) — one or many rows atomically; settles when total reached |
| POST | `/workspace/payments/{paymentId}/refund` | amount ≤ remaining; reason |
| POST | `/workspace/payments/{paymentId}/void` | reason; permission |
| GET/POST | `/workspace/cash-drawer/sessions` · POST `/{sessionId}/events` · POST `/{sessionId}/close` | open, pay-in/out/no-sale, reconcile |
| POST | `/workspace/business-days/close` · GET `/workspace/business-days?date=` | EOD close + read |
| GET | `/workspace/payments/export?from=&to=&format=csv` | processor/accounting export (scope 84) |

## Services

`PaymentsService` (the only writer of `payments`; atomic multi-tender settlement with the
check-status flip and completion check on one transaction), `RefundsService` (or folded in),
`CashDrawerService`, `BusinessDaysService`. Validation helper
`computeCheckBalance(checkId)` shared with the totals engine.

## Permissions

`payment:read`, `payment:capture` (operational), `payment:refund` / `payment:void` (elevated),
`payment:drawer:*` (cash handling), `payment:eod:close` (manager). All enforced via
`requireLevelPermissions` at `organizationWorkspace` level.

## Audit & events

`defineActivity`: `paymentActivity` (summary = tender/amount/action; never diff card refs),
`cashDrawerActivity`, `businessDayActivity`. The ledger rows themselves are the report feed.

Events: `payment.captured/refunded/voided`, `payment.check.settled`,
`cash_drawer.opened/closed`, `business_day.closed`. Consumers: Phase 4 completion guard,
Phase 3 table → dirty, Phase 7 tip pools, Phase 8 reporting.

## Testing plan

- Ledger immutability (no update path exists; refunds are rows).
- Split/partial/overpay math incl. tip separation; settle-at-threshold check flip; double-pay
  rejected; idempotent retry of `/pay`.
- Refund caps, void audit rows, permission rejections.
- Drawer reconciliation math; EOD close with unsettle-check refusal; business-date boundary
  tests around the workspace timezone.
- Event consumers (completion, table state) verified end-to-end.

## Definition of done

- [ ] Four tables migrated; payments append-only with refund linkage.
- [ ] Multi-tender/split/partial settlement with tips, refunds, voids — permission-gated and
      audited.
- [ ] Drawer sessions reconcile; EOD close produces snapshots in workspace business time.
- [ ] Full POS loop demo passes: seat → order → fire → bump → pay → table dirty.
- [ ] Tests green, typecheck clean; docs updated (Payments → **Built**).
