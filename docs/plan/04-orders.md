# Phase 4 — Orders Engine

Status: **planned** · Depends on: Phases 1, 3 · Milestone: **M5 — orders engine live**

## Goal

The heart of the product and the largest phase: the order lifecycle state machine, line items
with variant + modifier snapshots, coursing, checks (split/merge/transfer), discounts,
permission-gated voids/comps, optimistic concurrency, and idempotent mutations. When this
lands, a POS client can run a full order write-path, and Phase 5 (kitchen) / Phase 6
(payments) / inventory depletion can all subscribe to its events.

## Dependencies

- Phase 1 — catalog items/variants/modifiers/tax classes to order from.
- Phase 3 — tables to attach dine-in orders to.
- Phase 2 — its `InventoryMovementsService.recordMovement` receives depletion from here (the
  only Phase-2 touchpoint: one subscriber).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `orders.ts` | `orders` | `workspace_id`, `order_number` int (per-workspace sequence), `type` enum `dine_in|takeaway|delivery`, `status` enum `draft|open|in_progress|completed|cancelled`, `version` int (optimistic concurrency), `table_id` FK nullable, `customer_name`/`customer_phone` nullable (scope 43), `public_token` uuid nullable (scope 44), `server_user_id` (attribution; Phase 7), `notes`, totals snapshot: `subtotal`, `tax_total`, `discount_total`, `service_total`, `total` (all int minor units, server-computed) |
| `orderLineItems.ts` | `order_line_items` | `order_id` FK, `menu_item_id` + **snapshots** (`item_name`, `variant_name`, `unit_price`, `tax_rate`), `quantity` int > 0, `status` enum `placed|fired|voided|comped`, `course_id` FK nullable, `seat_number` int nullable, `note`, `voided_reason`/`comped_reason` |
| `orderLineItemModifiers.ts` | `order_line_item_modifiers` | `line_item_id` FK, `modifier_id` + snapshot (`name`, `price_delta`) — modifiers are frozen at order time |
| `courses.ts` | `courses` | `order_id`, `name`, `position`, `fired_at` timestamptz nullable |
| `checks.ts` | `checks` | `order_id`, `status` enum `open|paid|voided`, `name` ("Check 1"), totals snapshot like orders |
| `checkLineItems.ts` | `check_line_items` | `check_id`, `line_item_id` unique, `added_at` — assignment/movement history of items across checks |
| `orderDiscounts.ts` | `order_discounts` | `order_id` or `check_id` (one required), `type` enum `percent|amount`, `value` int (percent in basis points / amount minor units), `reason`, `approved_by_user_id`, `created_at` |
| `idempotencyKeys.ts` | `idempotency_keys` | `workspace_id`, `key` varchar, `request_hash`, `response_status`, `response_body` jsonb, unique `(workspace_id, key)` — replay returns the stored response |

Snapshots are mandatory: catalog edits must never mutate placed orders.

## Invariants & rules

### Order state machine

```
draft ──place──> open ──first course fired──> in_progress ──all items settled & checks paid──> completed
  │                │                                    │
  └──cancel────────┴──────────────cancel (no fired items)──────────────> cancelled
```

- Illegal transitions → 409. `cancel` on an order with fired items is refused (void items
  first). `completed` requires every check `paid` (or `voided`) and no unfired items —
  **enforced in service**, driven by payment events in Phase 6.
- **Optimistic concurrency** (scope 40): every mutating request sends `version`; mismatch →
  409 with the current row. Every mutation increments `version`.
- **Idempotency** (scope 41): mutating endpoints accept an `Idempotency-Key` header; first
  execution stores the response in `idempotency_keys` (same transaction), replays return it.
- **Totals are server-computed only** (scope 7, money integer minor units):
  `subtotal = Σ(unit_price + variant_delta + Σ modifier_deltas) × qty`, discounts capped at
  subtotal, tax per line from the item's tax class rate (banker's rounding, decided once and
  documented), service charge from workspace config, `total = subtotal − discount + tax + service`.
  Totals are recomputed on every mutation and snapshotted.
- **Voids/comps** (scope 33–34) never delete: `status → voided/comped` with reason + actor;
  both require dedicated permissions; comps require an approval permission level (org admin+).
- **Checks** (scope 35–36): items start on the order's default check; split moves
  `check_line_items` rows to new checks; merge folds checks (open only); transfer moves items
  between tables' orders (also updates table state if a table empties).
- **Coursing** (scope 31–32): items belong to a course (or no course = fire-with-next);
  firing a course stamps `fired_at` on its items, flips order to `in_progress`, emits the event
  Phase 5 consumes.
