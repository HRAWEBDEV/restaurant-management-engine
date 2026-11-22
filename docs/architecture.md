# Architecture

`restaurant-manager-api` is a layered TypeScript service on the Bun runtime:

```
Client
  │  HTTP (JSON, multipart for uploads)
  ▼
Bun.serve  ──  src/index.ts (requestId, CORS, secure headers, static assets, shutdown hooks)
  ▼
Hono app (OpenAPIHono)  ──  @hono/zod-openapi route definitions (contract + validation)
  │                        @hono/swagger-ui  →  /api/v1/doc (document) and /api/v1/doc/ui
  │                        http-status-codes →  named status constants
  ▼
Middleware chain  ──  authMiddleware (Better Auth session) → tenant middlewares
  ▼
Route handlers  ──  validate input, resolve the session user, authorize, call services
  ▼
Services  ──  one class per aggregate; slugs via slugify + nanoid; ActivityLogger for audit
  ▼
Drizzle ORM (bun-sql driver)  ──  schema, queries, transactions
  ▼
Postgres (DATABASE_URL)
```

## Request lifecycle

1. `src/index.ts` checks `PORT` at startup, mounts requestId/CORS/secure-headers, mounts
   `apiV1Routes` at root, serves `static/*`, then `Bun.serve`s the app. It verifies the database
   with `testConnection()` first and closes the SQL pool on SIGINT/SIGTERM (`stopApp`).
2. Hono middleware resolves the Better Auth session (cookie or bearer token) and attaches the user
   and session to the request context (`AuthContext` variables).
3. An `@hono/zod-openapi` route validates params, query, JSON body, or form data, then runs the
   handler.
4. The handler takes user ids from the session context, authorizes via membership rows /
   `checkLevelPermissions`, and calls an aggregate service, which uses Drizzle to read/write
   Postgres (audit rows written on the same transaction).
5. Responses are serialized against the route's response schema; thrown domain errors
   (`NotFoundError`, `ForbiddenError`, `ConflictError`) are rendered by the global `onError` chain;
   unexpected errors are logged and returned as `INTERNAL_SERVER_ERROR`.

## Source layout

```
src/
├── index.ts                     entrypoint: PORT check, requestId/cors/secureHeaders, static,
│                                Bun.serve, SIGINT/SIGTERM shutdown
├── auth.ts                      betterAuth instance (Drizzle adapter, email/password,
│                                username + openAPI plugins, firstName/lastName additional
│                                fields, 24h sessions refreshed after 5m)
├── db/
│   ├── connect.ts               Bun.SQL client + drizzle (pool max 20); exports db, DBExecutor,
│   │                            testConnection, closeConnection
│   ├── schemas/                 one file per table (see docs/data-model.md)
│   ├── utils/trackChanges.ts    shared created_at/updated_at columns
│   └── __tests__/               DB test harness: setupDb.ts, helpers/db.ts,
│                                helpers/envPreload.ts, helpers/factories.ts
├── middlewares/
│   ├── authMiddleware.ts        session -> context user/session, 401 NOT_SIGNED_IN
│   ├── organizationMemberMiddleware.ts  x-organization-id header -> membership row on context
│   └── workspaceRoleMiddleware.ts       x-workspace-id header -> workspace role on context
├── services/                    DB-access classes (organizations, workspaces, organization
│                                members, users, activity logger, accounts orchestrator)
├── utils/
│   ├── AuthContext.ts           context user/session accessors + AuthContext type
│   ├── organizationContext.ts   x-organization-id header helpers
│   ├── workspaceContext.ts      x-workspace-id header helpers
│   ├── activityLoggerHelpers.ts defineActivity / buildChanges / renderSummary
│   ├── activityDefinitions.ts   per-entity audit definitions (organizationActivity,
│   │                            workspaceActivity)
│   ├── assetStorage.ts          AssetStorage: save/remove files under static/<subPath>
│   ├── ConflictError.ts         409 CONFLICT
│   ├── ForbiddenError.ts        403 FORBIDDEN
│   ├── InternalError.ts         500 INTERNAL_SERVER_ERROR
│   ├── NotFoundError.ts         404 NOT_FOUND
│   └── roles-permissions/       per-role permission strings + checkLevelPermissions
├── v1/
│   ├── api/index.ts             /api/v1 router: health, /doc, /doc/ui, auth routes, auth guard,
│   │                            domain routes, tenant middlewares, notFound/onError
│   ├── api/routes/*.ts          route modules per domain (auth, organizations, users, workspaces)
│   └── utils/apiErrorResponse.ts  errorResponseSchema + createErrorResponse
auth-schema.ts                   Better Auth tables + user Zod schemas (generated, do not edit)
drizzle/                         generated snapshots + SQL migrations (do not hand-edit)
static/                          served at /static/* (uploaded assets; not committed)
drizzle.config.ts                drizzle-kit config: schema = src/db/schemas + auth-schema.ts
```

## Router order in `src/v1/api/index.ts`

Order is load-bearing — a route mount only sees the middlewares registered before it:

