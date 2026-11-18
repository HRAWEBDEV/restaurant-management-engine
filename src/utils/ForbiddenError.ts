import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { createErrorResponse } from "../v1/utils/apiErrorResponse";

/**
 * Thrown when the caller is authenticated but not allowed to perform the
 * requested action.
 */
class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";

  constructor(message: string = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }

  /**
   * Renders this error as an API error response.
   */
  handle(c: Context) {
    return c.json(
      createErrorResponse({ message: this.message, code: this.code }),
      StatusCodes.FORBIDDEN,
    );
  }
}

export { ForbiddenError };
