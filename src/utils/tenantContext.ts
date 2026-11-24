import { organizationIdHeaderSchema } from "./organizationContext";
import { workspaceIdHeaderSchema } from "./workspaceContext";

/**
 * Both tenant headers required by workspace-scoped routes, declared (not
 * validated) so they show up as required parameters in the OpenAPI document
 * and Swagger UI. The headers themselves are enforced by the tenant
 * middlewares — organizationMemberMiddleware resolves the organization
 * membership, then workspaceRoleMiddleware the effective workspace role —
 * which run before validation and reject a missing or invalid header with
 * 403. For every route mounted after both middlewares.
 */
const tenantHeadersSchema = organizationIdHeaderSchema.extend(
  workspaceIdHeaderSchema.shape,
);

export { tenantHeadersSchema };
