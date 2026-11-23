import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
  acceptInviteResponseSchema,
  getOrganizationInvitationsResponseSchema,
  OrganizationInvitationsService,
  revokeInviteResponseSchema,
  sendInviteResponseSchema,
  sendInviteSchema,
} from "../../../services/organizationInvitationsService";
import { organizationInvitationStatusEnum } from "../../../db/schemas/organizationInvitations";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import { NotFoundError } from "../../../utils/NotFoundError";
import {
  getContextOrganizationMember,
  organizationIdHeaderSchema,
} from "../../../utils/organizationContext";
import { requireLevelPermissions } from "../../../middlewares/requireLevelPermissions";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

/**
 * Invitations are their own aggregate. The invitee inbox and acceptance are
 * session-scoped only — an invitee is usually not an organization member yet,
 * so they mount before the tenant middlewares; acceptance takes the
 * organization in the path because there is no membership to resolve a header
 * against. The organization-scoped routes mount after
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

const revokeInviteRoute = createRoute({
  method: "post",
  path: "/organization/invitations/{invitationId}/revoke",
  middleware: [
    requireLevelPermissions({
      level: "organization",
      permission: "organization:invitation:revoke",
    }),
  ],
  tags: ["invitations"],
  summary: "Revoke a pending invitation of the active organization",
  description:
    "Flips a pending invitation to the terminal revoked status (rows are kept as history, never deleted). An invitation that is not pending — including one that lazily expired — is rejected as a conflict. The revoker is taken from the session. Requires membership of the organization named by the x-organization-id header and organization:invitation:revoke; anything else is rejected as forbidden. An invitation of another organization is indistinguishable from a missing one and reported as not found.",
  request: {
    headers: organizationIdHeaderSchema,
    params: z.object({
      invitationId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Pending invitation revoked",
      content: {
        "application/json": {
          schema: revokeInviteResponseSchema,
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
        "Not a member of the x-organization-id organization, or the caller's role does not grant organization:invitation:revoke",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "No invitation with that id in the x-organization-id organization",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description:
        "The invitation exists in the organization but is not pending anymore",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const acceptInviteRoute = createRoute({
  method: "post",
  path: "/organizations/{organizationId}/invitations/{invitationId}/accept",
  tags: ["invitations"],
  summary: "Accept an invitation addressed to the signed in user",
  description:
    "Accepts a pending invitation addressed to the session user's email (matched case-insensitively): creates the organization membership (plain member) and flips the invitation to accepted in one transaction. The invitee is usually not a member of the organization yet, so no x-organization-id header is required — the email match is what authorizes the caller, and anyone else is rejected as forbidden. An invitation that is not pending — including one that lazily expired — or an invitee who is already a member is rejected as a conflict. An invitation of another organization is indistinguishable from a missing one and reported as not found. Both ids come from the invitee's inbox (GET /invitations).",
  request: {
    params: z.object({
      organizationId: z.uuid(),
      invitationId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Invitation accepted, membership created",
      content: {
        "application/json": {
          schema: acceptInviteResponseSchema,
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
      description: "The invitation is addressed to another email",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "No invitation with that id in that organization",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description:
        "The invitation is not pending anymore, or the invitee is already a member",
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

invitationsRoutes.openapi(acceptInviteRoute, async (c) => {
  const { organizationId, invitationId } = c.req.valid("param");
  const user = getContextUser(c);

  const result = await new OrganizationInvitationsService(db).acceptInvite({
    organizationId,
    invitationId,
    // Always from the session; never from the request body.
    acceptedBy: user.id,
  });

  if (!result) {
    throw new NotFoundError("invitation not found");
  }

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

organizationInvitationsRoutes.openapi(revokeInviteRoute, async (c) => {
  const { invitationId } = c.req.valid("param");
  const member = getContextOrganizationMember(c);

  const result = await new OrganizationInvitationsService(db).revokeInvite({
    organizationId: member.organizationId,
    invitationId,
    // Always from the session; never from the request body.
    revokedBy: member.userId,
  });

  if (!result) {
    throw new NotFoundError("invitation not found");
  }

  return c.json(result, StatusCodes.OK);
});

export { invitationsRoutes, organizationInvitationsRoutes };
