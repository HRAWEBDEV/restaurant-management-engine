# Phase 1 — Catalog (Menu & Items)

Status: **planned** · Depends on: Phase 0 · Milestone: **M2 — menu managed**

## Goal

The back-office backbone: everything a restaurant needs to describe *what it sells* —
categories, items, variants, modifier groups, tax classes, availability windows, images,
kitchen stations, and the 86 (sold-out) switch. Every later domain (orders, kitchen, inventory,
reports) reads from this.

## Dependencies

- Phase 0 (tenant middlewares consumed, permission catalog, events, workspace settings).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `catalogCategories.ts` | `catalog_categories` | `workspace_id` FK, `name`, `description`, `position` int, `is_active` bool |
| `taxClasses.ts` | `tax_classes` | `workspace_id`, `name`, `rate` integer **basis points** (e.g. 825 = 8.25%), `is_default` bool (one per workspace) |
| `kitchenStations.ts` | `kitchen_stations` | `workspace_id`, `name`, `position` (simple now; routing rules extend in Phase 5) |
| `menuItems.ts` | `menu_items` | `workspace_id`, `category_id` FK nullable, `name`, `description`, `image` (AssetStorage path), `base_price` int minor units ≥ 0, `tax_class_id` FK (null → workspace default), `station_id` FK nullable, `is_active`, `is_sold_out`, `sold_out_until` timestamptz nullable, `position` |
| `itemVariants.ts` | `item_variants` | `menu_item_id` FK, `name` ("Large"), `price_delta` int (signed) or absolute — **decide: signed delta** (keeps variant math additive), `is_default` bool, `position` |
| `modifierGroups.ts` | `modifier_groups` | `workspace_id`, `name`, `min_selects` int ≥ 0, `max_selects` int (null = unlimited), `is_required` = `min_selects > 0` (derived, not stored) |
| `modifiers.ts` | `modifiers` | `modifier_group_id` FK, `name`, `price_delta` int, `position`, `is_active` |
| `itemModifierGroups.ts` | `item_modifier_groups` | `menu_item_id` + `modifier_group_id` FK pair, `position` — attach groups to items |
| `modifierGroupNesting.ts` | `modifier_group_nesting` | `parent_group_id` + `child_group_id` FKs, `position` — nested groups |
| `availabilityWindows.ts` | `availability_windows` | `menu_item_id` FK, `days_of_week` int array (0–6), `start_time` / `end_time` time, `effective_from` / `effective_until` date nullable |

Conventions: `trackChanges` on mutable aggregates; enums via `pgEnum` where a fixed set exists
(none forced here); every table indexed on `workspace_id`; unique `(workspace_id, name)` per
name-space table (categories, tax classes, stations) and `(menu_item_id, name)` for variants.

**Deliberate decision:** menu data is **workspace-local** (no org-level shared catalog yet).
Per-workspace price overrides are deferred (see plan § Decisions).

## Invariants & rules

- `base_price` is ≥ 0; price deltas (variant and modifier) are signed and **may be negative**
  (e.g. "no onions" −$0.50) — but a resolved item price is always clamped to ≥ 0, checked at
  resolution time.
- `min_selects ≤ max_selects` on modifier groups; nesting depth ≤ 3 (service-enforced) to keep
  resolution tractable; a group cannot nest itself (cycle check on write).
- A modifier's price delta is **additive** to the item/variant price; variant delta applies
  first, then modifiers.
- **Resolve final price deterministically** (scope item 7): variant delta + modifier deltas,
  server-side, always — the client never sends prices.
- Availability resolution: item is orderable if `is_active`, not 86'd
  (`is_sold_out` and (`sold_out_until` is null or `sold_out_until > now()`)), and *now* falls in
  at least one window (or the item has no windows, meaning always available).
- **Archive, don't delete:** items/categories referenced by future orders must be archived
  (`is_active = false`). Hard delete is only allowed for rows never referenced — enforce in
  service; Phase 4 adds the "referenced" check.
- Day-of-week and time windows are interpreted in the workspace timezone (Phase 0 settings).

## API surface

