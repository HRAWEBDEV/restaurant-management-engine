/**
 * Workspace-level roles and the permissions granted to each role.
 *
 * Permissions are namespaced strings (`resource:action` or `resource:sub:action`)
 * so they can be checked individually at the route/service layer.
 * `workspacePermissions` is the source of truth: roles are its keys, kept
 * in sync with the `workspace_roles` pg enum. `member` exists as a key but
 * currently grants nothing; only `admin` has grants.
 */
const workspacePermissions = {
  admin: [
    "workspace:read",
    "workspace:update",
    "workspace:delete",
    "workspace:member:read",
    "workspace:member:add",
    "workspace:member:update",
    "workspace:member:remove",
    "workspace:setting:read",
    "workspace:setting:update",
    "catalog:read",
    "catalog:manage",
    "floor:read",
    "floor:manage",
    "order:read",
    "order:create",
    "order:update",
    "order:void",
    "order:comp",
    "order:discount",
    "kitchen:read",
    "kitchen:manage",
    "inventory:read",
    "inventory:manage",
    "staff:read",
    "staff:manage",
    "payment:read",
    "payment:create",
    "payment:refund",
    "report:read",
  ],
  member: [],
} as const;

type WorkspaceRole = keyof typeof workspacePermissions;
type WorkspacePermission = (typeof workspacePermissions)[WorkspaceRole][number];

const workspaceRoles = Object.keys(workspacePermissions) as WorkspaceRole[];

/**
 * Checks whether a workspace role grants the given permission.
 */
function hasPermission(
  role: WorkspaceRole,
  permission: WorkspacePermission,
): boolean {
  const grants = workspacePermissions[role] as readonly string[] | undefined;
  return grants?.includes(permission) ?? false;
}

export type { WorkspaceRole, WorkspacePermission };
export { workspaceRoles, workspacePermissions, hasPermission };
