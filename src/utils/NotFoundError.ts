import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { createErrorResponse } from "../v1/utils/apiErrorResponse";

/**
 * Thrown when the requested resource does not exist.
 */
class NotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(message: string = "resource not found") {
    super(message);
    this.name = "NotFoundError";
  }

  /**
   * Renders this error as an API error response.
   */
  handle(c: Context) {
    return c.json(
      createErrorResponse({ message: this.message, code: this.code }),
      StatusCodes.NOT_FOUND,
    );
  }
}

export { NotFoundError };
