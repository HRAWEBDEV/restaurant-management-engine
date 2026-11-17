import { createMiddleware } from "hono/factory";
import { StatusCodes } from "http-status-codes";
import { createErrorResponse } from "../v1/utils/apiErrorResponse";
import { auth } from "../auth";
import {
  type AuthContext,
  setContextSession,
  setContextUser,
} from "../utils/AuthContext";

/**
 * Resolves the Better Auth session from the request (cookie or bearer token)
 * and attaches the signed in user and session to the context.
 */
const authMiddleware = createMiddleware<{ Variables: AuthContext }>(
  async (c, next) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session) {
      return c.json(
        createErrorResponse({
          message: "you are not signed in",
          code: "NOT_SIGNED_IN",
        }),
        StatusCodes.UNAUTHORIZED,
      );
    }

    setContextUser(c, session.user);
    setContextSession(c, session.session);

    await next();
  },
);

export { authMiddleware };
