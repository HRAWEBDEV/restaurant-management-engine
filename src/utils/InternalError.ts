import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { createErrorResponse } from "../v1/utils/apiErrorResponse";

/**
 * Thrown for unexpected server failures. The original error is logged by the
 * global error handler, never exposed to the client.
 */
class InternalError extends Error {
  readonly code = "INTERNAL_SERVER_ERROR";

  constructor(message: string = "internal server error") {
    super(message);
    this.name = "InternalError";
  }

  /**
   * Renders this error as an API error response.
   */
  handle(c: Context) {
    return c.json(
      createErrorResponse({ message: this.message, code: this.code }),
      StatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
}

export { InternalError };
