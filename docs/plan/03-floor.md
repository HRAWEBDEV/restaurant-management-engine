# Phase 3 — Floor

Status: **planned** · Depends on: Phase 0 (independent of Phases 1–2) · Milestone: **M4 — floor operable**

## Goal

Model the physical dining room: sections, tables with a live state, a saved layout, and
reservations. Orders (Phase 4) attach to tables; the table state machine is driven by order
and payment events from Phase 4/6.

## Dependencies

- Phase 0 only. Can be built in parallel with Phases 1–2 (swap freely if a floor demo is
  wanted sooner).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `sections.ts` | `sections` | `workspace_id`, `name`, `position`, `is_active` |
| `tables.ts` | `tables` | `workspace_id`, `section_id` FK nullable, `name`/`number` varchar unique per workspace, `seat_count` int > 0, `state` enum `free|seated|ordered|bill_requested|dirty`, `pos_x`/`pos_y` ints (layout), `merged_into_id` self-FK nullable (see merge), `is_active` |
| `tableStateHistory.ts` | `table_state_history` | **append-only**; `table_id`, `from_state`, `to_state`, `reason`, `actor_user_id`, `order_id` nullable, `created_at` — feeds turn-time reporting (scope item 25) |
| `reservations.ts` | `reservations` | `workspace_id`, `guest_name`, `guest_phone`, `party_size` int > 0, `scheduled_for` timestamptz, `status` enum `pending|confirmed|seated|cancelled|no_show`, `table_id` FK nullable (assign later), `notes`, `created_by` |

Tenancy: all workspace-scoped; unique `(workspace_id, name)` on tables and sections.

### Table state machine

```
free ──seat──> seated ──first order placed──> ordered ──bill requested──> bill_requested
   ^                                                                 │ payment settled (Phase 6)
   │                                                                 v
 dirty <─────bussed/cleaned──────────────────────────────────────── dirty
```

- Transitions are performed by routes (`POST .../tables/{id}/state { to, reason }`) or by
  domain events (order placed → `ordered`; payment settled → `dirty`); the service validates
  legality, illegal transition → 409.
- Every transition writes a `table_state_history` row. `seated → free` (walk-out) requires a
  reason and permission.

### Merge / split

- Merge: set `merged_into_id` on the child tables (parent keeps its row; children must be
  `free` or in the same order). Split: clear the FKs. Both write history rows with reasons.
- A table with `merged_into_id` set is hidden from the floor grid read and cannot be seated.

## API surface

Mounted after the tenant middlewares.

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/workspace/floor/sections` · PATCH/DELETE `/{sectionId}` | archive on delete |
| GET/POST | `/workspace/floor/tables` · GET/PATCH/DELETE `/{tableId}` | PATCH covers name/seats/section/position/layout |
| PUT | `/workspace/floor/layout` | bulk save of `pos_x/pos_y` per table |
| POST | `/workspace/floor/tables/{tableId}/state` | `{ to, reason? }`; illegal → 409 |
| POST | `/workspace/floor/tables/{tableId}/seat` | walk-in seat: `{ partySize }` → `seated` |
| POST | `/workspace/floor/tables/{tableId}/merge` · `/split` | body: child table ids / none |
| GET | `/workspace/floor` | floor grid: sections → tables (with state, current order id once Phase 4 lands), hides merged children |
| GET/POST | `/workspace/floor/reservations` · GET/PATCH/DELETE `/{reservationId}` | status transitions via PATCH (`confirm`, `cancel`, `no_show`) |
| POST | `/workspace/floor/reservations/{id}/seat` | validates table capacity ≥ party size (warnable, overridable with reason) |

## Services

`SectionsService`, `TablesService` (CRUD, layout, state machine, merge/split),
`ReservationsService`. Server-to-section assignment and turn-time metrics are deferred —
assignment lands with Phase 7 (staff), turn-time is a Phase 8 read over
`table_state_history`.

## Permissions

`floor:read` (grid/reservations), `floor:section:*`, `floor:table:*` (includes state
transitions and merge/split), `floor:reservation:*`. Seating/transition actions should be
granted to operational `member` roles when Phase 7 tunes grants.

## Audit & events

`defineActivity`: `sectionActivity`, `tableActivity` (diff over name/seats/section + state in
summary), `reservationActivity`. `tableStateHistory` is the per-transition record (not
activity-logged separately).

Events emitted: `floor.table.seated`, `floor.table.state_changed`,
`floor.reservation.created/confirmed/seated/cancelled`. Consumed: `payment.settled` (Phase 6)
→ `dirty`; `order.placed` (Phase 4) → `ordered`.

## Testing plan

- Full state-machine matrix: every legal transition passes, every illegal one 409s, history
  rows written for each.
- Merge/split invariants (capacity, hiding children, cannot seat merged table).
- Reservation lifecycle incl. seat-with-assignment and capacity override path.
- Tenancy/permission rejections; layout bulk save; grid read shape.
- Event consumers tested in Phase 4/6 when they land.

## Definition of done

- [ ] Four tables migrated; state history append-only.
- [ ] State machine enforced service-side with history + events on each transition.
- [ ] Floor grid, walk-in seating, reservations (confirm/cancel/no-show/seat) all live.
- [ ] Tests green, typecheck clean; docs (`data-model`, `api`, `product-scope` status: Floor →
      **Built**) updated.
