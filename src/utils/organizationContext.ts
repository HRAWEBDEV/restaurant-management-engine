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
  getOrganizationIdHeader,
  setContextOrganizationMember,
  getContextOrganizationMember,
};
