import { createRoute, z, OpenAPIHono } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import {
  changePasswordSchema,
  selectUserSchema,
  signInWithEmailSchema,
  signUpWithEmailSchema,
} from "../../../../auth-schema";
import { createAccountResponseSchema } from "../../../services/accountsService";
import {
  createErrorResponse,
  errorResponseSchema,
} from "../../utils/apiErrorResponse";
import { StatusCodes } from "http-status-codes";
import { auth } from "../../../auth";
import { db } from "../../../db/connect";
import { AccountsService } from "../../../services/accountsService";

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

const signOutResponseSchema = z.object({
  success: z.boolean(),
});

const signOutRoute = createRoute({
  method: "post",
  path: "/sign-out",
  tags: ["auth"],
  summary: "Sign out the current session",
  description:
    "Revokes the current auth session and clears the session cookies.",
  responses: {
    200: {
      description: "Session signed out",
      content: {
        "application/json": {
          schema: signOutResponseSchema,
        },
      },
    },
    400: {
      description: "Session could not be revoked",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

authRoutes.openapi(signOutRoute, async (c) => {
  try {
    const { headers, response } = await auth.api.signOut({
      body: {},
      headers: c.req.raw.headers,
      returnHeaders: true,
    });

    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    return c.json(
      {
        success: response.success,
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
        StatusCodes.BAD_REQUEST,
      );
    }

    throw error;
  }
});

const changePasswordResponseSchema = z.object({
  token: z.string().nullable().optional(),
  user: selectUserSchema,
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/change-password",
  tags: ["auth"],
  summary: "Change the signed in user's password",
  description:
    "Requires the current password. With revokeOtherSessions, every other session of the user is revoked while the current one stays signed in.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: changePasswordSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Password changed",
      content: {
        "application/json": {
          schema: changePasswordResponseSchema,
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
      description: "Not signed in, or the current password is wrong",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

authRoutes.openapi(changePasswordRoute, async (c) => {
  const body = c.req.valid("json");

  try {
    const { headers, response } = await auth.api.changePassword({
      body,
      headers: c.req.raw.headers,
      returnHeaders: true,
    });

    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    // Better Auth's changePassword type omits the configured additional
    // fields, though the runtime user includes them.
    const user = response.user as typeof response.user & {
      firstName: string;
      lastName: string;
    };

    return c.json(
      {
        token: response.token,
        user: toAuthUser(user),
      },
      200,
    );
  } catch (error) {
    if (isAPIError(error)) {
      // Better Auth reports a wrong current password as BAD_REQUEST with
      // code INVALID_PASSWORD; surface it as 401 like sign-in failures.
      const status =
        error.statusCode === 401 || error.body?.code === "INVALID_PASSWORD"
          ? StatusCodes.UNAUTHORIZED
          : StatusCodes.BAD_REQUEST;

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

const createAccountWithOrganizationSchema = z.object({
  user: signUpWithEmailSchema,
  organization: z.object({
    name: z.string().min(1).max(100).openapi({ example: "Bella Vista" }),
    logo: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  }),
  workspace: z
    .object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().nullable().optional(),
    })
    .optional(),
});

const createAccountWithOrganizationResponseSchema = z.object({
  user: selectUserSchema,
  ...createAccountResponseSchema.shape,
});

const createAccountWithOrganizationRoute = createRoute({
  method: "post",
  path: "/account",
  tags: ["auth"],
  summary: "Create a user account with an organization and default workspace",
  description:
    "Signs the user up, creates their organization (owner membership included) and a default workspace (admin membership included), then attaches the auth session cookies.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createAccountWithOrganizationSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Account, organization and default workspace created",
      content: {
        "application/json": {
          schema: createAccountWithOrganizationResponseSchema,
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

authRoutes.openapi(createAccountWithOrganizationRoute, async (c) => {
  const body = c.req.valid("json");

  try {
    const { headers, response } = await auth.api.signUpEmail({
      body: body.user,
      headers: c.req.raw.headers,
      returnHeaders: true,
    });

    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    const { organization, workspace } = await new AccountsService(db).create({
      userId: response.user.id,
      organization: body.organization,
      workspace: body.workspace,
    });

    return c.json(
      {
        user: toAuthUser(response.user),
        organization,
        workspace,
      },
      StatusCodes.CREATED,
    );
  } catch (error) {
    if (isAPIError(error)) {
      return c.json(
        createErrorResponse({
          message: error.body?.message ?? error.message,
          code: error.body?.code,
        }),
        error.statusCode === 422
          ? StatusCodes.UNPROCESSABLE_ENTITY
          : StatusCodes.BAD_REQUEST,
      );
    }

    throw error;
  }
});

export { authRoutes };
