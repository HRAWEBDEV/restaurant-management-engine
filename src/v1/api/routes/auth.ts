import { createRoute, z, OpenAPIHono } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import {
  selectUserSchema,
  signInWithEmailSchema,
  signUpWithEmailSchema,
} from "../../../../auth-schema";
import {
  createErrorResponse,
  errorResponseSchema,
} from "../../utils/apiErrorResponse";
import { auth } from "../../../auth";

const authRoutes = new OpenAPIHono().basePath("/auth");

const signUpWithEmailResponseSchema = z.object({
  token: z.string().nullable(),
  user: selectUserSchema,
});

function toAuthUser<
  T extends {
    image?: string | null;
    username?: string | null;
    displayUsername?: string | null;
  },
>(user: T) {
  return {
    ...user,
    image: user.image ?? null,
    username: user.username ?? null,
    displayUsername: user.displayUsername ?? null,
  };
}

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
        user: toAuthUser(user),
      },
      200,
    );
  } catch (error) {
    if (isAPIError(error)) {
      return c.json(
        createErrorResponse({
          message: error.body?.message ?? error.message,
          code: error.body?.code,
        }),
        error.statusCode === 422 ? 422 : 400,
      );
    }

    throw error;
  }
});

const signInWithEmailResponseSchema = z.object({
  redirect: z.boolean(),
  token: z.string(),
  url: z.string().optional(),
  user: selectUserSchema,
});

const signInWithEmailRoute = createRoute({
  method: "post",
  path: "/sign-in/email",
  tags: ["auth"],
  summary: "Sign in with email and password",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: signInWithEmailSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "User signed in",
      content: {
        "application/json": {
          schema: signInWithEmailResponseSchema,
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
      description: "Invalid email or password",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description: "Email not verified",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

authRoutes.openapi(signInWithEmailRoute, async (c) => {
  const body = c.req.valid("json");

  try {
    const { headers, response } = await auth.api.signInEmail({
      body,
      headers: c.req.raw.headers,
      returnHeaders: true,
    });

    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    return c.json(
      {
        redirect: response.redirect,
        token: response.token,
        url: response.url,
        user: toAuthUser(response.user),
      },
      200,
    );
  } catch (error) {
    if (isAPIError(error)) {
      const status =
        error.statusCode === 401 ? 401 : error.statusCode === 403 ? 403 : 400;

      return c.json(
        createErrorResponse({
          message: error.body?.message ?? error.message,
          code: error.body?.code,
        }),
        status,
      );
    }

    throw error;
  }
});

export { authRoutes };
