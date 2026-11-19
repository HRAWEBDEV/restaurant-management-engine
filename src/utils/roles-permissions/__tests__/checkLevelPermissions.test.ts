import { describe, expect, it } from "bun:test";
import { checkLevelPermissions } from "../checkLevelPermissions";
import type { LevelPermission } from "../checkLevelPermissions";
import { organizationPermissions } from "../organizationPermissions";
import { workspacePermissions } from "../workspacePermissions";

/**
 * Permission inputs are derived from the grant lists themselves, so these
 * tests keep passing when the lists change. They only assert the contract:
 * `true` when the role has the permission, `false` when it does not.
 */

function firstPermissionNotIn(
  source: readonly string[],
  target: readonly string[],
): string | undefined {
  return source.find((permission) => !target.includes(permission));
}

const organizationPermission = organizationPermissions.owner[0];
const workspacePermission = workspacePermissions.admin[0];

if (!organizationPermission || !workspacePermission) {
  throw new Error(
    "organization and workspace grant lists must not be empty for these tests",
  );
}

describe("checkLevelPermissions", () => {
  it("returns true when the role has the permission", () => {
    expect(
      checkLevelPermissions({
        level: "organization",
        permission: organizationPermission,
        organizationRole: "owner",
      }),
    ).toBe(true);

    expect(
      checkLevelPermissions({
        level: "workspace",
        permission: workspacePermission,
        workspaceRole: "admin",
      }),
    ).toBe(true);
  });

  it("returns false when the role does not have the permission", () => {
    // picks a permission the role's list does not contain, so this keeps
    // working when currently empty grant lists gain permissions
    const adminLacks = firstPermissionNotIn(
      organizationPermissions.owner,
      organizationPermissions.admin,
    );
    const memberLacks = firstPermissionNotIn(
      workspacePermissions.admin,
      workspacePermissions.member,
    );

    if (adminLacks) {
      expect(
        checkLevelPermissions({
          level: "organization",
          permission: adminLacks as LevelPermission,
          organizationRole: "admin",
        }),
      ).toBe(false);
    }

    if (memberLacks) {
      expect(
        checkLevelPermissions({
          level: "workspace",
          permission: memberLacks as LevelPermission,
          workspaceRole: "member",
        }),
      ).toBe(false);
    }
  });

  it("returns false when no roles are provided", () => {
    expect(
      checkLevelPermissions({
        level: "organizationWorkspace",
        permission: organizationPermission,
      }),
    ).toBe(false);
  });

  it("organizationWorkspace accepts a grant from either level", () => {
    expect(
      checkLevelPermissions({
        level: "organizationWorkspace",
        permission: organizationPermission,
        organizationRole: "owner",
      }),
    ).toBe(true);

    expect(
      checkLevelPermissions({
        level: "organizationWorkspace",
        permission: workspacePermission,
        workspaceRole: "admin",
      }),
    ).toBe(true);
  });
});
