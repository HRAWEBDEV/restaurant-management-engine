# Restaurant Management Engine — Agent Guide

`restaurant-manager-api` is a Bun-native, multi-tenant HTTP API for restaurant operations
(catalog, floor, orders, kitchen, inventory, staff, payments, reporting). It is early-stage:
auth, organization, user, and workspace routes; the full tenancy schema (organizations,
workspaces, members, invitations, activity logs); services for those aggregates; and a
permissions scaffold exist. Member/invitation routes and most operational domain modules are
not built yet.

Design/scope lives in the docs — load them only when the task needs them:

- `docs/architecture.md` — layers, request lifecycle, source layout, dependencies, config.
- `docs/data-model.md` — identity/tenancy model, tables, invariants, known gaps.
- `docs/api.md` — API conventions and the wired endpoint catalog.
- `docs/product-scope.md` — full feature list and domain rules.
- `docs/testing.md` — how tests are written and run in this codebase.

## Commands

```bash
bun install            # install from bun.lock
bun run dev            # NODE_ENV=development bun run --watch --check ./src/index.ts
bun run typecheck      # bunx tsc --noEmit
bun run test           # test:setup (create/migrate/truncate test db) + bun test with envPreload
bun run db:generate    # diff schema -> drizzle/<timestamp>_<name>/
bun run db:migrate     # apply pending migrations
bun run auth:generate  # regenerate auth-schema.ts from the Better Auth config
```

- Verify with `bun run typecheck` before finishing any change.
- ALWAYS write tests for new or changed code that warrants them (routes, services, utils,
  schema behavior) — not as an afterthought. Run `bun run test` to verify they pass.
- After schema edits: `db:generate`, review the generated SQL, then `db:migrate`.
- Tests: `bun:test` only, colocated in `__tests__/` next to the code under test. Run tests
  via `bun run test` (never bare `bun test <file>` — it skips the preload and hits the dev
  database). Full rules: `docs/testing.md`.
- Never hand-edit generated artifacts: `drizzle/**`, `auth-schema.ts`.

## Layout

```
src/index.ts                  entrypoint: PORT check, requestId/cors/secureHeaders, apiV1, static, Bun.serve, shutdown
src/auth.ts                   betterAuth (Drizzle adapter, email/password, username + openAPI plugins)
src/db/connect.ts             Bun.SQL client + drizzle; exports db, DBExecutor, testConnection, closeConnection
src/db/schemas/*.ts           one file per table: table + Zod schemas + types
src/db/utils/trackChanges.ts  created_at / updated_at columns
src/middlewares/              authMiddleware (session -> context, 401 NOT_SIGNED_IN),
                              organizationMemberMiddleware (x-organization-id -> membership row),
                              workspaceRoleMiddleware (x-workspace-id -> workspace role; owners
                              get implicit admin) — wired, not consumed by routes yet
src/services/                 DB-access classes (organizations, workspaces, organization members,
                              users, ActivityLogger; AccountsService orchestrates organization +
                              default workspace)
src/utils/                    AuthContext helpers, tenant header helpers (organizationContext,
                              workspaceContext), error classes (InternalError, NotFoundError,
                              ForbiddenError, ConflictError), AssetStorage (save/remove files
                              under static/)
src/utils/roles-permissions/  per-role permission strings + checkLevelPermissions
src/utils/activityLoggerHelpers.ts  defineActivity / buildChanges / renderSummary audit helpers
src/utils/activityDefinitions.ts    per-entity audit definitions (organizationActivity, workspaceActivity)
src/v1/api/index.ts           /api/v1 router: health, /doc, /doc/ui, auth routes, auth guard,
                              organizations/users/workspaces routes, tenant middlewares, 404/onError
src/v1/api/routes/*.ts        route modules per domain (auth, organizations, users, workspaces wired)
static/                       served at /static/* (serveStatic); uploaded assets, not committed
src/v1/utils/apiErrorResponse.ts  errorResponseSchema + createErrorResponse
auth-schema.ts                Better Auth tables + user Zod schemas (generated)
```

## Code conventions

- Bun runtime, no bundler/ts-node. Relative imports without file extensions.
- Style: double quotes, semicolons, 2-space indent, trailing commas. Named functions,
  `export { ... }` and `export type { ... }` at the bottom of the file.
- TypeScript is strict with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions
  when a guard is reasonable.
- Always import `{ z }` from `@hono/zod-openapi`, never from `zod`, so schemas work in
  OpenAPI and support `.openapi({ example })`.
- Use `StatusCodes` from `http-status-codes` instead of numeric literals.

## Database conventions

- Tables: `snakeCase.table("plural_name", { camelCaseKey: uuid("snake_column") })` — camelCase
  in TypeScript, snake_case in SQL.
