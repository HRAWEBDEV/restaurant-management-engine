import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { apiV1Routes } from "../../index";
import { testDb } from "../../../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
} from "../../../../db/__tests__/helpers/factories";
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
