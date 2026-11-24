import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { ForbiddenError } from "./ForbiddenError";
import { workspaceRoles } from "../db/schemas/workspaceMembers";
import {
  CONTEXT_USER_WORKSPACE_MEMBER_ROLE,
  type AuthContext,
} from "./AuthContext";

const WORKSPACE_ID_HEADER = "x-workspace-id";

const workspaceIdSchema = z.uuid();

type WorkspaceRole = (typeof workspaceRoles)[number];

/**
 * Declared (not validated) so the tenant header shows up as a required
 * parameter in the OpenAPI document and Swagger UI. The header itself is
 * enforced by workspaceRoleMiddleware, which runs before this validation and
 * rejects a missing or invalid header with 403.
 */
const workspaceIdHeaderSchema = z.object({
  [WORKSPACE_ID_HEADER]: z.uuid().openapi({
    description:
      "Active workspace for this request; membership and permissions are resolved from it.",
    example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  }),
});

function getWorkspaceIdHeader(
  c: Context<{
    Variables: AuthContext;
  }>,
) {
  const headerValue = c.req.header(WORKSPACE_ID_HEADER);
  if (!headerValue) {
    throw new ForbiddenError(`${WORKSPACE_ID_HEADER} header is missing`);
  }
  const parsed = workspaceIdSchema.safeParse(headerValue);
  if (!parsed.success) {
    throw new ForbiddenError(
      `${WORKSPACE_ID_HEADER} header is not a valid workspace id`,
    );
  }
  return parsed.data;
}

function setContextWorkspaceRole(
  c: Context<{
    Variables: AuthContext;
  }>,
  role: WorkspaceRole,
) {
  c.set(CONTEXT_USER_WORKSPACE_MEMBER_ROLE, role);
}

function getContextWorkspaceRole(
  c: Context<{
    Variables: AuthContext;
  }>,
): WorkspaceRole | undefined {
  // Undefined is meaningful: the workspace role middleware has not run for
  // this request. Organization-level permission checks do not need it, and
  // workspace-level grants resolve to "not granted" through
  // checkLevelPermissions when the role is missing.
  return c.get(CONTEXT_USER_WORKSPACE_MEMBER_ROLE);
}

export {
  WORKSPACE_ID_HEADER,
  workspaceIdHeaderSchema,
  getWorkspaceIdHeader,
  setContextWorkspaceRole,
  getContextWorkspaceRole,
};
