import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
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
import { AssetStorage } from "../../../utils/assetStorage";
import { createErrorResponse, errorResponseSchema } from "../../utils/apiErrorResponse";

const usersRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>().basePath("/users");

/** MIME types and size limit accepted for user profile images. */
const USER_IMAGE_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const USER_IMAGE_MAX_SIZE = 2 * 1024 * 1024;

/**
 * Stores user profile images under `static/users/images`, publicly served
 * from `/static/users/images/...`.
 */
const userImageStorage = new AssetStorage({
  subPath: "users/images",
  fileTypes: [...USER_IMAGE_FILE_TYPES],
  maxSize: USER_IMAGE_MAX_SIZE,
});

const updateUserImageBodySchema = z.object({
  image: z
    .file()
    .mime([...USER_IMAGE_FILE_TYPES])
    .max(USER_IMAGE_MAX_SIZE)
    // z.file() needs an explicit OpenAPI type for document generation
    .openapi({ type: "string", format: "binary" }),
});

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

const updateUserImageRoute = createRoute({
  method: "put",
  path: "/image",
  tags: ["users"],
  summary: "Update the signed in user's profile image",
  description:
    "Accepts a multipart form with an image file (png, jpeg, or webp, up to 2 MB), stores it under static/users/images, updates the user's image, and deletes the replaced image file. The user id is taken from the session, never from the request.",
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: updateUserImageBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "User image updated",
      content: {
        "application/json": {
          schema: updateUserInfoResponseSchema,
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

usersRoutes.openapi(updateUserImageRoute, async (c) => {
  const user = getContextUser(c);
  const { image } = c.req.valid("form");

  const service = new UsersService(db);

  // Fetched up front so the caller gets the previous image to clean up and a
  // missing user fails before a file is written.
  const { user: existing } = await service.getUserById({ id: user.id });

  if (!existing) {
    throw new NotFoundError("user not found");
  }

  const saveResult = await userImageStorage.save(image);

  if (!saveResult.ok) {
    return c.json(
      createErrorResponse({ message: saveResult.error }),
      StatusCodes.BAD_REQUEST,
    );
  }

  const { user: updatedUser } = await service.updateUserInfo({
    id: user.id,
    image: saveResult.asset.path,
  });

  // Should not happen after the lookup above, but don't leave the saved file
  // behind if it does.
  if (!updatedUser) {
    await userImageStorage.remove(saveResult.asset.path);
    throw new NotFoundError("user not found");
  }

  // The new image is committed; a failed removal of the old file must not fail
  // the request, it is only logged. Images that are not stored under
  // static/users/images (e.g. external avatar URLs) are left alone by remove.
  if (existing.image) {
    try {
      await userImageStorage.remove(existing.image);
    } catch (error) {
      console.error("failed to remove previous user image", error);
    }
  }

  return c.json({ user: updatedUser }, StatusCodes.OK);
});

export { usersRoutes };
