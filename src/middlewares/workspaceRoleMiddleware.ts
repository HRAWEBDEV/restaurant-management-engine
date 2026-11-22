import { createMiddleware } from "hono/factory";
import { db } from "../db/connect";
import { getContextOrganizationMember } from "../utils/organizationContext";
import { type AuthContext } from "../utils/AuthContext";
import { ForbiddenError } from "../utils/ForbiddenError";
import {
  getWorkspaceIdHeader,
  setContextWorkspaceRole,
} from "../utils/workspaceContext";
import { WorkspacesService } from "../services/workspacesService";

/**
 * Resolves the active workspace from the request header and attaches the
 * caller's workspace role to the context.
 *
 * MUST run after organizationMemberMiddleware: it reads the organization
 * membership row that middleware puts on the context.
 *
 * The workspace is fetched first, so a workspace of another organization (or
 * a missing one) is rejected before any role decision is made — this is what
 * keeps the owner short-circuit from leaking access across organizations.
 * Owners then get the implicit `admin` workspace role on every workspace of
 * their organization without needing a workspace membership row; any other
 * user must be an actual workspace member.
 */
const workspaceRoleMiddleware = createMiddleware<{
  Variables: AuthContext;
}>(async (c, next) => {
  const workspaceId = getWorkspaceIdHeader(c);
  const organizationMember = getContextOrganizationMember(c);

  const { workspace, workspaceMembership } = await new WorkspacesService(
    db,
  ).getWorkspaceById({
    id: workspaceId,
    userId: organizationMember.userId,
  });

  if (
    !workspace ||
    workspace.organizationId !== organizationMember.organizationId
  ) {
    // also covers a workspace the caller cannot reach at all
    throw new ForbiddenError("you are not a member of this workspace");
  }

  if (organizationMember.role === "owner") {
    setContextWorkspaceRole(c, "admin");

    await next();
    return;
  }

  if (!workspaceMembership) {
    throw new ForbiddenError("you are not a member of this workspace");
  }

  setContextWorkspaceRole(c, workspaceMembership.role);

  await next();
});

export { workspaceRoleMiddleware };
