import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { apiV1Routes } from "../../index";
import { testDb } from "../../../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
  createTestWorkspace,
} from "../../../../db/__tests__/helpers/factories";
import { activityLogs } from "../../../../db/schemas/activityLogs";
import { workspaceMembers } from "../../../../db/schemas/workspaceMembers";
import { workspaces } from "../../../../db/schemas/workspaces";

/**
 * Route tests for /api/v1/workspaces, driven through the full apiV1 app so
 * authMiddleware, routing, validation, and error handlers run exactly as
 * production. Sessions are carried by replaying the sign-up cookies.
 */

const app = apiV1Routes;

function jsonHeaders() {
  return { "content-type": "application/json" };
}

/** Collects Set-Cookie pairs into a Cookie header for the next request. */
function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Parses a response body with the shape the test asserts on. */
async function jsonBody<T extends object = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  return (await response.json()) as T;
}

/** Unique sign-up payload; lowercase keeps Better Auth's normalization happy. */
function signUpBody() {
  const id = nanoid(12).replaceAll("-", "").toLowerCase();
  return {
    name: `Test User ${id}`,
    email: `${id}@example.com`,
    password: "supersecret",
    username: `user_${id}`,
    firstName: "Test",
    lastName: "User",
  };
}

/** Signs up through the api and returns the cookie jar for the new session. */
async function signUp() {
  const credentials = signUpBody();
  const response = await app.request("/api/v1/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(credentials),
  });
  if (response.status !== 200) {
    throw new Error(`sign up failed with status ${response.status}`);
  }
  const body = await jsonBody<{ user: { id: string } }>(response);
  return { userId: body.user.id, credentials, cookie: cookieFrom(response) };
}

/** Creates an organization (and default workspace) for the signed in user. */
async function createOrganization(cookie: string) {
  const response = await app.request("/api/v1/organizations/account", {
    method: "POST",
    headers: { ...jsonHeaders(), cookie },
    body: JSON.stringify({
      organization: { name: `Acme ${nanoid(8)}` },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`organization creation failed with status ${response.status}`);
  }
  return jsonBody<{
    organization: { id: string };
    workspace: { id: string; name: string; slug: string };
  }>(response);
}

describe("authentication guard", () => {
  it("rejects workspace requests without a session with 401", async () => {
    const response = await app.request("/api/v1/workspaces");

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});

describe("GET /workspaces", () => {
  it("lists only the workspaces reachable through the caller's organizations", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const createdA = await createOrganization(userA.cookie);
    await createOrganization(userB.cookie);

    const response = await app.request("/api/v1/workspaces", {
      headers: { cookie: userA.cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      workspaces: Array<{
        workspace: { id: string };
        organization: { id: string };
        member: { role: string };
      }>;
    }>(response);
    const ids = body.workspaces.map(
      (entry) => entry.workspace.id,
    );
    expect(ids).toContain(createdA.workspace.id);
    expect(ids).toHaveLength(1);
    expect(body.workspaces[0]?.organization.id).toBe(createdA.organization.id);
    expect(body.workspaces[0]?.member.role).toBe("owner");
  });
});

describe("POST /workspaces", () => {
  it("lets an organization owner create a workspace and adds them as its workspace admin with an audit row", async () => {
    const { cookie, userId } = await signUp();
    const { organization } = await createOrganization(cookie);
    const name = `Kitchen ${nanoid(8)}`;

    const response = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ organizationId: organization.id, name }),
    });

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      workspace: {
        id: string;
        organizationId: string;
        name: string;
        slug: string;
        createdBy: string;
      };
    }>(response);
    expect(body.workspace.organizationId).toBe(organization.id);
    expect(body.workspace.name).toBe(name);
    expect(body.workspace.slug).toContain("kitchen-");
    expect(body.workspace.createdBy).toBe(userId);

    const [row] = await testDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, body.workspace.id));
    expect(row?.name).toBe(name);
    expect(row?.slug).toBe(body.workspace.slug);

    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, body.workspace.id));
    expect(membership?.role).toBe("admin");
    expect(membership?.organizationId).toBe(organization.id);

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, body.workspace.id));
    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: body.workspace.id,
      actorUserId: userId,
      action: "created",
      entityType: "workspace",
      entityId: body.workspace.id,
    });
  });

  it("reports an organization outside the caller's memberships as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);

    const response = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie: userB.cookie },
      body: JSON.stringify({
        organizationId: organization.id,
        name: `Kitchen ${nanoid(8)}`,
      }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects a plain organization member with 403", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization } = await createOrganization(owner.cookie);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });

    const response = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie: memberUser.cookie },
      body: JSON.stringify({
        organizationId: organization.id,
        name: `Kitchen ${nanoid(8)}`,
      }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects invalid input with 400", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const response = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ organizationId: organization.id, name: "" }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects requests without a session with 401", async () => {
    const response = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        organizationId: "11111111-1111-4111-8111-111111111111",
        name: "Kitchen",
      }),
    });

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});

