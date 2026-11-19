import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
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
import { errorResponseSchema } from "../../utils/apiErrorResponse";

const workspacesRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/workspaces");

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

workspacesRoutes.openapi(getWorkspacesRoute, async (c) => {
  const user = getContextUser(c);

  const { workspaces } = await new WorkspacesService(db).getWorkspaces({
    filters: { userId: user.id },
  });

  return c.json({ workspaces }, StatusCodes.OK);
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

export { workspacesRoutes };
