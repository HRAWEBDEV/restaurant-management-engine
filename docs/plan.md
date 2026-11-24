# Delivery Plan — Toward a Toast-class Restaurant OS

The build order for taking `restaurant-manager-api` from a finished tenancy foundation to a
full restaurant management platform (menu, floor, orders, kitchen, payments, inventory, labor,
reporting — think Toast). This document is the map; each phase has its own detailed doc in
`docs/plan/`.

## Where we are

Built and wired today (see `docs/architecture.md`, `docs/data-model.md`, `docs/api.md`):

- Better Auth identity (email/password + username), sessions, profile management.
- Tenancy: organizations, workspaces, two-tier membership, invitations (send/list/revoke/accept).
- Permissions scaffold (namespaced strings, `checkLevelPermissions`, `requireLevelPermissions`
  route middleware) — partially enforced.
- Audit (`activity_logs` + `ActivityLogger`) with writers on the existing mutations.
- Asset uploads (`AssetStorage`), OpenAPI document + Swagger UI, `bun:test` harness with
  per-suite DB reset.

No operational domain data exists yet — nothing hangs off `workspace_id` except `activity_logs`.

## Target

An API backend that a POS terminal, kitchen display, admin/back-office, and customer-facing
client can all sit on top of, with one authoritative, tenant-safe implementation of:

menu & catalog management, table floor management, the order lifecycle, kitchen ticket flow,
payment capture and settlement, recipes & inventory, labor & tips, and derived reporting.

## Guiding principles (apply to every phase)

1. **Tenancy first.** Every operational table carries `workspace_id`; every query is scoped by an
   authorized workspace resolved from the `x-workspace-id` header through the tenant middlewares.
2. **Permissions on every mutation.** Roles from membership rows only; permission strings are
   pre-declared per domain in `src/utils/roles-permissions/`.
3. **Money is integer minor units.** Tax/service-charge rounding rules are decided once, per
   phase, and documented. Payments are an immutable ledger; never store card data.
4. **Audit every state change.** One `activity_logs` row per mutation via `ActivityLogger`, on the
   same transaction, with the entity's `defineActivity` definition.
5. **Events over projections.** State-changing mutations emit domain events; kitchen tickets,
   stock depletion, and reports are subscribers/projections — never hand-maintained side writes.
6. **Contract-first API.** `createRoute` + Zod from `@hono/zod-openapi` for every endpoint, all
   status codes documented with `errorResponseSchema`, `StatusCodes` constants.
7. **Tests with every change.** Colocated `__tests__/`, run via `bun run test`; `bun run
   typecheck` before finishing anything.
8. **Docs travel with behavior.** Each phase updates `docs/data-model.md`, `docs/api.md`, and the
   status table in `docs/product-scope.md`.

## Build order at a glance

| Phase | Doc | Delivers | Depends on |
| --- | --- | --- | --- |
| 0 — Foundations hardening | [00-foundations.md](plan/00-foundations.md) | Tenant middleware consumption everywhere, permission catalog, event bus + `domain_events`, DB gap pay-down, workspace settings (currency/timezone) | — |
| 1 — Catalog (menu) | [01-catalog.md](plan/01-catalog.md) | Categories, items, variants, modifier groups, tax classes, availability, 86, images, stations | 0 |
| 2 — Recipes & inventory | [02-inventory-recipes.md](plan/02-inventory-recipes.md) | Ingredients, UoM, recipes/BOM, suppliers, POs, stock ledger, counts, waste | 0, 1 |
| 3 — Floor | [03-floor.md](plan/03-floor.md) | Sections, tables + states, layout, reservations, merge/split | 0 |
| 4 — Orders engine | [04-orders.md](plan/04-orders.md) | Order lifecycle state machine, line items + modifiers, coursing, checks, discounts, voids/comps, idempotency, optimistic concurrency | 0, 1, 3 |
| 5 — Kitchen | [05-kitchen.md](plan/05-kitchen.md) | Auto-generated tickets, station routing, KDS flow (queue → bump → recall) | 1, 4 |
| 6 — Payments | [06-payments.md](plan/06-payments.md) | Payment ledger, tenders, split/partial, tips, refunds, cash drawer, EOD close | 0, 4 |
| 7 — Staff & labor | [07-staff-labor.md](plan/07-staff-labor.md) | Staff profiles + PIN clock-in, time clock, schedules, labor cost, tip pools | 0, 4, 6 |
| 8 — Reporting | [08-reporting.md](plan/08-reporting.md) | Sales, COGS, labor %, menu engineering, waste variance, turn times; business-day boundaries | 1–7 |
| 9 — Platform & integrations | [09-platform-integrations.md](plan/09-platform-integrations.md) | Event persistence + webhooks, customers/loyalty, offline sync, printers/terminals/delivery/accounting integrations, rate limiting | all |

### Dependency graph

```
Phase 0 (foundations)
  ├──> 1 (catalog) ──> 2 (inventory/recipes)
  │        │                      │
  │        │             (depletion wired in 4)
  │        v
  └──> 3 (floor) ──> 4 (orders) ──> 5 (kitchen)
              │            │
              │            ├──> 6 (payments) ──> 7 (staff/labor)
              │            │
              │            └──────────────────> 8 (reporting)
              v
   9 (platform/integrations) — consumes events from every domain
```

