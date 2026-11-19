/**
 * Organization-level roles and the permissions granted to each role.
 *
 * Permissions are namespaced strings (`resource:action` or `resource:sub:action`)
 * so they can be checked individually at the route/service layer.
 * `organizationPermissions` is the source of truth: roles are its keys, kept
 * in sync with the `organization_roles` pg enum. `admin` and `member` exist as
 * keys but currently grant nothing; only `owner` has grants.
 */
const organizationPermissions = {
  owner: [
    "organization:read",
    "organization:update",
    "organization:delete",
    "organization:member:read",
    "organization:member:invite",
    "organization:member:update",
    "organization:member:remove",
    "organization:invitation:read",
    "organization:invitation:revoke",
    "workspace:create",
    "workspace:read",
    "workspace:update",
    "workspace:delete",
    "workspace:member:manage",
    "billing:read",
    "billing:manage",
  ],
  admin: [],
  member: [],
} as const;

type OrganizationRole = keyof typeof organizationPermissions;
type OrganizationPermission =
  (typeof organizationPermissions)[OrganizationRole][number];

const organizationRoles = Object.keys(
  organizationPermissions,
) as OrganizationRole[];

/**
 * Checks whether an organization role grants the given permission.
 */
function hasPermission(
  role: OrganizationRole,
  permission: OrganizationPermission,
): boolean {
  const grants = organizationPermissions[role] as readonly string[] | undefined;
  return grants?.includes(permission) ?? false;
}

export type { OrganizationRole, OrganizationPermission };
export { organizationRoles, organizationPermissions, hasPermission };
