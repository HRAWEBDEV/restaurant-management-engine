import { z } from "@hono/zod-openapi";

const errorResponseSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  description: z.string().optional(),
});

type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Builds an error response payload containing only the schema fields.
 */
function createErrorResponse(error: ErrorResponse): ErrorResponse {
  return {
    message: error.message,
    code: error.code,
    description: error.description,
  };
}

export { createErrorResponse, errorResponseSchema };
export type { ErrorResponse };