- Each schema file exports the table plus `selectXSchema`, `insertXSchema` (omit server-managed
  fields), `updateXSchema` (`pick` mutable fields), and `X` / `InsertX` types.
- Build Zod with `createSchemaFactory({ zodInstance: z })`; enum values as `as const` + `pgEnum`.
- Domain PKs are `uuid().defaultRandom()`; FKs to Better Auth users are `text` -> `user.id`.
- Use `...trackChanges` for `created_at`/`updated_at`, `timestamptz` elsewhere.
- Declare `onDelete` on every FK. Tenant integrity uses composite FKs on `(id, organization_id)`.
- Slugs are server-generated (`slugify` + `nanoid`); clients never send them.
- Domain schemas have no `relations()`; use explicit joins, not `db.query.*`.
- Money is integer minor units. Payments are an immutable ledger. Never store card data.

## API conventions

- Define the contract first: `createRoute({ method, path, tags, request, responses })`, then
  register with `router.openapi(route, handler)`.
- Document every status code, including errors, using `errorResponseSchema`.
- Read validated input via `c.req.valid("json" | "param" | "query" | "form")` (form for file
  uploads, e.g. the logo route).
- File uploads: multipart bodies with a `z.file().mime([...]).max(bytes)` field that needs an
  explicit `.openapi({ type: "string", format: "binary" })` for document generation; save via an
  `AssetStorage` instance configured per location (`subPath`, allowed MIME types, max size).
  `save` returns `{ ok: false, error }` for expected failures — map it to a 400 with
  `createErrorResponse`, and never let a failed removal of a replaced file fail the request.
- Errors: throw `NotFoundError` / `InternalError`, or return `createErrorResponse(...)` with a
  status. Unexpected errors are logged by the global `onError`.
- Auth: `getContextUser(c)` / `getContextSession(c)`, typed as `{ Variables: AuthContext }`.
  Take user ids from the session, never from the request body.
- Router order in `src/v1/api/index.ts` matters: public routes -> `/doc` -> auth routes ->
  `use(authMiddleware)` -> protected routes -> `notFound`/`onError` last.
- Sessions carry no tenant. Resolve organization/workspace from the request and authorize
  against `organization_members` / `workspace_members`; operational data hangs off `workspace_id`.

## Service conventions

- One class per aggregate, constructor `private readonly db: DBExecutor` so it works inside
  `db.transaction(...)`.
- Cross-aggregate flows (e.g. account setup) get an orchestration service that composes the
  aggregate services with the same db/transaction executor (`AccountsService` pattern).