describe("GET /workspaces/{id}", () => {
  it("returns the workspace with its organization and the caller's membership rows", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      workspace: { id: string };
      organization: { id: string };
      membership: { role: string };
      workspaceMembership: { role: string } | null;
    }>(response);
    expect(body.workspace.id).toBe(workspace.id);
    expect(body.organization.id).toBeTruthy();
    expect(body.membership.role).toBe("owner");
    expect(body.workspaceMembership?.role).toBe("admin");
  });

  it("reports a workspace outside the caller's organizations as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { workspace } = await createOrganization(userB.cookie);

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      headers: { cookie: userA.cookie },
    });

    expect(response.status).toBe(404);
  });
});

describe("PATCH /workspaces/{id}", () => {
  it("lets an organization owner update the workspace and regenerate the slug", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);
    const newName = `Renamed ${nanoid(8)}`;

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ name: newName }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      workspace: { name: string; slug: string };
    }>(response);
    expect(body.workspace.name).toBe(newName);
    expect(body.workspace.slug).not.toBe(workspace.slug);

    const [row] = await testDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id));
    expect(row?.name).toBe(newName);
    expect(row?.slug).toBe(body.workspace.slug);
  });

  it("lets a workspace admin update the workspace even as a plain organization member", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { workspace, organization } = await createOrganization(userA.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: userB.userId,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: membership.organizationId,
      role: "admin",
    });
    const newName = `Renamed ${nanoid(8)}`;

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie: userB.cookie },
      body: JSON.stringify({ name: newName }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ workspace: { name: string } }>(response);
    expect(body.workspace.name).toBe(newName);
  });

  it("rejects a caller whose roles do not grant workspace:update with 403", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { workspace, organization } = await createOrganization(userA.cookie);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: userB.userId,
      role: "member",
    });

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie: userB.cookie },
      body: JSON.stringify({ name: `Renamed ${nanoid(8)}` }),
    });

    expect(response.status).toBe(403);
  });

  it("reports a workspace outside the caller's organizations as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { workspace } = await createOrganization(userA.cookie);

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie: userB.cookie },
      body: JSON.stringify({ name: `Renamed ${nanoid(8)}` }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects invalid input with 400", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);

    const response = await app.request(`/api/v1/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ name: "" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /workspaces/{id}/members", () => {
  it("lists the workspace's members with their joined rows, oldest join first", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
      addedBy: owner.userId,
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
      addedBy: owner.userId,
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members`,
      { headers: { cookie: owner.cookie } },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      members: Array<{
        member: { workspaceId: string; role: string; addedBy: string | null };
        workspace: { id: string };
        organization: { id: string };
        user: { id: string };
        addedByUser: { id: string } | null;
      }>;
    }>(response);
    expect(body.members).toHaveLength(2);
    expect(body.members[0]?.user.id).toBe(owner.userId);
    expect(body.members[0]?.member.role).toBe("admin");
    expect(body.members[0]?.addedByUser?.id).toBe(owner.userId);
    expect(body.members[1]?.user.id).toBe(memberUser.userId);
    expect(body.members[1]?.member.role).toBe("member");
    expect(body.members[1]?.member.addedBy).toBe(owner.userId);
    expect(body.members[1]?.addedByUser?.id).toBe(owner.userId);
    expect(body.members[1]?.workspace.id).toBe(workspace.id);
    expect(body.members[1]?.organization.id).toBe(organization.id);
  });

  it("reports an unknown workspace as 404", async () => {
    const { cookie } = await signUp();

    const response = await app.request(
      "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/members",
      { headers: { cookie } },
    );

    expect(response.status).toBe(404);
  });

  it("reports a workspace outside the caller's organizations as 404", async () => {
    const owner = await signUp();
    const outsider = await signUp();
    const { workspace } = await createOrganization(owner.cookie);

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members`,
      { headers: { cookie: outsider.cookie } },
    );

    expect(response.status).toBe(404);
  });

  it("rejects member requests without a session with 401", async () => {
    const response = await app.request(
      "/api/v1/workspaces/00000000-0000-4000-8000-000000000000/members",
    );

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});

describe("PATCH /workspaces/{id}/members/{memberId}", () => {
  it("lets the organization owner change a member's role and writes an audit row", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${workspaceMembership.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: owner.cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ member: { id: string; role: string } }>(
      response,
    );
    expect(body.member.id).toBe(workspaceMembership.id);
    expect(body.member.role).toBe("admin");

    const [row] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, workspaceMembership.id));
    expect(row?.role).toBe("admin");

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, workspaceMembership.id));
    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.userId,
      action: "updated",
      entityType: "workspace_member",
      entityId: workspaceMembership.id,
      changes: { role: { from: "member", to: "admin" } },
    });
  });

  it("lets an organization owner who is not a workspace member change a member's role", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    // Account setup makes the owner a workspace member; drop that row so only
    // the implicit owner grant is at play.
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${workspaceMembership.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: owner.cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ member: { role: string } }>(response);
    expect(body.member.role).toBe("admin");
  });

  it("lets a workspace admin change a member's role even as a plain organization member", async () => {
    const owner = await signUp();
    const adminUser = await signUp();
    const targetUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const adminMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: adminUser.userId,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: adminMembership.id,
      organizationId: organization.id,
      role: "admin",
    });
    const targetMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: targetUser.userId,
      role: "member",
    });
    const target = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: targetMembership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: adminUser.cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ member: { role: string } }>(response);
    expect(body.member.role).toBe("admin");
  });

  it("rejects a plain workspace member with 403", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const targetUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });
    const targetMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: targetUser.userId,
      role: "member",
    });
    const target = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: targetMembership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: memberUser.cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("rejects a workspace admin changing their own role with 403", async () => {
    const owner = await signUp();
    const adminUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const adminMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: adminUser.userId,
      role: "member",
    });
    const adminWorkspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: adminMembership.id,
      organizationId: organization.id,
      role: "admin",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${adminWorkspaceMembership.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: adminUser.cookie },
        body: JSON.stringify({ role: "member" }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("reports a membership from another workspace as 404", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const otherWorkspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.userId,
    );
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const otherWorkspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: otherWorkspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${otherWorkspaceMembership.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: owner.cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("reports an unknown membership id as 404", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);

    const response = await app.request(
      `/api/v1/workspaces/${
        workspace.id
      }/members/22222222-2222-4222-8222-222222222222`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("rejects invalid role values with 400", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);

    const response = await app.request(
      `/api/v1/workspaces/${
        workspace.id
      }/members/33333333-3333-4333-8333-333333333333`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie },
        body: JSON.stringify({ role: "owner" }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("rejects requests without a session with 401", async () => {
    const response = await app.request(
      "/api/v1/workspaces/44444444-4444-4444-8444-444444444444/members/55555555-5555-4555-8555-555555555555",
      {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});

describe("DELETE /workspaces/{id}/members/{memberId}", () => {
  it("lets the organization owner remove a member and writes an audit row", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
      addedBy: owner.userId,
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${workspaceMembership.id}`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ member: { id: string; role: string } }>(
      response,
    );
    expect(body.member.id).toBe(workspaceMembership.id);

    const [row] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, workspaceMembership.id));
    expect(row).toBeUndefined();

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, workspaceMembership.id));
    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.userId,
      action: "deleted",
      entityType: "workspace_member",
      entityId: workspaceMembership.id,
      changes: { role: { from: "member", to: null } },
    });
  });

  it("lets an organization owner who is not a workspace member remove a member", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    // Account setup makes the owner a workspace member; drop that row so only
    // the implicit owner grant is at play.
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${workspaceMembership.id}`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ member: { id: string } }>(response);
    expect(body.member.id).toBe(workspaceMembership.id);

    const [row] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, workspaceMembership.id));
    expect(row).toBeUndefined();
  });

  it("lets a workspace admin remove a member", async () => {
    const owner = await signUp();
    const adminUser = await signUp();
    const targetUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const adminMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: adminUser.userId,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: adminMembership.id,
      organizationId: organization.id,
      role: "admin",
    });
    const targetMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: targetUser.userId,
      role: "member",
    });
    const target = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: targetMembership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
      {
        method: "DELETE",
        headers: { cookie: adminUser.cookie },
      },
    );

    expect(response.status).toBe(200);
  });

  it("rejects a plain workspace member with 403", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const targetUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });
    const targetMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: targetUser.userId,
      role: "member",
    });
    const target = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: targetMembership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
      {
        method: "DELETE",
        headers: { cookie: memberUser.cookie },
      },
    );

    expect(response.status).toBe(403);
  });

  it("rejects a workspace admin removing their own membership with 403", async () => {
    const owner = await signUp();
    const adminUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const adminMembership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: adminUser.userId,
      role: "member",
    });
    const adminWorkspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: adminMembership.id,
      organizationId: organization.id,
      role: "admin",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${adminWorkspaceMembership.id}`,
      {
        method: "DELETE",
        headers: { cookie: adminUser.cookie },
      },
    );

    expect(response.status).toBe(403);
  });

  it("reports a membership from another workspace as 404", async () => {
    const owner = await signUp();
    const memberUser = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const otherWorkspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.userId,
    );
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.userId,
      role: "member",
    });
    const otherWorkspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: otherWorkspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/workspaces/${workspace.id}/members/${otherWorkspaceMembership.id}`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );

    expect(response.status).toBe(404);
  });

  it("rejects requests without a session with 401", async () => {
    const response = await app.request(
      "/api/v1/workspaces/44444444-4444-4444-8444-444444444444/members/55555555-5555-4555-8555-555555555555",
      { method: "DELETE" },
    );

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});
