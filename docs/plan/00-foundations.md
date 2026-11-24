# Phase 0 — Foundations Hardening

Status: **ready to start** · Depends on: nothing · Milestone: **M1 — hardened platform**

## Goal

Before the first operational domain lands, make the tenant/permission/event machinery the
default path for everything that follows, and pay down the known gaps recorded in
`docs/data-model.md` § Known gaps. Every later phase assumes this phase's mechanics exist.

## Dependencies

None — works on the existing codebase only.

## Work items

### 1. Consume the tenant middlewares on every future mount

- Decide the final mount policy and enforce it in review: **all** workspace-scoped domain
  routes are registered after both
  `use(organizationMemberMiddleware)` and `use(workspaceRoleMiddleware)` in
  `src/v1/api/index.ts`; organization-scoped (no workspace) routes go between the two
  `use(...)` lines; only truly session-scoped routes (invitations inbox, accept) stay before.
- Add a short comment block in `src/v1/api/index.ts` documenting the three zones (public /
  organization-scoped / workspace-scoped) so the next mount lands in the right zone.

### 2. Handler context helpers

- Add to `src/utils/` (next to `organizationContext` / `workspaceContext`):
  - `requireWorkspaceContext(c)` — returns `{ workspaceId, organizationMember, workspaceRole }`
    or throws `ForbiddenError` when `workspaceRoleMiddleware` has not run; handlers use this
    instead of re-reading headers.
  - A guard that, when a route carries an organization id **path param**, verifies it matches
    the header organization (mismatch → `ForbiddenError`) — this closes the disagreement case
    called out in `AGENTS.md` § Known issues.

Declarative permission middleware already exists: `requireLevelPermissions({ level, permission })`
lives in `src/middlewares/requireLevelPermissions.ts` (with tests), resolves roles from the
context membership rows the tenant middlewares set, and supports organization, workspace, and
`organizationWorkspace` levels. Reuse it everywhere — do not rebuild it.

### 3. Permission catalog — pre-declare every domain's strings

Extend `src/utils/roles-permissions/` with the full permission vocabulary the later phases
will consume (grant them only to `admin` roles today; tune `member` grants per phase as
domains land). Names follow the existing `resource:action` / `resource:sub:action` style:

| Domain | Permission strings (readers shown; `:create`/`:update`/`:delete` variants implied per resource) |
| --- | --- |
| catalog | `catalog:read`, `catalog:category:*`, `catalog:item:*`, `catalog:modifier:*`, `catalog:tax:*`, `catalog:availability:*`, `catalog:price:update`, `catalog:station:*` |
| inventory | `inventory:read`, `inventory:ingredient:*`, `inventory:recipe:*`, `inventory:supplier:*`, `inventory:purchase:*`, `inventory:count:*`, `inventory:waste:record`, `inventory:adjust:*` |
| floor | `floor:read`, `floor:section:*`, `floor:table:*`, `floor:reservation:*` |
| orders | `order:read`, `order:create`, `order:edit`, `order:item:add`, `order:item:void`, `order:item:comp`, `order:discount:apply`, `order:check:*`, `order:cancel` |
| kitchen | `kitchen:read`, `kitchen:ticket:bump`, `kitchen:ticket:recall`, `kitchen:ticket:reroute`, `kitchen:station:*` |
| payments | `payment:read`, `payment:capture`, `payment:refund`, `payment:void`, `payment:drawer:*`, `payment:eod:close` |
| staff | `staff:read`, `staff:manage`, `labor:clock`, `labor:schedule:*`, `labor:tips:*` |
| reports | `report:read` |

Declare them now (even with empty grants) so no phase invents ad-hoc strings. Test the checking
*behavior* (`checkLevelPermissions` / `requireLevelPermissions`) with role inputs derived from
the catalogs — never assert the in-progress grant lists themselves (`docs/testing.md` § 2).

### 4. DB gap pay-down (from `docs/data-model.md` § Known gaps)

