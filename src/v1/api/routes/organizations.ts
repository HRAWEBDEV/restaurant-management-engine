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
import { errorResponseSchema } from "../../utils/apiErrorResponse";

const organizationsRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/organizations");

const createAccountBodySchema = z.object({
  organization: createAccountOrganizationSchema,
  workspace: createAccountWorkspaceSchema.optional(),
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
