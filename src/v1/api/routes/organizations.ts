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
import { NotFoundError } from "../../../utils/NotFoundError";
import {
  getOrganizationByIdResponseSchema,
  getOrganizationsResponseSchema,
  OrganizationsService,
  updateOrganizationResponseSchema,
  updateOrganizationSchema,
} from "../../../services/organizationsService";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

const organizationsRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/organizations");

const createAccountBodySchema = z.object({
  organization: createAccountOrganizationSchema,
  workspace: createAccountWorkspaceSchema.optional(),
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
    "Returns a single organization when it exists and the session user is a member of it. Requests outside the caller's memberships are reported as not found.",
  request: {
    params: z.object({
      id: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Organization details",
      content: {
        "application/json": {
          schema: getOrganizationByIdResponseSchema,
        },
      },
    },
    404: {
      description: "Organization not found, or the caller is not a member of it",
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
    "Updates the name, logo, and/or description. A changed name regenerates the organization slug. Requests outside the caller's memberships are reported as not found.",
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
    404: {
      description: "Organization not found, or the caller is not a member of it",
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

  const { organization } = await new OrganizationsService(db)
    .getOrganizationById({
      id,
      userId: user.id,
    });

  if (!organization) {
    throw new NotFoundError("organization not found");
  }

  return c.json({ organization }, StatusCodes.OK);
});

organizationsRoutes.openapi(updateOrganizationRoute, async (c) => {
  const user = getContextUser(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { organization } = await new OrganizationsService(db)
    .updateOrganization({
      id,
      userId: user.id,
      ...body,
    });

  if (!organization) {
    throw new NotFoundError("organization not found");
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
