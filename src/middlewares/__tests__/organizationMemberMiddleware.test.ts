import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import { setContextUser, type AuthContext, type Session } from "../../utils/AuthContext";
import { getContextOrganizationMember } from "../../utils/organizationContext";
import { ForbiddenError } from "../../utils/ForbiddenError";
import { organizationMemberMiddleware } from "../organizationMemberMiddleware";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";

/**
 * Middleware tests for organizationMemberMiddleware, run in-process against
 * the test database. authMiddleware is replaced by a stub that seeds the
 * user context directly, since the middleware only consumes the user id.
 */

function buildApp(userId: string) {
  const app = new Hono<{ Variables: AuthContext }>();

  app.use(async (c, next) => {
    setContextUser(c, { id: userId } as Session["user"]);
    await next();
  });
  app.use(organizationMemberMiddleware);
  app.onError((error, c) => {
    if (error instanceof ForbiddenError) {
      return error.handle(c);
    }
    throw error;
  });
  app.get("/context", (c) => c.json(getContextOrganizationMember(c)));

  return app;
}

describe("organizationMemberMiddleware", () => {
  it("attaches the caller's organization membership to the context", async () => {
    const user = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      user.id,
    );
    const app = buildApp(user.id);

    const response = await app.request("/context", {
      headers: { "x-organization-id": organization.id },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; role: string };
    expect(body.id).toBe(membership.id);
    expect(body.role).toBe(membership.role);
  });

  it("rejects a signed in user who is not a member of the organization", async () => {
    const owner = await createTestUser(testDb);
    const outsider = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const app = buildApp(outsider.id);

    const response = await app.request("/context", {
      headers: { "x-organization-id": organization.id },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects requests without an organization id header", async () => {
    const user = await createTestUser(testDb);
    const app = buildApp(user.id);

    const response = await app.request("/context");

    expect(response.status).toBe(403);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe("x-organization-id header is missing");
  });
});
