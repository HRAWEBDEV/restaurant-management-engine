import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { ForbiddenError } from "./ForbiddenError";
import { type OrganizationMember } from "../db/schemas/organizationMembers";
import { CONTEXT_USER_ORGANIZATION_MEMBER, type AuthContext } from "./AuthContext";

const ORGANIZATION_ID_HEADER = "x-organization-id";

const organizationIdSchema = z.uuid();

function getOrganizationIdHeader(
  c: Context<{
    Variables: AuthContext;
  }>,
) {
  const headerValue = c.req.header(ORGANIZATION_ID_HEADER);
  if (!headerValue) {
    throw new ForbiddenError(`${ORGANIZATION_ID_HEADER} header is missing`);
  }
  const parsed = organizationIdSchema.safeParse(headerValue);
  if (!parsed.success) {
    throw new ForbiddenError(
      `${ORGANIZATION_ID_HEADER} header is not a valid organization id`,
    );
  }
  return parsed.data;
}

/**
 * Declared (not validated) so the tenant header shows up as a required
 * parameter in the OpenAPI document and Swagger UI. The header itself is
 * enforced by organizationMemberMiddleware, which runs before this
 * validation and rejects a missing or invalid header with 403.
 */
const organizationIdHeaderSchema = z.object({
  [ORGANIZATION_ID_HEADER]: z.uuid().openapi({
    description:
      "Active organization for this request; membership and permissions are resolved from it.",
    example: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  }),
});

function setContextOrganizationMember(
  c: Context<{
    Variables: AuthContext;
  }>,
  member: OrganizationMember,
) {
  c.set(CONTEXT_USER_ORGANIZATION_MEMBER, member);
}

function getContextOrganizationMember(
  c: Context<{
    Variables: AuthContext;
  }>,
) {
  const member = c.get(CONTEXT_USER_ORGANIZATION_MEMBER);
  if (!member) throw new Error("organization member context is not set");
  return member;
}

export {
  ORGANIZATION_ID_HEADER,
  organizationIdHeaderSchema,
  getOrganizationIdHeader,
  setContextOrganizationMember,
  getContextOrganizationMember,
};