1. `GET /health` (public), `/doc` (OpenAPI document), `/doc/ui` (Swagger UI).
2. `authRoutes` mounted (public: sign-up, sign-in, sign-out, change password, `POST /auth/account`).
3. `use(authMiddleware)` — every mount after this requires a signed-in user.
4. `organizationsRoutes`, `usersRoutes`, `workspacesRoutes`.
5. `use(organizationMemberMiddleware)` then `use(workspaceRoleMiddleware)` — tenant middlewares
   for future route mounts. `organizationMemberMiddleware` must stay above
   `workspaceRoleMiddleware`, which reads the membership row the former sets.
6. `notFound` and `onError` last.

Consequence: today's signed-in routes authorize themselves in handlers (via
`OrganizationsService.getOrganizationById` / `WorkspacesService.getWorkspaceById`, which return the
caller's membership rows); the tenant middlewares are wired but not consumed by any route yet.

## Dependencies

Resolved versions come from `bun.lock`.

### HTTP and API contract

| Package | Declared | Resolved | Role |
| --- | --- | --- | --- |
| `hono` | `^4.13.14` | `4.13.18` | Routing, middleware, context, `requestId`, `cors`, `secure-headers`. |
| `@hono/bun` | `^1.0.1` | `1.0.1` | Bun adapter (`serveStatic` for `static/*`). |
| `@hono/zod-openapi` | `^1.6.3` | `1.6.3` | `OpenAPIHono` + `createRoute`; also the single `z` import site — always `import { z } from "@hono/zod-openapi"`, never from `zod`. |
| `@hono/swagger-ui` | `^0.6.1` | `0.6.2` | Interactive API UI at `/api/v1/doc/ui`. |
| `zod` | `^4.6.7` | `4.6.7` | Validation for request/response payloads and Drizzle Zod schemas. |
| `http-status-codes` | `^2.3.0` | `2.3.0` | `StatusCodes.*` constants instead of numeric literals. |

### Authentication

| Package | Declared | Resolved | Role |
| --- | --- | --- | --- |
| `better-auth` | `^1.7.14` | `1.7.25` | Email/password auth, sessions, cookies, username plugin, auth OpenAPI. Owns `user`, `session`, `account`, `verification`. |
| `@better-auth/drizzle-adapter` | `^1.7.14` | `1.7.25` | Persists auth tables through the same Drizzle database/migration pipeline as domain tables. |

### Data layer

| Package | Declared | Resolved | Role |
| --- | --- | --- | --- |
| `drizzle-orm` | `^1.0.0-rc.5` | `1.0.0-rc.5-ab785fc` | Schema definition (`snakeCase.table`, pg enums, composite FKs), query builder, transactions, `drizzle-orm/zod` schema factories. |
| `drizzle-kit` | `^1.0.0-rc.5` | `1.0.0-rc.5-ab785fc` | Migration generation/application (also used by the test setup against the test database). |

Both drizzle packages are RCs pinned to the same `1.0.0-rc.5` build; upgrade them together.

### Utilities

| Package | Declared | Resolved | Role |
| --- | --- | --- | --- |
| `nanoid` | `^6.0.2` | `6.0.2` | Random suffixes for server-generated slugs and unique asset file names. |
| `slugify` | `^1.6.9` | `1.6.9` | Human-readable part of slugs and file names. |

### Tooling

| Tool | Declared | Resolved | Role |
| --- | --- | --- | --- |
| Bun | (runtime) | — | Runs TS directly, serves HTTP, installs packages, runs scripts/tests. |
| TypeScript | `^7` (peer) | `7.0.2` | `bunx tsc --noEmit`; strict, `noUncheckedIndexedAccess`. |
| `@types/bun` | `latest` (dev) | `1.4.4` | Bun globals/API typings. |
| `drizzle-kit` | `^1.0.0-rc.5` (dev) | `1.0.0-rc.5-ab785fc` | Dev-only migration CLI. |

## Why these choices fit together

- **One schema language, three consumers.** Zod validates runtime input, feeds
  `@hono/zod-openapi` route contracts, and powers the Drizzle Zod schema factories — validation,
  types, and documentation cannot drift apart.
- **End-to-end type safety.** Drizzle row types flow into services and handlers; `tsc --noEmit`
  checks the seams.
- **Auth and domain data share one pipeline.** The Drizzle adapter makes Better Auth just another
  schema consumer; one `db:generate`/`db:migrate` workflow covers everything.
- **Bun-only toolchain.** No bundler, ts-node, nodemon, or separate test runner: Bun runs TS,
  watches files, serves HTTP, runs scripts and tests.
- **Transactions are passed, not global.** Services take a `DBExecutor` (`db` or a transaction
  executor) in their constructor, so orchestration services and `ActivityLogger` run inside the
  caller's transaction.

## Configuration

`.env` is gitignored and auto-loaded by Bun. The app fails fast at startup when a required key is
missing (`PORT` in `src/index.ts`, `DATABASE_URL` in `src/db/connect.ts`).

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PORT` | `src/index.ts` | HTTP port; required or startup throws. |
| `DATABASE_URL` | `src/db/connect.ts`, `drizzle-kit`, test harness | Postgres connection string; the test database is derived as `<name>_test` from it. |
| `BETTER_AUTH_SECRET` | `better-auth` | Session signing/encryption secret. |
| `BETTER_AUTH_URL` | `better-auth` | Public base URL for auth callbacks/cookies. |
| `NODE_ENV` | dev script, Better Auth | Set to `development` by `bun run dev`. |

Do not add a new framework, runtime, ORM, or validation library; extend the stack above.