- Export prop/response types and their schemas. Return DTO objects (`{ organizations }`) and
  `null` for missing rows instead of throwing. Lookup services used for authorization may
  return extra context (e.g. `getOrganizationById` also returns the caller's membership row) —
  prefer reusing that over a second query.
- Authorization, slug generation, and server-managed fields are decided in the route/service
  layer, not in Zod schemas.

## Domain rules that shape the code

- Tenancy: `user` -> `organization_members` -> `workspace_members`, with workspace
  membership requiring organization membership. Organization `owner` implicitly
  holds the workspace `admin` role on every workspace of its organization
  (owners are allowed to not be workspace members); organization `admin` may
  create workspaces (`workspace:create`) but has no implicit workspace access —
  workspace access comes from `workspace_members` rows.
- Account setup has two entry points, both via `AccountsService`: `POST /api/v1/auth/account`
  (public — signs the user up, then creates organization + default workspace + session cookies)
  and `POST /api/v1/organizations/account` (signed-in user). Both create the organization with
  the caller as `owner` and a default workspace (name defaults to the organization name) with
  the caller as workspace `admin`.
- Invitations: one pending row per `(organization_id, invited_user_email)` enforced by a partial
  unique index; terminal statuses are kept as history. No scheduler — expire lazily on read.
- Permissions: namespaced strings (`resource:action` / `resource:sub:action`) declared per role in
  `src/utils/roles-permissions/`. Two levels (organization, workspace) plus `organizationWorkspace`
  (either level grants). Check with `checkLevelPermissions(...)`, passing roles resolved from
  membership rows — never client input. Only `owner` (org) and `admin` (workspace) roles carry
  grants so far (`organizationPermissions` also keys `admin`/`member` with empty lists to match
  the `organization_roles` enum); only the organization update routes enforce them so far.
- Audit: every state change should write an append-only `activity_logs` row via `ActivityLogger`
  (constructed with the same transaction as the mutation), calling `recordChange(...)` with the
  entity's definition from `src/utils/activityDefinitions.ts` (e.g. `organizationActivity`),
  whose `diff` allowlist is declared with `defineActivity(...)`. Reports and tickets remain
  derived projections of domain events; event emission is not implemented yet.

## Known issues (fix only when touching that module)

- Duplicate `roleEnum` export in `organizationMembers.ts` and `workspaceMembers.ts`.
- Misspelled `upadteWorkspaceMemberSchema` in `workspaceMembers.ts`.
- `insertOrganizationInvitationSchema` is not narrowed (exposes `id`, `invitedBy`, `status`,
  `acceptedAt`, `createdAt`); the member insert schemas still expose `addedBy`. Narrow these at
  the route layer and always set `invitedBy`/`addedBy` from the session.
- Permissions enforcement is just starting: `checkLevelPermissions` is called in the organizations
  routes (`organization:update` on `PATCH /{id}` and `PUT /{id}/logo`, resolved from the caller's
  `organization_members` row) and in the workspaces route (`workspace:update` on `PATCH /{id}`,
  checked at `organizationWorkspace` level from both membership rows). The organization-scoped
  invitation routes enforce permissions declaratively via `requireLevelPermissions` route
  middleware (`organization:invitation:read`, `organization:member:invite`). No other route or
  service enforces permissions yet.
- Tenant context: `organizationMemberMiddleware` (resolves `x-organization-id`, sets
  `userOrganizationMember`) and `workspaceRoleMiddleware` (resolves `x-workspace-id`, sets
  `userWorkspaceMemberRole`; owners get an implicit `admin`) are wired in `src/v1/api/index.ts`
  after the currently mounted domains — only route mounts registered after those `use(...)` lines
  are guarded. The organization-scoped invitation routes are the first consumers, mounted between
  the two `use(...)` lines (tenant header but no workspace role); they address the organization
  only through the header, with no path param, so the header cannot disagree with the URL.
  When a route does carry an organization path param, the handler must verify it matches the
  header organization. `getContextWorkspaceRole` returns `undefined` when
  `workspaceRoleMiddleware` has not run. The order of the two middlewares
  matters: `workspaceRoleMiddleware` reads the membership row `organizationMemberMiddleware`
  sets.
- Workspace/member/invitation services exist but have no routes yet (auth, organizations, users,
  and workspaces are the wired domains). `ActivityLogger` is called from the organizations and
  workspaces services only; members and invitations write no audit rows yet.
- Domain tables lack `relations()` and several indexes (see `docs/data-model.md` § Known gaps).
- "At least one organization owner" is not enforced anywhere.
- Invitation acceptance is implemented in `OrganizationInvitationsService.acceptInvite`
  (case-insensitive email matching, "not already a member" check, membership insert via
  `OrganizationMembersService.addOrganizationMember`, `invitation.accepted` + `member.created`
  audit rows, all in one transaction) and exposed at
  `POST /organizations/{organizationId}/invitations/{invitationId}/accept` — mounted with the
  session-scoped invitation routes before the tenant middlewares (the invitee is usually not a
  member yet; no tenant header, the email match authorizes). The `email_verified` flag is not
  enforced; the accepter is matched by account email.

## Environment and runtime

- `.env` is gitignored and auto-loaded by Bun. Required keys: `PORT`, `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.
- Postgres via `DATABASE_URL`; drizzle-kit targets the `public` schema.
- Smoke check after `bun run dev`: `GET /api/v1/health`, OpenAPI at `/api/v1/doc`, UI at
  `/api/v1/doc/ui`.
- Do not add a new framework, runtime, ORM, or validation library; extend the existing stack.

## Task routing

- New table/column -> `src/db/schemas/<name>.ts`, then `bun run db:generate` + `db:migrate`.
- New endpoint -> `src/v1/api/routes/<domain>.ts` (contract + handler) + `src/services/<domain>Service.ts`,
  then mount it in `src/v1/api/index.ts` before `use(authMiddleware)` if it is public.
- New file upload location -> an `AssetStorage` instance in the route module (or service) with
  the appropriate `subPath`, MIME allowlist, and max size; assets must be removed when replaced.
- New error type -> a class in `src/utils/` with `code`, `name`, and `handle(c)`, registered in
  the `onError` chain.
- Tenancy/auth behavior -> check `docs/data-model.md` before changing anything.

## Working agreements

- Follow the patterns above instead of introducing alternatives; keep diffs focused.
- Update the relevant `docs/*.md` when schema, API shape, or tenancy behavior changes.
- Do not commit unless asked.
- Commit/push workflow (follow this sequence exactly):
  1. When the user says "now commit the changes", draft a good commit message
     (concise, imperative mood, matching the repo's commit style) and present it
     to the user. Do NOT commit yet.
  2. Commit only after the user confirms the message (or approves an adjusted
     version). If the user dictates their own message, use it verbatim.
  3. Push only when the user explicitly says to push. Never push unprompted.
