/**
 * Level-aware permission checks.
 *
 * Permissions live at two levels:
 * - `organization` -> `organizationPermissions` (checked with an organization role)
 * - `workspace` -> `workspacePermissions` (checked with a workspace role)
 * - `organizationWorkspace` -> grants access when either level grants it, since
 *   organization-level roles implicitly reach every workspace in the organization.
 *
 * The function stays pure: callers pass the roles they resolved from
 * `organization_members` / `workspace_members`, never client input.
 */
import {
  organizationPermissions,
  organizationRoles,
  hasPermission as hasOrganizationPermission,
} from "./organizationPermissions";
import type {
  OrganizationPermission,
  OrganizationRole,
} from "./organizationPermissions";
import {
  workspacePermissions,
  workspaceRoles,
  hasPermission as hasWorkspacePermission,
} from "./workspacePermissions";
import type {
  WorkspacePermission,
  WorkspaceRole,
} from "./workspacePermissions";

const permissionLevels = [
  "organization",
  "workspace",
  "organizationWorkspace",
] as const;

type PermissionLevel = (typeof permissionLevels)[number];
type LevelPermission = OrganizationPermission | WorkspacePermission;

const organizationPermissionSet = new Set<string>(
  organizationRoles.flatMap((role) => organizationPermissions[role]),
);
const workspacePermissionSet = new Set<string>(
  workspaceRoles.flatMap((role) => workspacePermissions[role]),
);

function isOrganizationPermission(
  permission: LevelPermission,
): permission is OrganizationPermission {
  return organizationPermissionSet.has(permission);
}

function isWorkspacePermission(
  permission: LevelPermission,
): permission is WorkspacePermission {
  return workspacePermissionSet.has(permission);
}

type CheckLevelPermissionsProps = {
  level: PermissionLevel;
  permission: LevelPermission;
  /** Role from `organization_members`; required for organization-level grants. */
  organizationRole?: OrganizationRole;
  /** Role from `workspace_members`; required for workspace-level grants. */
  workspaceRole?: WorkspaceRole;
};

/**
 * Checks whether the given roles grant `permission` at the requested `level`.
 *
 * Returns `false` when the role needed for that level is missing or unknown, so
 * callers can treat "not a member" and "not permitted" the same way.
 */
function checkLevelPermissions({
  level,
  permission,
  organizationRole,
  workspaceRole,
}: CheckLevelPermissionsProps): boolean {
  const hasOrganizationGrant =
    organizationRole !== undefined &&
    isOrganizationPermission(permission) &&
    hasOrganizationPermission(organizationRole, permission);

  const hasWorkspaceGrant =
    workspaceRole !== undefined &&
    isWorkspacePermission(permission) &&
    hasWorkspacePermission(workspaceRole, permission);

  switch (level) {
    case "organization":
      return hasOrganizationGrant;
    case "workspace":
      return hasWorkspaceGrant;
    case "organizationWorkspace":
      return hasOrganizationGrant || hasWorkspaceGrant;
  }
}

export type { PermissionLevel, LevelPermission, CheckLevelPermissionsProps };
export { permissionLevels, checkLevelPermissions };
