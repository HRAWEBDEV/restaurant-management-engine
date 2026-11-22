import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import { updateUserInfoSchema } from "../../../../auth-schema";
import { NotFoundError } from "../../../utils/NotFoundError";
import {
  getUserByIdResponseSchema,
  updateUserInfoResponseSchema,
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

const updateUserInfoRoute = createRoute({
  method: "patch",
  path: "/info",
  tags: ["users"],
  summary: "Update the signed in user's info",
  description:
    "Updates the session user's name, first/last name, username, and/or image. The user id is taken from the session, never from the request. Email is not mutable here; it changes only through the verified change-email flow.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateUserInfoSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "User updated, or unchanged when no fields were set",
      content: {
        "application/json": {
          schema: updateUserInfoResponseSchema,
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
    409: {
      description: "The requested username is already taken",
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

usersRoutes.openapi(updateUserInfoRoute, async (c) => {
  const user = getContextUser(c);
  const body = c.req.valid("json");

  const { user: updatedUser } = await new UsersService(db).updateUserInfo({
    id: user.id,
    ...body,
  });

  if (!updatedUser) {
    throw new NotFoundError("user not found");
  }

  return c.json({ user: updatedUser }, StatusCodes.OK);
});

export { usersRoutes };
