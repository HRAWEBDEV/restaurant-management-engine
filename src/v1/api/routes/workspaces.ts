import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import type { OrganizationMember } from "../../../db/schemas/organizationMembers";
import {
  selectWorkspaceMemberSchema,
  workspaceRoles,
} from "../../../db/schemas/workspaceMembers";
import type { WorkspaceMember } from "../../../db/schemas/workspaceMembers";
import { WorkspaceMembersService, getWorkspaceMembersResponseSchema } from "../../../services/workspaceMembersService";
import {
  createWorkspaceResponseSchema,
  createWorkspaceSchema,
  getWorkspacesResponseSchema,
  getWorkspaceWithMembershipResponseSchema,
  updateWorkspaceResponseSchema,
  updateWorkspaceSchema,
  WorkspacesService,
} from "../../../services/workspacesService";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import { ForbiddenError } from "../../../utils/ForbiddenError";
import { NotFoundError } from "../../../utils/NotFoundError";
import { checkLevelPermissions } from "../../../utils/roles-permissions/checkLevelPermissions";
import { OrganizationsService } from "../../../services/organizationsService";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

const workspacesRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/workspaces");

/**
 * The caller's workspace role with the organization owner's implicit admin
 * applied (owners hold the workspace admin role on every workspace of their
 * organization), mirroring workspaceRoleMiddleware. undefined when the caller
 * has no workspace role.
 */
function effectiveWorkspaceRole(
  membership: OrganizationMember,
  workspaceMembership: WorkspaceMember | null,
): WorkspaceMember["role"] | undefined {
  if (workspaceMembership) {
    return workspaceMembership.role;
  }

  return membership.role === "owner" ? "admin" : undefined;
}

const getWorkspacesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["workspaces"],
  summary: "List the signed in user's workspaces",
  description:
    "Returns the workspaces the session user can reach through their organization memberships, newest first, each joined with its organization and the user's organization membership row. The user id is taken from the session, never from the request.",
  responses: {
    200: {
      description: "Workspaces the user can reach",
      content: {
        "application/json": {
          schema: getWorkspacesResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["workspaces"],
  summary:
    "Create a workspace in an organization the signed in user is a member of",
  description:
    "Creates a workspace inside the given organization with a server-generated slug and adds the creator as its workspace admin with a workspace.membership row and a workspace.created audit row. Requests outside the caller's organization memberships are reported as not found; callers whose organization role does not grant workspace:create are rejected as forbidden.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createWorkspaceSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace created",
      content: {
        "application/json": {
          schema: createWorkspaceResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "The caller is a member but their organization role does not grant workspace:create",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "Organization not found, or the caller is not a member of it",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const getWorkspaceByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["workspaces"],
  summary: "Get a workspace the signed in user can reach",
  description:
    "Returns the workspace, its organization, the caller's organization membership row, and the caller's workspace membership row (null when they are not a workspace member). Requests outside the caller's organization memberships are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
  },
  responses: {
    200: {
      description:
        "Workspace with its organization and the caller's membership rows",
      content: {
        "application/json": {
          schema: getWorkspaceWithMembershipResponseSchema,
        },
      },
    },
    404: {
      description:
        "Workspace not found, or the caller is not a member of its organization",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const updateWorkspaceRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["workspaces"],
  summary: "Update a workspace the signed in user can reach",
  description:
    "Updates the name and/or description. A changed name regenerates the workspace slug. Requests outside the caller's memberships are reported as not found; callers whose roles do not grant workspace:update are rejected as forbidden.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateWorkspaceSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workspace updated, or unchanged when no fields were set",
      content: {
        "application/json": {
          schema: updateWorkspaceResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "The caller can reach the workspace but their organization and workspace roles do not grant workspace:update",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "Workspace not found, or the caller is not a member of its organization",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const updateWorkspaceMemberRoleBodySchema = z.object({
  role: z.enum(workspaceRoles),
});

const getWorkspaceMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["workspaces"],
  summary: "List the members of a workspace",
  description:
    "Returns the workspace's memberships, oldest join first, each joined with the workspace, its organization, the member's user row (through the underlying organization membership), and the user who added them (null when unknown). Requests outside the caller's organizations are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Workspace members with their membership rows",
      content: {
        "application/json": {
          schema: getWorkspaceMembersResponseSchema,
        },
      },
    },
    404: {
      description:
        "Workspace not found, or the caller is not a member of its organization",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const updateWorkspaceMemberRoleRoute = createRoute({
  method: "patch",
  path: "/{id}/members/{memberId}",
  tags: ["workspaces"],
  summary: "Update the role of a workspace member",
  description:
    "Changes a member's workspace role. Requires workspace:member:update — granted to workspace admins, with organization owners holding the workspace admin role implicitly; callers cannot change their own role. Requests outside the caller's organizations and memberships from another workspace are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
      memberId: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateWorkspaceMemberRoleBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workspace member role updated",
      content: {
        "application/json": {
          schema: z.object({ member: selectWorkspaceMemberSchema }),
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "The caller's roles do not grant workspace:member:update, or they are trying to change their own role",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "Workspace not found, the caller is not a member of its organization, or the membership does not exist in it",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const removeWorkspaceMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{memberId}",
  tags: ["workspaces"],
  summary: "Remove a member from a workspace",
  description:
    "Removes a workspace membership. Requires workspace:member:remove — granted to workspace admins, with organization owners holding the workspace admin role implicitly; callers cannot remove their own membership. Requests outside the caller's organizations and memberships from another workspace are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
      memberId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Member removed; returns the removed membership row",
      content: {
        "application/json": {
          schema: z.object({ member: selectWorkspaceMemberSchema }),
        },
      },
    },
    403: {
      description:
        "The caller's roles do not grant workspace:member:remove, or they are trying to remove their own membership",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "Workspace not found, the caller is not a member of its organization, or the membership does not exist in it",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

workspacesRoutes.openapi(getWorkspacesRoute, async (c) => {
  const user = getContextUser(c);

  const { workspaces } = await new WorkspacesService(db).getWorkspaces({
    filters: { userId: user.id },
  });

  return c.json({ workspaces }, StatusCodes.OK);
});

workspacesRoutes.openapi(createWorkspaceRoute, async (c) => {
  const user = getContextUser(c);
  const body = c.req.valid("json");

  // The role comes from the caller's organization membership row, never from
  // the request; a missing/non-member organization fails before any write.
  const { organization, membership } = await new OrganizationsService(
    db,
  ).getOrganizationById({
    id: body.organizationId,
    userId: user.id,
  });

  if (!organization || !membership) {
    throw new NotFoundError("organization not found");
  }

  const allowed = checkLevelPermissions({
    level: "organization",
    permission: "workspace:create",
    organizationRole: membership.role,
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to create workspaces in this organization",
    );
  }

  const { workspace } = await new WorkspacesService(db).createWorkspace({
    organizationId: body.organizationId,
    name: body.name,
    description: body.description,
    userId: user.id,
  });

  if (!workspace) {
    throw new NotFoundError("organization not found");
  }

  return c.json({ workspace }, StatusCodes.CREATED);
});

workspacesRoutes.openapi(getWorkspaceByIdRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");

  const result = await new WorkspacesService(db).getWorkspaceById({
    id,
    userId: user.id,
  });

  if (!result.workspace) {
    throw new NotFoundError("workspace not found");
  }

  return c.json(result, StatusCodes.OK);
});

workspacesRoutes.openapi(updateWorkspaceRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const service = new WorkspacesService(db);

  // Fetched up front so the organization and workspace membership roles are
  // available for the permission check and a missing/non-member workspace
  // fails before any write.
  const { workspace, membership, workspaceMembership } =
    await service.getWorkspaceById({
      id,
      userId: user.id,
    });

  if (!workspace || !membership) {
    throw new NotFoundError("workspace not found");
  }

  // The roles come from the membership rows, never from the request.
  // Organization-level roles (owner) and workspace-level roles (admin) each
  // grant workspace:update, hence the combined level.
  const allowed = checkLevelPermissions({
    level: "organizationWorkspace",
    permission: "workspace:update",
    organizationRole: membership.role,
    workspaceRole: workspaceMembership?.role,
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to update this workspace",
    );
  }

  const { workspace: updatedWorkspace } = await service.updateWorkspace({
    id,
    userId: user.id,
    ...body,
  });

  if (!updatedWorkspace) {
    throw new NotFoundError("workspace not found");
  }

  return c.json({ workspace: updatedWorkspace }, StatusCodes.OK);
});

workspacesRoutes.openapi(getWorkspaceMembersRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");

  // Scoped through the caller's organization membership: a workspace outside
  // the caller's organizations is reported as not found.
  const { workspace } = await new WorkspacesService(db).getWorkspaceById({
    id,
    userId: user.id,
  });

  if (!workspace) {
    throw new NotFoundError("workspace not found");
  }

  const { members } = await new WorkspaceMembersService(db).getWorkspaceMembers(
    { filters: { workspaceId: id } },
  );

  return c.json({ members }, StatusCodes.OK);
});

workspacesRoutes.openapi(updateWorkspaceMemberRoleRoute, async (c) => {
  const user = getContextUser(c);
  const { id, memberId } = c.req.valid("param");
  const { role } = c.req.valid("json");

  const { workspace, membership, workspaceMembership } =
    await new WorkspacesService(db).getWorkspaceById({
      id,
      userId: user.id,
    });

  if (!workspace || !membership) {
    throw new NotFoundError("workspace not found");
  }

  // The roles come from the membership rows, never from the request.
  // Organization owners hold the workspace admin role implicitly, so the
  // combined level lets both owners and workspace admins manage members.
  const allowed = checkLevelPermissions({
    level: "organizationWorkspace",
    permission: "workspace:member:update",
    organizationRole: membership.role,
    workspaceRole: effectiveWorkspaceRole(membership, workspaceMembership),
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to update workspace member roles",
    );
  }

  // Callers cannot change their own workspace role.
  if (workspaceMembership && memberId === workspaceMembership.id) {
    throw new ForbiddenError("you cannot change your own workspace role");
  }

  const { member } = await new WorkspaceMembersService(db).updateWorkspaceRole({
    id: memberId,
    workspaceId: id,
    role,
    actorUserId: user.id,
  });

  if (!member) {
    throw new NotFoundError("workspace member not found");
  }

  return c.json({ member }, StatusCodes.OK);
});

workspacesRoutes.openapi(removeWorkspaceMemberRoute, async (c) => {
  const user = getContextUser(c);
  const { id, memberId } = c.req.valid("param");

  const { workspace, membership, workspaceMembership } =
    await new WorkspacesService(db).getWorkspaceById({
      id,
      userId: user.id,
    });

  if (!workspace || !membership) {
    throw new NotFoundError("workspace not found");
  }

  // Organization owners hold the workspace admin role implicitly, so the
  // combined level lets both owners and workspace admins manage members.
  const allowed = checkLevelPermissions({
    level: "organizationWorkspace",
    permission: "workspace:member:remove",
    organizationRole: membership.role,
    workspaceRole: effectiveWorkspaceRole(membership, workspaceMembership),
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to remove workspace members",
    );
  }

  // Callers cannot remove their own workspace membership.
  if (workspaceMembership && memberId === workspaceMembership.id) {
    throw new ForbiddenError("you cannot remove your own workspace membership");
  }

  const { member } = await new WorkspaceMembersService(db).removeWorkspaceMember(
    {
      id: memberId,
      workspaceId: id,
      actorUserId: user.id,
    },
  );

  if (!member) {
    throw new NotFoundError("workspace member not found");
  }

  return c.json({ member }, StatusCodes.OK);
});

export { workspacesRoutes };
