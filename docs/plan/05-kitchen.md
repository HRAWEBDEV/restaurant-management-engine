# Phase 5 — Kitchen

Status: **planned** · Depends on: Phases 1, 4 · Milestone: **M6 — kitchen flow (first end-to-end service)**

## Goal

Turn fired order events into kitchen tickets, route them to stations, and give a KDS (kitchen
display) client the queue → preparing → ready → served flow with item bumping, recall, and
prep timers. Kitchen is a **projection + reaction** domain: it owns no pricing and never
mutates orders — it consumes order events and emits its own for floor/reporting.

## Dependencies

- Phase 4 (order events to consume; line items to mirror).
- Phase 1 (`kitchen_stations` table already exists; items carry a `station_id`).

## Data model — new files in `src/db/schemas/`

| File | Table | Key columns |
| --- | --- | --- |
| `kitchenTickets.ts` | `kitchen_tickets` | `workspace_id`, `order_id` FK, `course_id` FK nullable, `table_id` nullable, `state` enum `queued|preparing|ready|served|recalled`, `source_event_id` (event id — dedupe key), `created_at` |
| `kitchenTicketItems.ts` | `kitchen_ticket_items` | `ticket_id` FK, `line_item_id` FK, `station_id` FK, `state` enum `queued|preparing|ready|voided`, `started_at`, `bumped_at` |
| `ticketItemTransitions.ts` | `ticket_item_transitions` | **append-only**; `ticket_item_id`, `from_state`, `to_state`, `actor_user_id`, `created_at` — the timing record for reporting (scope 52) |

Unique: `(workspace_id, source_event_id)` per ticket-source pair — event replays never
duplicate tickets. Items route by their item's `station_id`; null station → default station
(first by position) or a catch-all "expo" station created per workspace on first use.

## Behavior

- **Ticket generation** (scope 45–46): subscriber on `order.course.fired` creates one ticket
  per station touched by the course's items (items grouped by station); subscriber on
  `order.item.voided` flips matching ticket items to `voided` (or removes if not started).
- **State flow**: item `queued → preparing (started_at) → ready (bumped_at)`; ticket state is
  derived from its items (all ready → ready). `served` is a ticket-level terminal bump;
  `recalled` reopens a recently served ticket (scope 49) — allowed within a configurable
  window, writes a transition row.
- **Expediting** (scope 50): the queue read orders tickets oldest-first, long-waiting items
  flagged with elapsed time per item state.
- **Reprint/re-route** (scope 51): re-route moves a ticket item to another station (with
  transition row); reprint re-emits `kitchen.ticket.updated` for print-channel subscribers.

## API surface

Mounted after the tenant middlewares. KDS clients poll; no realtime transport yet (Phase 9
decides websockets/SSE).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/workspace/kitchen/tickets?stationId=&state=` | queue/expedite read: tickets + items + elapsed times |
| POST | `/workspace/kitchen/tickets/{ticketId}/start` | ticket-level preparing |
| POST | `/workspace/kitchen/tickets/{ticketId}/bump` | ticket ready/served |
| POST | `/workspace/kitchen/tickets/{ticketId}/recall` | window-checked reopen |
| POST | `/workspace/kitchen/tickets/{ticketId}/items/{itemId}/start` `/bump` | item-level flow |
| POST | `/workspace/kitchen/tickets/{ticketId}/items/{itemId}/reroute` | `{ stationId }` |
| PATCH | `/workspace/catalog/stations/{stationId}` | extend the Phase 1 station routes in place with routing/default flags — kitchen adds no second station management surface |

## Services

`KitchenTicketsService` (creation from events with dedupe, state flow, recall),
`KitchenStationsService` (extends the Phase 1 station service with routing/default-station
resolution). Subscribers live in `src/events/subscribers/kitchen.ts`.

## Permissions

`kitchen:read` (queue), `kitchen:ticket:bump` (start/bump/recall — operational members get this),
`kitchen:ticket:reroute`, `kitchen:station:*`. Ticket mutations are permission-checked like
any route; event-driven creation bypasses HTTP permissions (it runs in-process under the
original actor's transaction).

## Audit & events

`defineActivity`: `kitchenTicketActivity` (state transitions summarized; item churn rides the
event stream). Emitted: `kitchen.ticket.created/updated/ready/served/recalled` — Phase 8 reads
timings from `ticket_item_transitions`; a future floor integration flips table state to
"food ready" from `kitchen.ticket.ready`.

## Testing plan

- Event-driven creation: fire a course → correct per-station tickets; replay the same event →
  no duplicates (dedupe key).
- Void propagation from order events.
- Item/ticket state matrix incl. recall window edges; transition rows on every change.
- Reroute + default-station fallback.
- Queue read ordering + elapsed-time math.
- Tenancy + permission rejections on routes.

## Definition of done

- [ ] Three tables migrated with dedupe + history indexes.
- [ ] Fired courses reliably produce routed tickets; voids propagate.
- [ ] KDS flow (queue → start → bump → recall) operable with timers recorded.
- [ ] Tests green, typecheck clean; docs updated (Kitchen → **Built**; end-to-end demo:
      seat → order → fire → bump → ready recorded in `product-scope.md`).