Phases 2 and 3 are independent of each other and could be swapped; orders (4) needs both
catalog (items to sell) and floor (tables to attach to). Kitchen (5) and payments (6) are
independent of each other once orders exist — kitchen also reads Phase 1's `kitchen_stations`
(items carry `station_id`). Reporting (8) is deliberately last so it is built against real
event streams rather than guessed shapes.

## Delivery milestones

Each milestone is a demoable capability — a way to know the phase is *done done*.

- **M1 — Hardened platform.** A workspace-scoped CRUD endpoint exists that went through tenant
  middlewares, permission checks, and audit; `domain_events` captures its mutations. (Phase 0)
- **M2 — Menu managed.** A back-office client can build a full menu: categories, items with
  images, variants, modifier groups, tax classes, day-part availability, and 86 an item. (Phase 1)
- **M3 — Recipes & stock tracked.** Ingredients, recipes with per-item costs, suppliers, POs,
  physical counts, and waste are recordable; stock on hand derives from an append-only movement
  ledger. (Phase 2)
- **M4 — Floor operable.** Sections/tables/layout exist, walk-ins can be seated, reservations
  managed, tables merged/split; table states follow the state machine. (Phase 3)
- **M5 — Orders engine live.** A POS client can create an order, add items with modifiers, fire
  courses, split checks, apply discounts, and void/comp with permission-gated reason codes —
  with idempotency and optimistic concurrency. (Phase 4)
- **M6 — Kitchen flow.** Firing a course produces routed kitchen tickets; a KDS can bump items
  and tickets; prep timings are recorded. **First end-to-end service demo:** seat → order →
  fire → bump → ready. (Phase 5)
- **M7 — Money settled.** Checks can be paid (split/partial), refunds and tips recorded, cash
  drawers reconciled, end-of-day close runs. **Full POS loop demo:** seat → order → fire → bump
  → pay → table dirty → clean. (Phase 6)
- **M8 — Labor operational.** Staff clock in/out on shared devices with PINs, schedules exist,
  labor cost and tip pools compute. (Phase 7)
- **M9 — Numbers visible.** Sales, COGS, labor %, menu engineering, waste variance, and turn
  times report correctly across business-day boundaries. (Phase 8)
- **M10 — Platform-ready.** Webhooks, loyalty/customers, offline sync design, and external
  integrations (printers, terminals, delivery, accounting) land. (Phase 9)

## What every phase doc contains

To keep the phases executable, each doc in `docs/plan/` follows the same shape:

1. **Goal** — what this phase delivers and why it sits here in the order.
2. **Dependencies** — what must exist first.
3. **Data model** — tables, key columns, enums, indexes, FK/tenancy decisions (schema-file list).
4. **Invariants & rules** — state machines, math rules, integrity constraints the service/DB must
   enforce.
5. **API surface** — endpoints, methods, permissions required, notable status codes.
6. **Services** — service classes and their responsibilities (route/service split).
7. **Audit & events** — `defineActivity` definitions and domain events emitted/consumed.
8. **Testing plan** — what the colocated tests must cover.
9. **Definition of done** — checklist: schema generated/migrated, routes mounted (in the right
   middleware position), permissions enforced, audit rows written, tests passing, docs updated.

## Working through a phase (per-feature workflow)

1. Declare permission strings for the sub-feature in `src/utils/roles-permissions/` (extend role
   grants for `admin`/`member` as appropriate).
2. Add schema file(s) in `src/db/schemas/` per the table conventions → `bun run db:generate` →
   review SQL → `bun run db:migrate`.
3. Add `defineActivity` definitions in `src/utils/activityDefinitions.ts` and any domain events
   in `src/events/`.
4. Build service class(es) in `src/services/` (`private readonly db: DBExecutor`, transaction-
   scoped, DTO returns, `null` for missing rows).
5. Define the route contract in `src/v1/api/routes/<domain>.ts` and mount in
   `src/v1/api/index.ts` **after the tenant middlewares** (workspace-scoped domains) — verify the
   mount position against the router-order rules in `docs/api.md`.
6. Write colocated tests (service + route level, tenancy + permission + invariant cases) and run
   `bun run test`.
7. Update `docs/data-model.md`, `docs/api.md`, `docs/product-scope.md` status table, and check
   off the phase's definition of done.

## Decisions to make along the way

Captured here so they are revisited deliberately, not silently:

- **Catalog sharing across workspaces.** Phase 1 keeps menu items workspace-local (simplest
  correct tenancy). A shared org-level catalog with per-workspace price overrides (scope items
  7–8 in `docs/product-scope.md`) is a later extension once the workspace-local model is proven.
- **Event store.** Phase 0 introduces an in-process bus plus an append-only `domain_events`
  table written on the mutation's transaction; Phase 9 decides retention, replay, and webhook
  fan-out semantics on top of it.
- **Report materialization.** Phase 8 starts with SQL aggregates/views over normalized tables
  and only introduces materialized projections if volume demands it.
- **Staff identity.** Phase 7 introduces workspace-local `staff_profiles` (optionally without a
  `user` row, PIN-authenticated) — POS staff and platform users are different populations.
