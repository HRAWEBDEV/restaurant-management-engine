import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { createErrorResponse } from "../v1/utils/apiErrorResponse";

/**
 * Thrown when a request conflicts with existing state, such as a uniqueness
 * violation on a client-chosen value.
 */
class ConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(message: string = "resource conflict") {
    super(message);
    this.name = "ConflictError";
  }

  /**
   * Renders this error as an API error response.
   */
  handle(c: Context) {
    return c.json(
      createErrorResponse({ message: this.message, code: this.code }),
      StatusCodes.CONFLICT,
    );
  }
}

export { ConflictError };