- **Depletion hook**: on course fire (and on placement for takeaway), publish
  `order.items.fired`; a Phase-2-built subscriber calls `recordMovement` per recipe line —
  idempotent via the event id as `source_id`.
- `order_number` is a per-workspace sequence (service-side `SELECT ... FOR UPDATE` on a
  workspace counter row or `INSERT ... RETURNING` with retry), never client-sent.

## API surface

Mounted after the tenant middlewares. All mutating order endpoints take `Idempotency-Key`
(optional but stored when present) and require a body `version` for concurrency.

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/orders` | list (`?status=&type=&tableId=`) / create draft |
| GET | `/workspace/orders/{orderId}` | full aggregate: items + modifiers + checks + discounts |
| POST | `/workspace/orders/{orderId}/place` | draft → open; dine-in requires table; emits `order.placed` |
| POST | `/workspace/orders/{orderId}/items` | add line items (menu item/variant + modifier selections); prices resolved server-side |
| PATCH/DELETE | `/workspace/orders/{orderId}/items/{lineItemId}` | edit qty/seat/note (pre-fire) / remove (pre-fire only; post-fire = void) |
| POST | `/workspace/orders/{orderId}/items/{lineItemId}/void` · `/comp` | reason + permissions |
| POST | `/workspace/orders/{orderId}/courses` · POST `/{courseId}/fire` | create course / fire it |
| POST | `/workspace/orders/{orderId}/discounts` | order- or check-level |
| POST | `/workspace/orders/{orderId}/checks` · `/{checkId}/split` · `/{checkId}/merge` · `/items/{lineItemId}/transfer` | check management |
| POST | `/workspace/orders/{orderId}/cancel` | only when no fired items |
| POST | `/workspace/orders/{orderId}/customer` · `/notes` | attach info |
| GET | `/workspace/orders/public/{token}` | **public** (before auth middleware), read-only status page for takeaway |

## Services

`OrdersService` (lifecycle, concurrency, totals engine), `OrderLineItemsService` (add/edit/
void/comp with snapshots), `CoursesService`, `ChecksService`, `OrderDiscountsService`, plus a
pure `computeOrderTotals(lines, discounts, taxClasses, serviceCharge)` helper (exhaustively
unit-tested; the single place money math lives). Depletion subscriber in `src/events/` wiring.

## Permissions

`order:read`, `order:create`, `order:edit` + `order:item:add` for taking orders;
`order:item:void`, `order:item:comp`, `order:discount:apply` gated to elevated roles (comp
needs organization-level grant); `order:cancel`; `order:check:*` for check ops. Enforce via
`requireLevelPermissions`; void/comp additionally verify the actor in-handler (reason + audit).

## Audit & events

`defineActivity`: `orderActivity` (summary = status/total transitions; no per-item diffs),
`orderLineItemActivity` (voids/comps with reasons), `checkActivity`, `orderDiscountActivity`.
Line-item churn is too chatty for audit — the event stream carries it.

Events: `order.created/placed/cancelled/completed`, `order.item.added/edited/voided/comped`,
`order.course.fired`, `order.discount.applied`, `order.check.created/split/merged/updated`.
Consumers: kitchen ticket creation (Phase 5), inventory depletion (Phase 2 service),
table-state updates (Phase 3), reporting (Phase 8).

## Testing plan

- State-machine matrix (legal/illegal, cancel-with-fired-items refusal, completion guard).
- Concurrency: parallel mutations, stale version → 409; idempotency: replay returns stored
  response, same-key different-body → 409.
- Totals golden tests: variants, modifier deltas, percent/amount discounts + caps, per-line tax
  rounding, service charge — integer math throughout.
- Snapshot integrity: mutate catalog after ordering, assert order unchanged.
- Coursing fire semantics; check split/merge/transfer arithmetic and edge cases (transfer last
  item, voided items).
- Depletion subscriber fires once per event (idempotent on replay).
- Tenancy + permission rejections incl. comp/void elevation.

## Definition of done

- [ ] Eight tables migrated; snapshots, version column, idempotency keys in place.
- [ ] Full lifecycle operable end-to-end with events consumed by at least the depletion
      subscriber and table-state updates.
- [ ] Totals engine pure, unit-tested, integer minor units.
- [ ] Void/comp/discount permission-gated with reasons + audit rows.
- [ ] Tests green (`bun run test`), typecheck clean; docs updated (Orders → **Built** in
      `product-scope.md`, new tables/endpoints in `data-model.md` / `api.md`).
