# Phase 8 — Reporting

Status: **planned** · Depends on: Phases 1–7 · Milestone: **M9 — numbers visible**

## Goal

Derived read models over the event streams the previous phases produced: sales, food
cost/COGS, labor %, menu engineering, waste variance, and turn/ticket times. Reports are
**projections** — they never write back to domain tables (scope 86–93).

## Dependencies

- Orders (4) + payments (6) for sales/tenders; catalog (1) + recipes (2) for COGS; time
  clock (7) for labor; `table_state_history` (3) and `ticket_item_transitions` (5) for
  timing; workspace settings (0) for currency + business-day boundary.

## Approach

1. **Start with SQL aggregates** over normalized tables (explicit joins — no relations) behind
   a read-only `ReportsService`. Parameterize every query by `(workspace_id, from, to)` with
   business-day-aware boundaries computed in the workspace timezone.
2. **Materialize only where it hurts.** If list-page latency demands it, add materialized
   views (refreshed on EOD close — the natural hook from Phase 6) or projection tables rebuilt
   from `domain_events`. Do not pre-build projections speculatively.
3. Keep each report's derivation documented in this file's table below, so a future
   event-sourced rebuild matches.

## Report catalog

| Report | Derivation | Notes |
| --- | --- | --- |
| Sales by item / category / period | `order_line_items` (non-voided, non-comped) joined to `orders`/`menu_items`, grouped; revenue = line totals incl. variant/modifier deltas, excl. tax/tips | the core sales set |
| Sales by server | `orders.server_user_id` attribution | scope 69 |
| Tenders summary | `payments` group by tender/direction; tips separate | scope 79 |
| Food cost / COGS | Σ over sold items: `recipe_ingredients.quantity × ingredient.cost_per_base_unit` at the **recipe version current at sale time** (join via sale date) | scope 87 |
| Labor cost % | `LaborCostService` output ÷ net sales per business day | scope 88 |
| Menu engineering matrix | popularity (units sold) × margin (price − COGS) per item → stars/dogs/puzzles/plowhorses quadrant | scope 89 |
| Waste & variance | `waste` movements; theoretical usage (recipes × sales) vs actual (ledger) per ingredient | scope 90, 62 |
| Table turn time | `table_state_history`: free→seated→free spans per table/day | scope 91 |
| Ticket times | `ticket_item_transitions` queued→ready spans per station/item | scope 52 |
| Discount/void/comp summary | `order_discounts` + voided/comped lines with reasons | loss-prevention view |

## API surface

Read-only, mounted after the tenant middlewares, `report:read` on all:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspace/reports/{report}?from=&to=&granularity=day|shift|hour` | uniform shape: `{ report, range, granularity, rows: [...], totals }` |
| GET | `/workspace/reports/{report}/export?format=csv` | CSV export reusing the same service |

Error semantics: unknown report name → 404; bad range (`from > to`, span cap e.g. 366 days) →
400.

## Services

`ReportsService` with one internal method per report returning typed DTOs; shared
`businessDayRange(workspace, from, to)` boundary helper (single source of timezone math).
No new writes; `ActivityLogger` untouched.

## Permissions

`report:read` only — but consider tiering sensitive reports (tenders, discounts/voids) behind
elevated grants when Phase 7 tunes roles.

## Testing plan

- **Golden-number tests**: seed a known scenario (menu, orders across a fired course, payments
  with tips/splits, waste, clock entries) and assert exact integers per report row.
- Business-day boundary: orders either side of the configured boundary hour land in the right
  business date, across a DST transition.
- Variance math: theoretical vs actual with recipe-version-in-effect-at-sale correctness.
- Menu engineering quadrants on a seeded matrix.
- Range validation + empty-range behavior; tenancy isolation (another workspace's data never
  leaks).

## Definition of done

- [ ] All ten reports above served via the uniform endpoint with `report:read`.
- [ ] Business-day/timezone handling centralized and tested (incl. DST).
- [ ] Derivations documented here and reproducible from raw tables.
- [ ] Tests green, typecheck clean; docs updated (Reporting → **Built**).
