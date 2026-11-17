import { createRoute, z, OpenAPIHono } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import {
  selectUserSchema,
  signUpWithEmailSchema,
} from "../../../../auth-schema";
import { auth } from "../../../auth";

const authRoutes = new OpenAPIHono().basePath("/auth");

const signUpWithEmailResponseSchema = z.object({
  token: z.string().nullable(),
  user: selectUserSchema,
});

const errorResponseSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

const signUpWithEmailRoute = createRoute({
  method: "post",
  path: "/sign-up/email",
  tags: ["auth"],
  summary: "Sign up with email and password",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: signUpWithEmailSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "User created and signed in",
      content: {
        "application/json": {
          schema: signUpWithEmailResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input or username already taken",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    422: {
      description: "User already exists or could not be created",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

authRoutes.openapi(signUpWithEmailRoute, async (c) => {
  const body = c.req.valid("json");

  try {
    const { headers, response } = await auth.api.signUpEmail({
      body,
      headers: c.req.raw.headers,
      returnHeaders: true,
    });

    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    const { user } = response;

    return c.json(
      {
        token: response.token,
        user: {
          ...user,
          image: user.image ?? null,
          username: user.username ?? null,
          displayUsername: user.displayUsername ?? null,
        },
      },
      200,
    );
  } catch (error) {
    if (isAPIError(error)) {
      return c.json(
        {
          message: error.body?.message ?? error.message,
          code: error.body?.code,
        },
        error.statusCode === 422 ? 422 : 400,
      );
    }

    throw error;
  }
});

export { authRoutes };
