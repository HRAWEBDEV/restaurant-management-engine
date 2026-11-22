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
  getWorkspaceIdHeader,
  setContextWorkspaceRole,
  getContextWorkspaceRole,
};
