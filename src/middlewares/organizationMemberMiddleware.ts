import { createMiddleware } from "hono/factory";
import { db } from "../db/connect";
import { getContextUser, type AuthContext } from "../utils/AuthContext";
import { ForbiddenError } from "../utils/ForbiddenError";
import {
  getOrganizationIdHeader,
  setContextOrganizationMember,
} from "../utils/organizationContext";
import { OrganizationsService } from "../services/organizationsService";

/**
 * Resolves the active organization from the request header, verifies the
 * signed in user is a member of it, and attaches the membership row to the
 * context. Throws ForbiddenError when the header is missing/invalid or the
 * user has no membership in that organization.
 *
 * MUST run before workspaceRoleMiddleware, which reads the membership row
 * this middleware puts on the context.
 */
const organizationMemberMiddleware = createMiddleware<{
  Variables: AuthContext;
}>(async (c, next) => {
  const organizationId = getOrganizationIdHeader(c);
  const user = getContextUser(c);

  const { membership } = await new OrganizationsService(db).getOrganizationById(
    {
      id: organizationId,
      userId: user.id,
    },
  );

  if (!membership) {
    throw new ForbiddenError("you are not a member of this organization");
  }

  setContextOrganizationMember(c, membership);

  await next();
});

export { organizationMemberMiddleware };
