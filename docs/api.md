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
| GET | `/organizations/{id}/members` | The organization's members, oldest join first. Members get each row joined with the organization, the member's user row, and the user who added them (`addedByUser`, null when unknown); signed-in non-members get a limited view with only `firstName`, `lastName`, and `email` per member; 404 when the organization does not exist. |
| PATCH | `/organizations/{id}` | Update name/logo/description; requires `organization:update` (403 otherwise); name change regenerates the slug. |
| PUT | `/organizations/{id}/logo` | Multipart image (png/jpeg/webp ≤ 2 MB); requires `organization:update`; replaces and deletes the previous logo file. |
| POST | `/organizations/account` | Create an organization + default workspace for the signed-in user (same orchestrator as `POST /auth/account`) → 201 `{ organization, workspace }`. |
| GET | `/users/info` | The session user's profile. |
| PATCH | `/users/info` | Update name/firstName/lastName/username/image; username uniqueness → 409. |
| PUT | `/users/image` | Multipart image (png/jpeg/webp ≤ 2 MB); replaces and deletes the previous image file. |
| GET | `/workspaces` | Workspaces reachable through the caller's organization memberships, newest first, each joined with its organization and membership row. |
| GET | `/workspaces/{id}` | Workspace + its organization + the caller's organization membership row + workspace membership row (null when not a workspace member); 404 when not an organization member. |
| PATCH | `/workspaces/{id}` | Update name/description; requires `workspace:update` checked at `organizationWorkspace` level (org owner or workspace admin); name change regenerates the slug. |
| GET | `/invitations` | Invitations addressed to the session user's email (their inbox), newest first, each joined with the inviting organization and the inviter; optional `?status=` filter. Mounted before the tenant middlewares, so no tenant header is needed. |
| POST | `/organizations/{organizationId}/invitations/{invitationId}/accept` | Accept a pending invitation addressed to the session user → 200 `{ invitation, member }` (membership created as plain `member`, invitation flipped to `accepted`). Mounted before the tenant middlewares — the invitee is usually not a member yet, so no tenant header; the case-insensitive email match authorizes the caller. 403 when addressed to another email; 404 when no such invitation in the organization; 409 when it is not pending (including lazily expired) or the invitee is already a member. |
| GET | `/organization/invitations` | The active organization's invitations (from `x-organization-id`), newest first, each joined with the organization and the inviter; optional `?status=` filter. Mounted after `organizationMemberMiddleware`; permission `organization:invitation:read` enforced by `requireLevelPermissions`; 403 when not a member or not permitted. |
| POST | `/organization/invitations` | Create a pending invitation `{ invitedUserEmail }` for the active organization (`x-organization-id`); email normalized lowercase, server-set 7-day expiry, inviter from the session. Permission `organization:member:invite`; 403 when not a member or not permitted; 409 when the email is already a member or an invitation is already pending. |
| POST | `/organization/invitations/{invitationId}/revoke` | Revoke a pending invitation of the active organization → 200 `{ invitation }` with status `revoked` (rows are kept as history); frees the invitee's email for a new pending invitation. Revoker from the session. Permission `organization:invitation:revoke`; 403 when not a member or not permitted; 404 when no such invitation in the organization; 409 when it is not pending (including lazily expired). |

### Tenant middlewares (partial)

`organizationMemberMiddleware` and `workspaceRoleMiddleware` are registered after the current
domain mounts. The organization-scoped invitation routes are mounted between the two
`use(...)` lines: they require the `x-organization-id` header, get the caller's membership row
on the context (`userOrganizationMember`), and enforce permissions with
`requireLevelPermissions` declared per route. Modules mounted after the second `use(...)` line
additionally require the `x-workspace-id` header and receive the workspace role context
(`userWorkspaceMemberRole`); `getContextWorkspaceRole` returns `undefined` when that middleware
has not run, so organization-level checks stay usable without it.

## Testing endpoints

Handlers are tested in-process with `app.request(...)` — no live server, no Supertest. See
`docs/testing.md`.
