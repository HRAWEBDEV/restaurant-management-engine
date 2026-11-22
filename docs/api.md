# API

Base URL: `/api/v1`. The OpenAPI document is served at `/api/v1/doc` and the interactive Swagger
UI at `/api/v1/doc/ui`.

## Conventions

- **Contract first.** Every endpoint is defined with `createRoute({ method, path, tags, request,
  responses })` and registered with `router.openapi(route, handler)`. Every status code is
  documented, including errors, using `errorResponseSchema`.
- **Validation.** Handlers read validated input via `c.req.valid("json" | "param" | "query" |
  "form")` — `form` for multipart file uploads.
- **Zod import site.** Always `import { z } from "@hono/zod-openapi"`, never from `zod`, so schemas
  work in OpenAPI documents and support `.openapi({ example })`. File fields need an explicit
  `.openapi({ type: "string", format: "binary" })` for document generation.
- **Status codes.** Use `StatusCodes` from `http-status-codes`, not numeric literals.
- **Session identity.** User ids come from the session context (`getContextUser(c)` /
  `getContextSession(c)`, typed as `{ Variables: AuthContext }`), never from the request body.
- **Tenancy.** Sessions carry no tenant. Handlers resolve the organization/workspace from the
  request (id param today; `x-organization-id` / `x-workspace-id` headers once the tenant
  middlewares are consumed) and authorize against membership rows — never client input.

### Error format

All errors share one shape (`errorResponseSchema` in `src/v1/utils/apiErrorResponse.ts`):

```json
{
  "message": "resource not found",
  "code": "NOT_FOUND",
  "description": "optional"
}
```

| Status | Source |
| --- | --- |
| 400 | Validation or expected failure mapped by the handler |
| 401 | `authMiddleware` (`NOT_SIGNED_IN`), sign-in failures |
| 403 | `ForbiddenError` (tenant headers, missing permission) |
| 404 | `NotFoundError` — also used to hide existence from non-members |
| 409 | `ConflictError` (e.g. username taken) |
| 500 | `InternalError` / unhandled errors (logged by the global `onError`) |

### File uploads

Multipart bodies with a `z.file().mime([...]).max(bytes)` field; saved via an `AssetStorage`
instance configured per location (`subPath`, allowed MIME types, max size). Currently: images
(png/jpeg/webp, max 2 MB) under `static/organizations/logos` and `static/users/images`, served
publicly from `/static/*`. `save` returns `{ ok: false, error }` for expected failures — mapped to
a 400 with `createErrorResponse`; a failed removal of a replaced file is logged, never fails the
request.

### Router order (`src/v1/api/index.ts`)

Public routes → `/doc` → auth routes → `use(authMiddleware)` → protected routes →
`use(organizationMemberMiddleware)` / `use(workspaceRoleMiddleware)` (for future mounts) →
`notFound`/`onError`. A mount only sees middlewares registered before it.

## Endpoint catalog

### Public

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness check → `{ message }`. |
| POST | `/auth/sign-up/email` | Sign up with email/password (+ username, firstName, lastName) → `{ token, user }`, session cookies set. |
| POST | `/auth/sign-in/email` | Sign in → `{ redirect, token, url?, user }`, session cookies set. |
| POST | `/auth/sign-out` | Revoke the current session, clear cookies → `{ success }`. |
| POST | `/auth/change-password` | Change password (requires current; revokes other sessions with `revokeOtherSessions`) → `{ token?, user }`. |
| POST | `/auth/account` | One-shot account setup: sign up, create the organization (caller as `owner`) and a default workspace (caller as workspace `admin`) → 201 `{ user, organization, workspace }`. |

### Signed in (after `authMiddleware`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/organizations` | List the session user's organizations, newest first. |
| GET | `/organizations/{id}` | Organization + the caller's membership row; 404 when not a member. |
| PATCH | `/organizations/{id}` | Update name/logo/description; requires `organization:update` (403 otherwise); name change regenerates the slug. |
| PUT | `/organizations/{id}/logo` | Multipart image (png/jpeg/webp ≤ 2 MB); requires `organization:update`; replaces and deletes the previous logo file. |
| POST | `/organizations/account` | Create an organization + default workspace for the signed-in user (same orchestrator as `POST /auth/account`) → 201 `{ organization, workspace }`. |
| GET | `/users/info` | The session user's profile. |
| PATCH | `/users/info` | Update name/firstName/lastName/username/image; username uniqueness → 409. |
| PUT | `/users/image` | Multipart image (png/jpeg/webp ≤ 2 MB); replaces and deletes the previous image file. |
| GET | `/workspaces` | Workspaces reachable through the caller's organization memberships, newest first, each joined with its organization and membership row. |
| GET | `/workspaces/{id}` | Workspace + its organization + the caller's organization membership row + workspace membership row (null when not a workspace member); 404 when not an organization member. |
| PATCH | `/workspaces/{id}` | Update name/description; requires `workspace:update` checked at `organizationWorkspace` level (org owner or workspace admin); name change regenerates the slug. |

### Wired but unused (future mounts)

`organizationMemberMiddleware` and `workspaceRoleMiddleware` are registered after the current
domain mounts. Route modules mounted after those `use(...)` lines will require the
`x-organization-id` / `x-workspace-id` headers and receive the caller's membership rows / workspace
role on the context (`userOrganizationMember`, `userWorkspaceMemberRole`).

## Testing endpoints

Handlers are tested in-process with `app.request(...)` — no live server, no Supertest. See
`docs/testing.md`.
