import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
  getUserByIdResponseSchema,
  UsersService,
} from "../../../services/usersService";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

const usersRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/users");

const getUserInfoRoute = createRoute({
  method: "get",
  path: "/info",
  tags: ["users"],
  summary: "Get the signed in user's info",
  description:
    "Returns the session user's profile. The user id is taken from the session, never from the request.",
  responses: {
    200: {
      description: "Signed in user's info",
      content: {
        "application/json": {
          schema: getUserByIdResponseSchema,
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

usersRoutes.openapi(getUserInfoRoute, async (c) => {
  const user = getContextUser(c);

  const { user: foundUser } = await new UsersService(db).getUserById({
    id: user.id,
  });

  return c.json({ user: foundUser }, StatusCodes.OK);
});

export { usersRoutes };
