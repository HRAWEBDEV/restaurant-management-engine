# Restaurant Manager API

`restaurant-manager-api` is a Bun-native, multi-tenant HTTP API for restaurant operations —
catalog, floor, orders, kitchen, inventory, staff, payments, and reporting.

It is the authoritative backend for a restaurant's operational state: one place that enforces
tenancy, permissions, state transitions, and money integrity, consumed by any number of clients
(POS, kitchen display, customer ordering, admin, back office).

## Status

Early-stage. The identity and tenancy foundation is built; the operational domains are scoped and
planned.

| Area | Status |
| --- | --- |
| Identity & auth (Better Auth: email/password, username, sessions) | Built |
| Tenancy (organizations, workspaces, memberships) — schema, services, routes | Built |
| Organization invitations — schema, service, routes (send/list/revoke/accept) | Built |
| Audit log (`activity_logs` + `ActivityLogger`) | Built (partial writers) |
| Permissions scaffold (role catalogs + `checkLevelPermissions`/`requireLevelPermissions`) | Built (partial enforcement) |
| Catalog, Floor, Orders, Kitchen, Inventory, Staff, Payments, Reporting | Planned (see `docs/plan.md`) |

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime / toolchain | Bun (runs TS directly, serves HTTP, runs tests and scripts) |
| HTTP framework | Hono + `@hono/zod-openapi` (Zod contracts, OpenAPI document, Swagger UI) |
| Auth | Better Auth (Drizzle adapter — one database, one migration pipeline) |
| Data | PostgreSQL via Drizzle ORM (`bun-sql` driver), drizzle-kit migrations |
| Language | TypeScript (strict), checked with `bunx tsc --noEmit` |

## Getting started

Prerequisites: [Bun](https://bun.sh) and a PostgreSQL server.

```bash
bun install
```

Create a `.env` file in the project root (gitignored, auto-loaded by Bun):

```dotenv
PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/restaurant_manager_app
BETTER_AUTH_SECRET=<random secret>
BETTER_AUTH_URL=http://localhost:3000
```

Apply migrations, then start the dev server:

```bash
bun run db:migrate
bun run dev
```

Smoke check:

```bash
curl localhost:3000/api/v1/health
# OpenAPI document: /api/v1/doc — interactive UI: /api/v1/doc/ui
```

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Dev server with hot reload. |
| `bun run typecheck` | Static type check — run before finishing any change. |
| `bun run test` | Create/migrate/truncate the test database, then run the full suite. |
| `bun run db:generate` | Diff the Drizzle schema and emit migration SQL. Review before applying. |
| `bun run db:migrate` | Apply pending migrations. |
| `bun run auth:generate` | Regenerate `auth-schema.ts` from the Better Auth config. |

## Documentation

| Doc | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Layers, request lifecycle, source layout, dependencies, configuration |
| [`docs/data-model.md`](docs/data-model.md) | Identity/tenancy model, tables, constraints, known gaps |
| [`docs/api.md`](docs/api.md) | API conventions and the endpoint catalog |
| [`docs/product-scope.md`](docs/product-scope.md) | Full feature list and domain rules |
| [`docs/plan.md`](docs/plan.md) | Delivery plan toward the full product; per-phase detail docs under `docs/plan/` |
| [`docs/testing.md`](docs/testing.md) | How tests are written and run in this codebase |
| [`AGENTS.md`](AGENTS.md) | Conventions and working agreements for coding agents |

## License

Private project — all rights reserved.
