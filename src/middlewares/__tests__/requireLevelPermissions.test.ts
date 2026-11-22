import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import { setContextUser, type AuthContext, type Session } from "../../utils/AuthContext";
import { ForbiddenError } from "../../utils/ForbiddenError";
import { organizationMemberMiddleware } from "../organizationMemberMiddleware";
import { workspaceRoleMiddleware } from "../workspaceRoleMiddleware";
import { requireLevelPermissions } from "../requireLevelPermissions";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";

/**
 * Middleware tests for requireLevelPermissions, run in-process against the
 * test database and chained after the tenant middlewares exactly as
 * production mounts them. authMiddleware is replaced by a stub that seeds
 * the user context directly, since the chain only consumes the user id.
 */

function buildApp(
  userId: string,
  level: "organization" | "workspace" | "organizationWorkspace",
  permission: string,
) {
  const app = new Hono<{ Variables: AuthContext }>();

  app.use(async (c, next) => {
    setContextUser(c, { id: userId } as Session["user"]);
    await next();
  });
  app.use(organizationMemberMiddleware);
  app.use(workspaceRoleMiddleware);
  app.use(requireLevelPermissions({ level, permission: permission as never }));
  app.onError((error, c) => {
    if (error instanceof ForbiddenError) {
      return error.handle(c);
    }
    throw error;
  });
  app.get("/gated", (c) => c.json({ ok: true }));

  return app;
}

describe("requireLevelPermissions", () => {
  it("allows a workspace admin to pass a workspace-level check", async () => {
    const owner = await createTestUser(testDb);
    const admin = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const adminMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: admin.id,
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: adminMembership.id,
      organizationId: organization.id,
      role: "admin",
    });
    const app = buildApp(admin.id, "workspace", "catalog:manage");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a workspace member whose role lacks the permission", async () => {
    const owner = await createTestUser(testDb);
    const member = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
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
    const app = buildApp(member.id, "workspace", "catalog:manage");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("FORBIDDEN");
    expect(body.message).toBe("missing permission: catalog:manage");
  });

  it("allows the organization owner to pass an organization-level check", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const app = buildApp(owner.id, "organization", "workspace:create");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a non-owner organization member at the organization level", async () => {
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
    const app = buildApp(member.id, "organization", "workspace:create");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("allows the organization owner to pass a workspace-level check via the implicit admin role", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const app = buildApp(owner.id, "workspace", "catalog:manage");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects a workspace member at the organizationWorkspace level when neither level grants the permission", async () => {
    const owner = await createTestUser(testDb);
    const member = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
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
    const app = buildApp(member.id, "organizationWorkspace", "workspace:update");

    const response = await app.request("/gated", {
      headers: {
        "x-organization-id": organization.id,
        "x-workspace-id": workspace.id,
      },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });
});
