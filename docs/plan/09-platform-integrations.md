# Phase 9 — Platform & Integrations

Status: **planned** · Depends on: all prior phases · Milestone: **M10 — platform-ready**

## Goal

Everything that turns the engine into a deployable platform: persistent domain events with
webhook fan-out, customer/loyalty accounts, the offline-sync design, external integrations
(printers, payment terminals, delivery aggregators, accounting), and the operational hardening
pass (rate limits, request logging, readiness).

## Dependencies

- All phases — this consumes and hardens everything.

## Work items

### 1. Event persistence, replay & webhooks (scope 97–98)

- Upgrade Phase 0's bus: every published event is durable in `domain_events`; add a
  `webhook_subscriptions` table (`workspace_id`, `url`, `secret` (encrypted at rest — the
  delivery signer needs the plaintext to compute HMACs; hashing only works for verifying
  *inbound* secrets), `event_types` array, `is_active`) and a `webhook_deliveries` log
  (`subscription_id`, `event_id`, `status` `pending|delivered|failed|exhausted`, `attempts`,
  `next_retry_at`, `response_status`).
- Delivery worker (in-process timer table-poll loop — no external queue): HMAC-signed POSTs,
  exponential backoff, dead-letter after N attempts; manual redelivery endpoint.
- Replay tooling: re-dispatch events in a seq range to rebuild a projection or re-fire
  webhooks (idempotent consumers are a documented requirement for subscribers).

### 2. Customers & loyalty (scope 107)

- `customers` (workspace-scoped, name/phone/email, `external_ref`), `customer_orders` link via
  Phase 4's `orders.customer_*`; loyalty: `loyalty_accounts` (points int), `loyalty_ledger`
  (append-only earn/redeem tied to payments/orders). Redeem at payment time through the
  `loyalty` tender, reserved in Phase 6's tender enum.

### 3. Offline sync (scope 99) — design first, then minimal runtime

- Deliverable 1: a written design (`docs/offline-sync.md`): client oplog of idempotent
  mutations keyed by `Idempotency-Key` (Phase 4 made this possible), server-authoritative
  conflict rules (version checks reject stale writes → client resyncs; no server-side merges),
  catalog snapshots with `updated_at` cursors.
- Deliverable 2: cursor-based sync endpoints for catalog/menu (`GET .../sync?since=`) — the
  minimum viable offline story for POS clients.

### 4. Integrations (scope 103–106, 84)

- **Receipt printers**: print-channel abstraction (`src/integrations/printers/`) consuming
  `kitchen.ticket.*` / `payment.check.settled` events; adapter for ESC/POS-over-network as the
  first target; a `printer_jobs` outbox table with retry so printing failures never fail the
  domain mutation.
- **Payment terminals**: terminal handoff design (initiate/refund → terminal URL +
  `processor_reference` written back into the Phase 6 ledger; no card data).
- **Delivery aggregators**: inbound webhook to create takeaway/delivery orders with an
  `external_source`/`external_id` dedupe; outbound status events (`order.placed/completed`).
- **Accounting**: the Phase 6 CSV export hardened into a scheduled summary export (per
  business day, per tender).

### 5. Operational hardening (scope 102, 108–109)

- Rate limiting middleware (per-IP + per-session token bucket) on auth and public token
  routes; structured request logging with request ids (already present) enriched with
  workspace/user context post-auth.
- Readiness endpoint: DB `SELECT 1` + migration-version check, distinct from `/health`
  liveness; startup config validation with fail-fast messages.
- Security pass: session cookie flags, upload MIME/size review, permission-catalog audit
  (every route checked against `requireLevelPermissions`), dependency audit.

## API surface (new)

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/webhooks` · PATCH/DELETE `/{id}` · GET `/{id}/deliveries` · POST `/{id}/redeliver` | subscription management |
| GET/POST | `/workspace/customers` · GET/PATCH `/{customerId}` | customer directory |
| GET/POST | `/workspace/loyalty/{customerId}/...` | account + ledger reads, manual adjust (permissioned) |
| GET | `/workspace/catalog/sync?since=` | offline cursor sync |
| POST | `/integrations/delivery/{provider}/orders` | public, HMAC-signed aggregator inbound |
| GET | `/ready` | readiness probe |

## Services

`WebhooksService` (+ delivery worker module), `CustomersService`, `LoyaltyService`,
`CatalogSyncService`, integration adapters under `src/integrations/` (each behind a narrow
interface so tests stub the transport).

## Testing plan

- Webhook delivery: signed payload verification, retry/backoff schedule, dead-letter,
  redelivery; consumer idempotency contract test.
- Loyalty earn/redeem math + ledger immutability; redeem as tender through Phase 6 flow.
- Delivery inbound dedupe (`external_id`) + order creation happy path.
- Sync cursor correctness (inserts/updates/deletes since cursor).
- Rate limiter behavior; readiness failing on a killed DB.
- Adapter tests against stubbed transports.

## Definition of done

- [ ] `domain_events` durable + replayable; webhooks with signed delivery and retries.
- [ ] Customers + loyalty ledger operable end-to-end with payments.
- [ ] Offline-sync design doc merged; catalog sync endpoint live.
- [ ] Printer outbox + terminal handoff + aggregator inbound + accounting export all behind
      tested adapters.
- [ ] Rate limiting, request logging, `/ready`, and the security pass landed.
- [ ] Tests green, typecheck clean; `product-scope.md` Platform & Technical rows updated.
