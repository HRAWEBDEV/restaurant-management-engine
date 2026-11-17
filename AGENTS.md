# Restaurant Management Engine — Agent Guide

`restaurant-manager-api` is a Bun-native, multi-tenant HTTP API for restaurant operations
(catalog, floor, orders, kitchen, inventory, staff, payments, reporting). It is early-stage:
auth + tenancy schema/routes exist; most operational domain modules are not built yet.

Design/scope lives in the docs — load them only when the task needs them:

- `docs/user_space.md` — identity/tenancy model, tables, invariants, known gaps.
- `docs/restaurant_management.md` — full feature list and domain rules.
- `docs/tech_stack.md` — declared stack, package roles, scripts.

## Commands

```bash
bun install            # install from bun.lock
bun run dev            # NODE_ENV=development bun run --watch --check ./src/index.ts
bun run typecheck      # bunx tsc --noEmit
bun run db:generate    # diff schema -> drizzle/<timestamp>_<name>/
bun run db:migrate     # apply pending migrations
bun run auth:generate  # regenerate auth-schema.ts from the Better Auth config
```

- Verify with `bun run typecheck` before finishing any change.
- After schema edits: `db:generate`, review the generated SQL, then `db:migrate`.
- No test script exists yet. If tests are needed, use `bun test` (`bun:test`) and add a script.
- Never hand-edit generated artifacts: `drizzle/**`, `auth-schema.ts`.

## Layout

```
src/index.ts                  entrypoint: PORT check, requestId/cors/secureHeaders, apiV1, static, Bun.serve, shutdown
src/auth.ts                   betterAuth (Drizzle adapter, email/password, username + openAPI plugins)
src/db/connect.ts             Bun.SQL client + drizzle; exports db, DBExecutor, testConnection, closeConnection
src/db/schemas/*.ts           one file per table: table + Zod schemas + types
src/db/utils/trackChanges.ts  created_at / updated_at columns
src/middlewares/              authMiddleware (session -> context, 401 NOT_SIGNED_IN)
src/services/                 DB-access classes (e.g. OrganizationsService)
src/utils/                    AuthContext helpers, InternalError, NotFoundError
src/v1/api/index.ts           /api/v1 router: health, /doc, /doc/ui, auth routes, auth guard, 404/onError
src/v1/api/routes/*.ts        route modules per domain
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
- Read validated input via `c.req.valid("json" | "param" | "query")`.
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
- Export prop/response types and their schemas. Return DTO objects (`{ organizations }`) and
  `null` for missing rows instead of throwing.
- Authorization, slug generation, and server-managed fields are decided in the route/service
  layer, not in Zod schemas.

## Domain rules that shape the code

- Tenancy: `user` -> `organization_members` -> `workspace_members`, with workspace membership
  requiring organization membership. `owner`/`admin` implicitly access all org workspaces.
- Invitations: one pending row per `(organization_id, invited_user_email)` enforced by a partial
  unique index; terminal statuses are kept as history. No scheduler — expire lazily on read.
- Per the docs, reports and tickets are derived projections of domain events, and every state
  change emits an event plus an append-only audit entry. Design new modules with that in mind.

## Known issues (fix only when touching that module)

- Duplicate `roleEnum` export in `organizationMembers.ts` and `workspaceMembers.ts`.
- Misspelled `upadteWorkspaceMemberSchema` in `workspaceMembers.ts`.
- Some insert schemas expose server-managed fields (`status`, `invitedBy`, `addedBy`,
  `role: "owner"`) — narrow them at the route layer.
- Domain tables lack `relations()` and several indexes (see `docs/user_space.md` § Known gaps).
- "At least one organization owner" is not enforced anywhere.
- `insertOrganizationInvitationSchema` is not narrowed; invitation acceptance still needs
  verified-email matching and a "not already a member" check in the service.

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
- New error type -> a class in `src/utils/` with `code`, `name`, and `handle(c)`, registered in
  the `onError` chain.
- Tenancy/auth behavior -> check `docs/user_space.md` before changing anything.

## Working agreements

- Follow the patterns above instead of introducing alternatives; keep diffs focused.
- Update the relevant `docs/*.md` when schema, API shape, or tenancy behavior changes.
- Do not commit unless asked.