All mounted **after** the tenant middlewares (`x-workspace-id` required). Base path
`/api/v1/workspace/catalog/...` (workspace addressed by header only, mirroring the invitation
routes' pattern).

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/catalog/categories` · PATCH/DELETE `/{categoryId}` | DELETE = archive; `PATCH /reorder` for positions |
| GET/POST | `/workspace/catalog/items` · GET/PATCH/DELETE `/{itemId}` | DELETE = archive; list supports `?categoryId=&active=&q=` pagination |
| PUT | `/workspace/catalog/items/{itemId}/image` | multipart via `AssetStorage` (`subPath: workspaces/{id}/items`), replaces + removes old file |
| GET/POST | `/workspace/catalog/items/{itemId}/variants` · PATCH/DELETE `/{variantId}` | |
| GET/POST | `/workspace/catalog/modifier-groups` · PATCH/DELETE `/{groupId}` | DELETE archives |
| POST/DELETE | `/workspace/catalog/modifier-groups/{groupId}/modifiers` · PATCH/DELETE `/{modifierId}` | |
| POST/DELETE | `/workspace/catalog/items/{itemId}/modifier-groups` | attach/detach with position |
| POST/DELETE | `/workspace/catalog/modifier-groups/{groupId}/children` | nest groups |
| GET/POST | `/workspace/catalog/tax-classes` · PATCH/DELETE `/{taxClassId}` | deleting the default reassigns |
| GET/POST | `/workspace/catalog/items/{itemId}/availability` · DELETE `/{windowId}` | |
| GET/POST | `/workspace/catalog/stations` · PATCH/DELETE `/{stationId}` | |
| POST | `/workspace/catalog/items/{itemId}/sold-out` · DELETE `.../sold-out` | 86 on (optional `until` in body) / off; emits event |
| GET | `/workspace/catalog/menu` | **Composite POS read**: active categories → items → variants → resolved modifier trees, availability-filtered for the current time; this is the endpoint POS clients poll |

Errors: 403 (permission), 404 (not in this workspace), 409 (unique name, cycle, min>max,
archive blocked once referenced later).

## Services

`src/services/`:

- `CatalogCategoriesService`, `MenuItemsService` (CRUD, archive, image, 86, availability
  resolution, composite `getPosMenu` read), `ModifierGroupsService` (groups, modifiers,
  nesting with cycle check), `TaxClassesService`, `KitchenStationsService`.
- All take `private readonly db: DBExecutor`; mutations run in `db.transaction` with the
  `ActivityLogger` + event publisher on the same executor.
- Pure helper `resolveItemPrice(item, variant, selectedModifiers)` in `src/services/catalog/`
  (unit-tested exhaustively; reused by Phase 4 order validation).

## Permissions

`catalog:read` for all GETs; `catalog:category:*`, `catalog:item:*`, `catalog:modifier:*`,
`catalog:tax:*`, `catalog:availability:*`, `catalog:station:*` for mutations; 86 toggle needs
`catalog:item:update`. Enforce via `requireLevelPermissions` at `organizationWorkspace` level
(org owners and workspace admins manage menus; grant `catalog:read` + item-add/update to
workspace `member` when tuned).

## Audit & events

`defineActivity` definitions: `catalogCategoryActivity`, `menuItemActivity` (diff over name,
price, description, availability, active/sold-out flags), `modifierGroupActivity`,
`taxClassActivity`. Actions: `created`, `updated`, `archived`, `sold_out`, `restocked`.

Domain events (Phase 0 bus): `catalog.item.created`, `catalog.item.updated`,
`catalog.item.archived`, `catalog.item.sold_out`, `catalog.item.restocked` — sold-out/restocked
are the **86 propagation** hooks that push to ordering channels (scope items 10–11) in Phase 9.

## Testing plan

- Route-level: tenancy (wrong workspace header → 403/404), permission rejections, validation
  errors, full CRUD happy paths, image replace/remove behavior.
- Price resolution table tests: variant + nested modifiers + availability edge cases (boundary
  times, day windows, effective dates), 86 expiry (`sold_out_until`).
- Cycle/nesting limits, `min_selects ≤ max_selects`, unique-name conflicts.
- Composite `GET /menu` shape stability (POS clients depend on it).
- Events: sold-out/restocked rows land in `domain_events` on the same transaction.

## Definition of done

- [ ] Ten tables above generated, migrated, indexed; `selectX`/`insertX`/`updateX` schemas
      narrowed (server-managed fields omitted).
- [ ] All routes mounted after the tenant middlewares; every mutation permission-checked.
- [ ] `resolveItemPrice` extracted and unit-tested; composite menu endpoint serves a full tree.
- [ ] 86 with auto-expiry works and emits events.
- [ ] Archive-only deletion enforced.
- [ ] Colocated tests pass via `bun run test`; `bun run typecheck` clean.
- [ ] `docs/data-model.md` (tables), `docs/api.md` (catalog), `docs/product-scope.md` status
      table updated (Catalog → **Built**).
