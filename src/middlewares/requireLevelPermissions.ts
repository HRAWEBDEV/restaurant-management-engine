import { createMiddleware } from "hono/factory";
import { type AuthContext } from "../utils/AuthContext";
import { getContextOrganizationMember } from "../utils/organizationContext";
import { getContextWorkspaceRole } from "../utils/workspaceContext";
import { ForbiddenError } from "../utils/ForbiddenError";
import {
  checkLevelPermissions,
  type CheckLevelPermissionsProps,
} from "../utils/roles-permissions/checkLevelPermissions";

type RequireLevelPermissionsProps = Omit<
  CheckLevelPermissionsProps,
  "organizationRole" | "workspaceRole"
>;

/**
 * Factory that builds permission-enforcing middleware from a declarative
 * requirement (`level` + `permission`).
 *
 * MUST run after organizationMemberMiddleware (reads the membership row it
 * puts on the context) and, for workspace / organizationWorkspace levels,
 * after workspaceRoleMiddleware (which resolves the workspace role, including
 * the implicit `admin` for organization owners).
 *
 * The roles are always resolved from the context, never from client input;
 * the caller only declares which permission at which level is required.
 * Throws ForbiddenError when the resolved roles do not grant it.
 */
function requireLevelPermissions({
  level,
  permission,
}: RequireLevelPermissionsProps) {
  return createMiddleware<{
    Variables: AuthContext;
  }>(async (c, next) => {
    const organizationMember = getContextOrganizationMember(c);
    // The workspace role is only on the context when workspaceRoleMiddleware
    // ran; workspace-level grants need it, organization-level ones do not.
    const workspaceRole = getContextWorkspaceRole(c);

    const granted = checkLevelPermissions({
      level,
      permission,
      organizationRole: organizationMember.role,
      workspaceRole,
    });

    if (!granted) {
      throw new ForbiddenError(`missing permission: ${permission}`);
    }

    await next();
  });
}

export type { RequireLevelPermissionsProps };
export { requireLevelPermissions };