- Add the missing indexes: `organization_members (user_id)`,
  `organization_invitations (invited_user_email, status)`, `organization_invitations (invited_by)`,
  `workspaces (organization_id)`, `workspace_members (workspace_id)`,
  `workspace_members (organization_id)`.
- Decide and implement the **owner invariant**: an organization must keep at least one `owner`
  (service-level check on role update/removal/transfer; transfer-ownership endpoint optional).
- No work left on the schema-export cleanups — the `organizationRoleEnum`/`workspaceRoleEnum`
  renames, the `updateWorkspaceMemberSchema` spelling fix, and the narrowed invitation/member
  insert schemas already landed.

### 5. Domain events scaffold

- `src/events/`: typed `DomainEvent { id, seq, workspaceId, type, payload, actor, occurredAt }`,
  an in-process publisher (`publish(event)`), and a subscriber registry (`subscribe(type, fn)`).
  Keep it dumb — no queue, no outbox yet.
- New `domain_events` table (`src/db/schemas/domainEvents.ts`): append-only,
  `bigserial` seq ordering key, `workspace_id` FK, `organization_id` FK, `type` varchar,
  `payload` jsonb, `actor_user_id` (nullable), `occurred_at` timestamptz, indexed on
  `(workspace_id, seq)` and `(type, seq)`. Written **on the mutation's transaction**, mirroring
  `ActivityLogger` usage.
- Relationship to `activity_logs`: audit = human-readable, diff-rendered; events = machine
  payloads for projections (kitchen tickets, depletion, reports). Both are written by the same
  mutation. Document this split in `docs/data-model.md`.

### 6. Workspace settings for money & time

- Extend `workspaces` (or add a 1:1 `workspace_settings` table — prefer columns on `workspaces`
  for now): `currency` (varchar 3, ISO-4217, default `USD`), `timezone` (IANA name, default
  `UTC`), `business_day_boundary` (time-of-day, default `00:00`). Orders, payments, EOD close,
  and reporting all read these instead of hardcoding.

### 7. Test factories

- Extend the existing `src/db/__tests__/helpers/factories.ts` (the shared-helpers location per
  `docs/testing.md`) with bundle helpers that create
  `{ user, organization, workspace, organizationMember, workspaceMember, cookieJar }` in one
  call, so every domain test can arrange tenancy — including an authenticated request — without
  boilerplate. Refactor existing tests to use them where trivial.

## Audit & events

- New `defineActivity` definitions: `workspaceActivity` gains currency/timezone fields if
  settings land as columns; no other audit changes.
- First consumer of `domain_events` is Phase 1 (catalog events); the scaffold ships with a
  self-test (publish → row visible) instead of a domain consumer.

## API surface

- Possibly one new endpoint if ownership transfer is implemented:
  `POST /organizations/{id}/transfer-ownership` (owner-only). Otherwise no new endpoints — this
  phase is machinery, not surface.

## Testing plan

- Tenant middleware zones: a route mounted after the middlewares 401s/403s appropriately and
  receives populated context.
- `requireWorkspaceContext` throws without the middleware, matches path-param organization ids.
- Permission behavior tests: `checkLevelPermissions` / `requireLevelPermissions` with role inputs
  derived from the catalogs (never assertions on the WIP grant lists).
- `domain_events` insertion on a sample transactional service; rollback removes the event row.
- Workspace settings validation (currency format, timezone accepted by `Intl`).
- Factories round-trip in a real test file.

## Definition of done

- [ ] All future-mount zones documented in `src/v1/api/index.ts`; `requireWorkspaceContext` and
      the path-param guard available (`requireLevelPermissions` already exists — reuse it).
- [ ] Permission catalog declared for all eight domains, with behavior tests derived from it.
- [ ] Remaining `docs/data-model.md` § Known gaps closed: missing indexes added, the
      at-least-one-owner invariant enforced.
- [ ] `domain_events` table migrated; scaffold published/subscribe works in a transaction test.
- [ ] Workspace currency/timezone/business-day settings exist and are validated.
- [ ] Test factories exist and are used by at least one existing suite.
- [ ] `bun run typecheck` and `bun run test` pass; `docs/data-model.md` / `docs/api.md` updated.
