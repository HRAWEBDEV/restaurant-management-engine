import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
  AccountsService,
  createAccountOrganizationSchema,
  createAccountResponseSchema,
  createAccountWorkspaceSchema,
} from "../../../services/accountsService";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import { AssetStorage } from "../../../utils/assetStorage";
import { ForbiddenError } from "../../../utils/ForbiddenError";
import { logger, toError } from "../../../utils/logger";
import { NotFoundError } from "../../../utils/NotFoundError";
import {
  getOrganizationMembersLimitedResponseSchema,
  getOrganizationMembersResponseSchema,
  OrganizationMembersService,
} from "../../../services/organizationMembersService";
import { checkLevelPermissions } from "../../../utils/roles-permissions/checkLevelPermissions";
import {
  getOrganizationsResponseSchema,
  getOrganizationWithMembershipResponseSchema,
  OrganizationsService,
  updateOrganizationResponseSchema,
  updateOrganizationSchema,
} from "../../../services/organizationsService";
import {
  errorResponseSchema,
  createErrorResponse,
} from "../../utils/apiErrorResponse";

const organizationsRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/organizations");

const createAccountBodySchema = z.object({
  organization: createAccountOrganizationSchema,
  workspace: createAccountWorkspaceSchema.optional(),
});

/** MIME types and size limit accepted for organization logos. */
const ORGANIZATION_LOGO_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const ORGANIZATION_LOGO_MAX_SIZE = 2 * 1024 * 1024;

/**
 * Stores organization logos under `static/organizations/logos`, publicly
 * served from `/static/organizations/logos/...`.
 */
const organizationLogoStorage = new AssetStorage({
  subPath: "organizations/logos",
  fileTypes: [...ORGANIZATION_LOGO_FILE_TYPES],
  maxSize: ORGANIZATION_LOGO_MAX_SIZE,
});

const updateOrganizationLogoBodySchema = z.object({
  logo: z
    .file()
    .mime([...ORGANIZATION_LOGO_FILE_TYPES])
    .max(ORGANIZATION_LOGO_MAX_SIZE)
    // z.file() needs an explicit OpenAPI type for document generation
    .openapi({ type: "string", format: "binary" }),
});

const getOrganizationsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["organizations"],
  summary: "List the signed in user's organizations",
  description:
    "Returns the organizations the session user is a member of, newest first. The user id is taken from the session, never from the request.",
  responses: {
    200: {
      description: "Organizations the user belongs to",
      content: {
        "application/json": {
          schema: getOrganizationsResponseSchema,
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

const getOrganizationByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["organizations"],
  summary: "Get an organization the signed in user is a member of",
  description:
    "Returns the organization and the caller's membership row when it exists and the session user is a member of it. Requests outside the caller's memberships are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Organization with the caller's membership row",
      content: {
        "application/json": {
          schema: getOrganizationWithMembershipResponseSchema,
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

const getOrganizationMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["organizations"],
  summary: "List the members of an organization",
  description:
    "Returns the organization's memberships, oldest join first. Members get each row joined with the organization, the member's user row, and the user who added them (null when unknown); signed-in non-members get a limited view with only each member's firstName, lastName, and email. Unknown organizations are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
  },
  responses: {
    200: {
      description:
        "Organization members — full membership rows for members, limited view (firstName/lastName/email) for non-members",
      content: {
        "application/json": {
          schema: z.union([
            getOrganizationMembersResponseSchema,
            getOrganizationMembersLimitedResponseSchema,
          ]),
        },
      },
    },
    404: {
      description: "Organization not found",
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

const updateOrganizationRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["organizations"],
  summary: "Update an organization the signed in user is a member of",
  description:
    "Updates the name, logo, and/or description. A changed name regenerates the organization slug. Requests outside the caller's memberships are reported as not found; members whose role does not grant organization:update are rejected as forbidden.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateOrganizationSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Organization updated, or unchanged when no fields were set",
      content: {
        "application/json": {
          schema: updateOrganizationResponseSchema,
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
        "The caller is a member but their organization role does not grant organization:update",
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

const updateOrganizationLogoRoute = createRoute({
  method: "put",
  path: "/{id}/logo",
  tags: ["organizations"],
  summary:
    "Update the logo of an organization the signed in user is a member of",
  description:
    "Accepts a multipart form with an image file (png, jpeg, or webp, up to 2 MB), stores it under static/organizations/logos, updates the organization's logo, and deletes the replaced logo file. Requests outside the caller's memberships are reported as not found; members whose role does not grant organization:update are rejected as forbidden.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: updateOrganizationLogoBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Organization logo updated",
      content: {
        "application/json": {
          schema: updateOrganizationResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input, or the file is unsupported or too large",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "The caller is a member but their organization role does not grant organization:update",
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

const createAccountRoute = createRoute({
  method: "post",
  path: "/account",
  tags: ["organizations"],
  summary:
    "Create an organization and default workspace for the signed in user",
  description:
    "Uses the session user as the owner of the new organization (membership included) and the admin of a default workspace inside it (membership and audit row included).",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createAccountBodySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Organization and default workspace created",
      content: {
        "application/json": {
          schema: createAccountResponseSchema,
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
  },
});

organizationsRoutes.openapi(getOrganizationsRoute, async (c) => {
  const user = getContextUser(c);

  const { organizations } = await new OrganizationsService(db).getOrganizations(
    { filters: { userId: user.id } },
  );

  return c.json({ organizations }, StatusCodes.OK);
});

organizationsRoutes.openapi(getOrganizationByIdRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");

  const result = await new OrganizationsService(db).getOrganizationById({
    id,
    userId: user.id,
  });

  if (!result.organization) {
    throw new NotFoundError("organization not found");
  }

  return c.json(result, StatusCodes.OK);
});

organizationsRoutes.openapi(getOrganizationMembersRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");

  const organizationsService = new OrganizationsService(db);
  const { organization } = await organizationsService.getOrganizationById({
    id,
    userId: user.id,
  });

  const membersService = new OrganizationMembersService(db);

  // The membership lookup inner-joins the caller's membership row, so a null
  // result means "missing organization" or "not a member"; the existence
  // check tells them apart (404 vs limited view).
  if (!organization) {
    const exists = await organizationsService.organizationExists({ id });

    if (!exists) {
      throw new NotFoundError("organization not found");
    }

    const { members } = await membersService.getOrganizationMembers({
      filters: { organizationId: id },
    });

    return c.json(
      {
        members: members.map(({ user: memberUser }) => ({
          user: {
            firstName: memberUser.firstName,
            lastName: memberUser.lastName,
            email: memberUser.email,
          },
        })),
      },
      StatusCodes.OK,
    );
  }

  const { members } = await membersService.getOrganizationMembers({
    filters: { organizationId: id },
  });

  return c.json({ members }, StatusCodes.OK);
});

organizationsRoutes.openapi(updateOrganizationRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { organization, membership } = await new OrganizationsService(
    db,
  ).getOrganizationById({
    id,
    userId: user.id,
  });

  if (!organization || !membership) {
    throw new NotFoundError("organization not found");
  }

  const allowed = checkLevelPermissions({
    level: "organization",
    permission: "organization:update",
    organizationRole: membership.role,
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to update this organization",
    );
  }

  const { organization: updatedOrganization } = await new OrganizationsService(
    db,
  ).updateOrganization({
    id,
    userId: user.id,
    ...body,
  });

  if (!updatedOrganization) {
    throw new NotFoundError("organization not found");
  }

  return c.json({ organization: updatedOrganization }, StatusCodes.OK);
});

organizationsRoutes.openapi(updateOrganizationLogoRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");
  const { logo } = c.req.valid("form");

  const service = new OrganizationsService(db);

  // Fetched up front so the caller gets the previous logo to clean up, the
  // membership role is available for the permission check, and a
  // missing/non-member organization fails before a file is written.
  const { organization: existing, membership } =
    await service.getOrganizationById({
      id,
      userId: user.id,
    });

  if (!existing || !membership) {
    throw new NotFoundError("organization not found");
  }

  const allowed = checkLevelPermissions({
    level: "organization",
    permission: "organization:update",
    organizationRole: membership.role,
  });

  if (!allowed) {
    throw new ForbiddenError(
      "you do not have permission to update this organization",
    );
  }

  const saveResult = await organizationLogoStorage.save(logo);

  if (!saveResult.ok) {
    return c.json(
      createErrorResponse({ message: saveResult.error }),
      StatusCodes.BAD_REQUEST,
    );
  }

  const { organization } = await service.updateOrganization({
    id,
    userId: user.id,
    logo: saveResult.asset.path,
  });

  // Should not happen after the membership check above, but don't leave the
  // saved file behind if it does.
  if (!organization) {
    await organizationLogoStorage.remove(saveResult.asset.path);
    throw new NotFoundError("organization not found");
  }

  // The new logo is committed; a failed removal of the old file must not fail
  // the request, it is only logged.
  if (existing.logo) {
    try {
      await organizationLogoStorage.remove(existing.logo);
    } catch (error) {
      logger.error(
        { err: toError(error) },
        "failed to remove previous organization logo",
      );
    }
  }

  return c.json({ organization }, StatusCodes.OK);
});

organizationsRoutes.openapi(createAccountRoute, async (c) => {
  const user = getContextUser(c);
  const body = c.req.valid("json");

  const { organization, workspace } = await new AccountsService(db).create({
    userId: user.id,
    organization: body.organization,
    workspace: body.workspace,
  });

  return c.json({ organization, workspace }, StatusCodes.CREATED);
});

export { organizationsRoutes };
