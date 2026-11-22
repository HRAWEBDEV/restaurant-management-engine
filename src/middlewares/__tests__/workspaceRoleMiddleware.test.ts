import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import { setContextUser, type AuthContext, type Session } from "../../utils/AuthContext";
import { getContextOrganizationMember } from "../../utils/organizationContext";
import { getContextWorkspaceRole } from "../../utils/workspaceContext";
import { ForbiddenError } from "../../utils/ForbiddenError";
import { organizationMemberMiddleware } from "../organizationMemberMiddleware";
import { workspaceRoleMiddleware } from "../workspaceRoleMiddleware";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";

/**
 * Middleware tests for workspaceRoleMiddleware, run in-process against the
 * test database and chained after organizationMemberMiddleware exactly as
 * production mounts them. authMiddleware is replaced by a stub that seeds
 * the user context directly, since the middlewares only consume the user id.
 */

function buildApp(userId: string) {
  const app = new Hono<{ Variables: AuthContext }>();

  app.use(async (c, next) => {
    setContextUser(c, { id: userId } as Session["user"]);
    await next();
  });
  app.use(organizationMemberMiddleware);
  app.use(workspaceRoleMiddleware);
  app.onError((error, c) => {
    if (error instanceof ForbiddenError) {
      return error.handle(c);
    }
    throw error;
  });
  app.get("/context", (c) =>
    c.json({
      role: getContextWorkspaceRole(c),
      organizationMemberId: getContextOrganizationMember(c).id,
    }),
  );

  return app;
}

describe("workspaceRoleMiddleware", () => {
  it("attaches the caller's workspace membership role to the context", async () => {
    const owner = await createTestUser(testDb);
    const member = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: member.id,
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: memberMembership.id,
      organizationId: organization.id,
      role: "member",
    });
    const app = buildApp(member.id);

    const response = await app.request("/context", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      role: "member",
      organizationMemberId: memberMembership.id,
    });
    expect(memberMembership.id).not.toBe(membership.id);
  });

  it("grants organization owners an implicit admin role without workspace membership", async () => {
    const owner = await createTestUser(testDb);
    const coOwner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const coOwnerMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: coOwner.id,
      role: "owner",
    });
    const app = buildApp(coOwner.id);

    const response = await app.request("/context", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      role: "admin",
      organizationMemberId: coOwnerMembership.id,
    });
  });

  it("rejects a workspace that belongs to another organization", async () => {
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { organization: organizationA } = await createTestOrganization(
      testDb,
      ownerA.id,
    );
    const { organization: organizationB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );
    const workspaceB = await createTestWorkspace(
      testDb,
      organizationB.id,
      ownerB.id,
    );
    // owner of org A but also a plain member of org B, where the workspace
    // lives; the owner short-circuit must not leak across organizations
    await addOrganizationMember(testDb, {
      organizationId: organizationB.id,
      userId: ownerA.id,
    });
    const app = buildApp(ownerA.id);

    const response = await app.request("/context", {
      headers: {
        "x-organization-id": organizationA.id,
        "x-workspace-id": workspaceB.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects an organization member who is not a workspace member", async () => {
    const owner = await createTestUser(testDb);
    const member = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: member.id,
    });
    const app = buildApp(member.id);

    const response = await app.request("/context", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects a signed in user who is not a member of the organization", async () => {
    const owner = await createTestUser(testDb);
    const outsider = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const app = buildApp(outsider.id);

    const response = await app.request("/context", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects requests without a workspace id header", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const app = buildApp(owner.id);

    const response = await app.request("/context", {
      headers: { "x-organization-id": organization.id },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe("x-workspace-id header is missing");
  });
});
