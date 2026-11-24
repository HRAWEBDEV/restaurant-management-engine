# Phase 2 — Recipes & Inventory

Status: **planned** · Depends on: Phases 0, 1 · Milestone: **M3 — recipes & stock tracked**

## Goal

Model *what dishes consume*: ingredients, units of measure, recipes as bills of materials,
suppliers and purchase orders, and an append-only stock movement ledger with counts, waste, and
par levels. Automatic depletion on sale is **wired later, in Phase 4** (orders emit events;
this phase's ledger is the subscriber target).

## Dependencies

- Phase 0 (events, settings, permissions).
- Phase 1 (menu items/variants own the recipes; modifiers can deplete too).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `ingredients.ts` | `ingredients` | `workspace_id`, `name`, `base_unit` enum (`gram`/`ml`/`each`), `cost_per_base_unit` int minor units (last known; snapshot on recipes), `supplier_id` FK nullable, `is_active` |
| `unitConversions.ts` | `unit_conversions` | `workspace_id`, `from_unit` / `to_unit` varchar, `factor` numeric — explicit conversion rows, no implicit math |
| `recipes.ts` | `recipes` | `menu_item_id` FK (Phase 1), `variant_id` FK nullable (null = applies to all variants), `version` int, `yield_qty` numeric (produces N portions), `is_current` bool |
| `recipeIngredients.ts` | `recipe_ingredients` | `recipe_id` FK, `ingredient_id` FK, `quantity` numeric, `unit` varchar, `waste_percent` int (prep loss) |
| `modifierIngredientLinks.ts` | `modifier_ingredient_links` | `modifier_id` FK, `ingredient_id` FK, `quantity` numeric, `unit` — modifier selections deplete too (scope item 56) |
| `suppliers.ts` | `suppliers` | `workspace_id`, `name`, `email`, `phone`, `notes`, `is_active` |
| `purchaseOrders.ts` | `purchase_orders` | `workspace_id`, `supplier_id`, `status` enum `draft|sent|received|closed|cancelled`, `expected_at`, `received_at`, `reference` |
| `purchaseOrderLines.ts` | `purchase_order_lines` | `purchase_order_id`, `ingredient_id`, `quantity`, `unit`, `unit_cost` int minor units, `received_quantity` numeric |
| `stockMovements.ts` | `stock_movements` | **append-only ledger**; `seq` bigserial (ordering key), `workspace_id`, `ingredient_id`, `type` enum `receipt|depletion|waste|count_adjustment|manual_adjustment`, `quantity` numeric signed (− depletes), `unit`, `unit_cost` int nullable, `source_type`/`source_id` (order line, PO, count…), `actor_user_id`, `reason` |
| `stockCounts.ts` / `stockCountLines.ts` | `stock_counts`, `stock_count_lines` | count header (status `open|completed`), lines (ingredient, counted qty) — completing a count writes `count_adjustment` movements |
| `parLevels.ts` | `par_levels` | `ingredient_id`, `par_quantity`, `reorder_threshold` numeric |

Indexing: `stock_movements (workspace_id, ingredient_id, seq)` and
`stock_movements (workspace_id, created_at)`; unique open count per workspace.

## Invariants & rules

- **The ledger is the truth.** On-hand stock is a projection: sum of signed movement quantities
  (in base units). Never store a mutable `on_hand` column as authority; keep a cached/derived
  `stock_levels` projection only if read performance requires it (start without it).
- Quantities are `numeric` (weighted/drills matter), **money stays integer minor units** —
  `unit_cost` and `cost_per_base_unit` are ints.
- Movements are append-only; a mistaken entry is corrected by a counter-movement with a reason,
  never an update.
- Recipe **versioning**: a new version row is inserted and `is_current` flips; historical
  versions keep COGS accurate for past orders (scope item 87; Phase 8 joins by version).
  `yield_qty` covers scope item 63's yield factors.
- Unit math: convert through `unit_conversions` only; mismatched units without a conversion row
  is a 409/validation error, not a silent assumption.
- Completing a count: `theoretical = ledger balance`, `variance = counted − theoretical`;
  one `count_adjustment` movement per line with `source_id = count id`.
- PO lifecycle: `draft → sent → received → closed`; receiving writes `receipt` movements per
  line (`received_quantity`), partial receives allowed until closed.

## API surface

Mounted after the tenant middlewares; workspace via header.

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/inventory/ingredients` · PATCH/DELETE `/{ingredientId}` | delete = archive if ever referenced by a movement |
| GET/POST | `/workspace/inventory/unit-conversions` · DELETE `/{id}` | |
| GET/POST | `/workspace/inventory/recipes` (per item) · GET/PATCH `/{recipeId}` | creates a new version; `?version=` history read |
| PUT | `/workspace/inventory/modifiers/{modifierId}/ingredients` | modifier depletion links |
| GET/POST | `/workspace/inventory/suppliers` · PATCH `/{supplierId}` | |
| GET/POST | `/workspace/inventory/purchase-orders` · GET `/{id}` · POST `/{id}/send` `/receive` `/close` `/cancel` | receive body carries per-line received quantities |
| GET | `/workspace/inventory/stock` | on-hand projection per ingredient (+ `?belowPar=true`) |
| GET/POST | `/workspace/inventory/counts` · POST `/{id}/complete` | complete body = counted lines; writes adjustments |
| POST | `/workspace/inventory/waste` | `{ ingredientId, quantity, unit, reason }` → `waste` movement |
| POST | `/workspace/inventory/adjustments` | manual movement with reason + permission |
| GET/PUT | `/workspace/inventory/par-levels` | |

## Services

`IngredientsService`, `RecipesService` (versioning), `SuppliersService`,
`PurchaseOrdersService`, `InventoryMovementsService` (the only writer of `stock_movements`;
exposes `recordMovement(...)` for other services/subscribers), `StockCountsService`.
Cross-aggregate note: `recordMovement` is the seam Phase 4's depletion subscriber calls —
keep it transaction-scoped (`DBExecutor`).

## Permissions

`inventory:read` (stock/counts/POs read), `inventory:ingredient:*`, `inventory:recipe:*`,
`inventory:supplier:*`, `inventory:purchase:*`, `inventory:count:*`, `inventory:waste:record`,
`inventory:adjust:*`. Waste and manual adjustments are the sensitive ones — grant to
`admin` only until Phase 7 tunes roles.

## Audit & events

`defineActivity`: `ingredientActivity`, `recipeActivity` (diff over lines via summarize),
`supplierActivity`, `purchaseOrderActivity` (status transitions in summary), `stockCountActivity`.
Movements themselves are *not* activity-logged (too chatty) — they are the event feed.

Events: emit `inventory.movement.recorded` (type, ingredient, qty) for projections; consume
(nothing yet — Phase 4 publishes `order.*` events that the depletion subscriber translates into
`recordMovement` calls; note this wiring in Phase 4).

## Testing plan

- Ledger math: receipts/depletions/waste/count adjustments sum correctly across units via
  conversions; unknown conversion → 400/409.
- Append-only enforcement (attempted update path rejected by service design; rollback removes
  movements with their transaction).
- Recipe versioning: old orders keep resolving against old costs.
- PO lifecycle incl. partial receive and close; count completion math (variance per line).
- Tenancy + permission rejections on every mutating route.
- Par-level report (`belowPar`) correctness.

## Definition of done

- [ ] Twelve tables migrated with the indexes above; movement ledger append-only.
- [ ] `InventoryMovementsService.recordMovement` is the single writer (reused later by Phase 4).
- [ ] Counts, waste, POs, recipes (versioned), modifier depletion links all operable via API.
- [ ] Stock on hand derives from movements (projection query), verified against a seeded ledger.
- [ ] Tests green (`bun run test`), typecheck clean, docs updated (`data-model`, `api`,
      product-scope status: Inventory & Recipes → **Built** — depletion wired in Phase 4).
