import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
  getOrganizationInvitationsResponseSchema,
  OrganizationInvitationsService,
  sendInviteResponseSchema,
  sendInviteSchema,
} from "../../../services/organizationInvitationsService";
import { organizationInvitationStatusEnum } from "../../../db/schemas/organizationInvitations";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import {
  getContextOrganizationMember,
  organizationIdHeaderSchema,
} from "../../../utils/organizationContext";
import { requireLevelPermissions } from "../../../middlewares/requireLevelPermissions";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

/**
 * Invitations are their own aggregate. The invitee inbox is session-scoped
 * only — an invitee is usually not an organization member yet, so it mounts
 * before the tenant middlewares and lists the session user's invitations
 * across all organizations. The organization-scoped routes mount after
 * organizationMemberMiddleware and address the organization only through the
 * x-organization-id header — no path param, so the header is the single
 * source of truth and cannot disagree with the path.
 */
const invitationsRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>();

const organizationInvitationsRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>();

const invitationsStatusQuerySchema = z.object({
  status: z.enum(organizationInvitationStatusEnum.enumValues).optional(),
});

/**
 * The invitee inbox is scoped to the session user across all organizations
 * and does not use the header for anything, but clients that always send
 * x-organization-id should see the same parameter set in the OpenAPI
 * document.
 */
const getMyInvitationsRoute = createRoute({
  method: "get",
  path: "/invitations",
  tags: ["invitations"],
  summary: "List invitations addressed to the signed in user",
  description:
    "Returns the invitations addressed to the session user's email, across all organizations, newest first, each joined with the inviting organization and the inviter's user row. Optionally narrowed by status. The user id is taken from the session, never from the request.",
  request: {
    query: invitationsStatusQuerySchema,
  },
  responses: {
    200: {
      description: "Invitations addressed to the session user",
      content: {
        "application/json": {
          schema: getOrganizationInvitationsResponseSchema,
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

const getOrganizationInvitationsRoute = createRoute({
  method: "get",
  path: "/organization/invitations",
  middleware: [
    requireLevelPermissions({
      level: "organization",
      permission: "organization:invitation:read",
    }),
  ],
  tags: ["invitations"],
  summary: "List the active organization's invitations",
  description:
    "Returns the invitations of the organization named by the x-organization-id header, newest first, each joined with the organization and the inviter's user row. Optionally narrowed by status. Requires membership of that organization and organization:invitation:read; anything else is rejected as forbidden.",
  request: {
    headers: organizationIdHeaderSchema,
    query: invitationsStatusQuerySchema,
  },
  responses: {
    200: {
      description: "The organization's invitations",
      content: {
        "application/json": {
          schema: getOrganizationInvitationsResponseSchema,
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
    403: {
      description:
        "Not a member of the x-organization-id organization, or the caller's role does not grant organization:invitation:read",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const sendInviteRoute = createRoute({
  method: "post",
  path: "/organization/invitations",
  middleware: [
    requireLevelPermissions({
      level: "organization",
      permission: "organization:member:invite",
    }),
  ],
  tags: ["invitations"],
  summary: "Invite someone to the active organization",
  description:
    "Creates a pending invitation for an email address. The email is normalized to lowercase and the expiry is server-managed (7 days). The inviter is taken from the session. Requires membership of the organization named by the x-organization-id header and organization:member:invite; anything else is rejected as forbidden.",
  request: {
    headers: organizationIdHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: sendInviteSchema.pick({ invitedUserEmail: true }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Pending invitation created",
      content: {
        "application/json": {
          schema: sendInviteResponseSchema,
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
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Not a member of the x-organization-id organization, or the caller's role does not grant organization:member:invite",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description:
        "The email already belongs to a member, or an invitation is already pending for it",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

invitationsRoutes.openapi(getMyInvitationsRoute, async (c) => {
  const user = getContextUser(c);
  const { status } = c.req.valid("query");

  const result = await new OrganizationInvitationsService(
    db,
  ).getOrganizationInvitations({
    filters: { userId: user.id, status },
  });

  return c.json(result, StatusCodes.OK);
});

organizationInvitationsRoutes.openapi(
  getOrganizationInvitationsRoute,
  async (c) => {
    const { status } = c.req.valid("query");
    const member = getContextOrganizationMember(c);

    const result = await new OrganizationInvitationsService(
      db,
    ).getOrganizationInvitations({
      filters: { organizationId: member.organizationId, status },
    });

    return c.json(result, StatusCodes.OK);
  },
);

organizationInvitationsRoutes.openapi(sendInviteRoute, async (c) => {
  const body = c.req.valid("json");
  const member = getContextOrganizationMember(c);

  const result = await new OrganizationInvitationsService(db).sendInvite({
    organizationId: member.organizationId,
    invitedUserEmail: body.invitedUserEmail,
    // Always from the session; never from the request body.
    invitedBy: member.userId,
  });

  return c.json(result, StatusCodes.CREATED);
});

export { invitationsRoutes, organizationInvitationsRoutes };
