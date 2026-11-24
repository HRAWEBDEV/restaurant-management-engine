import { nanoid } from "nanoid";
import { describe, expect, it } from "bun:test";
import { apiV1Routes } from "../../index";
import { testDb } from "../../../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
} from "../../../../db/__tests__/helpers/factories";

/**
 * Route tests for the catalog categories endpoints, driven through the full
 * apiV1 app so authMiddleware, both tenant middlewares, routing, validation,
 * and error handlers run exactly as production. Sessions are carried by
 * replaying the sign-up cookies; the workspace is addressed only through the
 * x-workspace-id header.
 */

const app = apiV1Routes;

const BASE = "/api/v1/workspace/catalog/categories";

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
  return { userId: body.user.id, cookie: cookieFrom(response) };
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
    throw new Error(
      `organization creation failed with status ${response.status}`,
    );
  }
  return jsonBody<{
    organization: { id: string };
    workspace: { id: string };
  }>(response);
}

function tenantHeaders(organizationId: string, workspaceId: string) {
  return {
    "x-organization-id": organizationId,
    "x-workspace-id": workspaceId,
  };
}

/** Creates a category through the api and returns the parsed row. */
async function createCategory(
  cookie: string,
  organizationId: string,
  workspaceId: string,
  name: string,
) {
  const response = await app.request(BASE, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      cookie,
      ...tenantHeaders(organizationId, workspaceId),
    },
    body: JSON.stringify({ name }),
  });
  if (response.status !== 201) {
    throw new Error(`category creation failed with status ${response.status}`);
  }
  return jsonBody<{
    category: { id: string; name: string; position: number };
  }>(response);
}

/** Adds an organization member with a workspace role, through their session. */
async function addWorkspaceRoleUser(
  organizationId: string,
  workspaceId: string,
  role: "admin" | "member",
) {
  const user = await signUp();
  const membership = await addOrganizationMember(testDb, {
    organizationId,
    userId: user.userId,
  });
  await addWorkspaceMember(testDb, {
    workspaceId,
    organizationMemberId: membership.id,
    organizationId,
    role,
  });
  return user;
}

describe("catalog categories tenancy and permissions", () => {
  it("rejects requests without a session with 401", async () => {
    const response = await app.request(BASE);

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });

  it("rejects a missing x-organization-id header with 403", async () => {
    const { cookie } = await signUp();
    const { workspace } = await createOrganization(cookie);

    const response = await app.request(BASE, {
      headers: { cookie, "x-workspace-id": workspace.id },
    });

    expect(response.status).toBe(403);
  });

  it("rejects a missing x-workspace-id header with 403", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const response = await app.request(BASE, {
      headers: { cookie, "x-organization-id": organization.id },
    });

    expect(response.status).toBe(403);
  });

  it("rejects a caller from another organization with 403", async () => {
    const outsider = await signUp();
    const { organization, workspace } = await createOrganization(outsider.cookie);
    const member = await signUp();
    const own = await createOrganization(member.cookie);

    const response = await app.request(BASE, {
      headers: {
        cookie: member.cookie,
        ...tenantHeaders(own.organization.id, workspace.id),
      },
    });

    expect(response.status).toBe(403);
  });

  it("rejects an organization admin who is not a workspace member with 403", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const admin = await signUp();
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: admin.userId,
      role: "admin",
    });

    const response = await app.request(BASE, {
      headers: { cookie: admin.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });

    expect(response.status).toBe(403);
  });

  it("rejects a workspace member without catalog grants with 403 on every route", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const member = await addWorkspaceRoleUser(
      organization.id,
      workspace.id,
      "member",
    );
    const created = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );

    const list = await app.request(BASE, {
      headers: { cookie: member.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });
    const create = await app.request(BASE, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        cookie: member.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Mains" }),
    });
    const update = await app.request(`${BASE}/${created.category.id}`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: member.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    const archive = await app.request(`${BASE}/${created.category.id}`, {
      method: "DELETE",
      headers: { cookie: member.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });
    const reorder = await app.request(`${BASE}/reorder`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: member.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ categoryIds: [created.category.id] }),
    });

    for (const response of [list, create, update, archive, reorder]) {
      expect(response.status).toBe(403);
      const body = await jsonBody<{ message?: string }>(response);
      expect(body.message).toContain("missing permission");
    }
  });
});

describe("GET /workspace/catalog/categories", () => {
  it("lists the workspace's categories in position order for the owner", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const starters = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );
    const drinks = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Drinks",
    );

    const response = await app.request(BASE, {
      headers: { cookie: owner.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      categories: Array<{ id: string; position: number }>;
    }>(response);
    expect(body.categories.map((category) => category.id)).toEqual([
      starters.category.id,
      drinks.category.id,
    ]);
    expect(body.categories.map((category) => category.position)).toEqual([0, 1]);
  });
});

describe("POST /workspace/catalog/categories", () => {
  it("creates the category as the implicit workspace admin (organization owner)", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);

    const response = await app.request(BASE, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Starters", description: "Small plates" }),
    });

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      category: {
        workspaceId: string;
        name: string;
        description: string | null;
        position: number;
        isActive: boolean;
      };
    }>(response);
    expect(body.category.workspaceId).toBe(workspace.id);
    expect(body.category.name).toBe("Starters");
    expect(body.category.description).toBe("Small plates");
    expect(body.category.position).toBe(0);
    expect(body.category.isActive).toBe(true);
  });

  it("rejects an invalid body with 400", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);

    const response = await app.request(BASE, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ description: "missing name" }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects a duplicate name with 409", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    await createCategory(owner.cookie, organization.id, workspace.id, "Starters");

    const response = await app.request(BASE, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Starters" }),
    });

    expect(response.status).toBe(409);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("CONFLICT");
  });
});

describe("PATCH /workspace/catalog/categories/{categoryId}", () => {
  it("updates the category and returns it", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const created = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );

    const response = await app.request(`${BASE}/${created.category.id}`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Appetizers" }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ category: { name: string } }>(response);
    expect(body.category.name).toBe("Appetizers");
  });

  it("reports a category of another workspace as not found", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const created = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );
    const otherWorkspace = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
      },
      body: JSON.stringify({ organizationId: organization.id, name: `Branch ${nanoid(6)}` }),
    });
    const other = await jsonBody<{ workspace: { id: string } }>(otherWorkspace);

    const response = await app.request(`${BASE}/${created.category.id}`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, other.workspace.id),
      },
      body: JSON.stringify({ name: "Hijacked" }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects renaming to a used name with 409", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    await createCategory(owner.cookie, organization.id, workspace.id, "Starters");
    const drinks = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Drinks",
    );

    const response = await app.request(`${BASE}/${drinks.category.id}`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Starters" }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects an invalid category id with 400", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);

    const response = await app.request(`${BASE}/not-a-uuid`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ name: "Appetizers" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("DELETE /workspace/catalog/categories/{categoryId}", () => {
  it("archives the category instead of deleting it", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const created = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );

    const response = await app.request(`${BASE}/${created.category.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ category: { isActive: boolean } }>(response);
    expect(body.category.isActive).toBe(false);

    const again = await app.request(`${BASE}/${created.category.id}`, {
      method: "DELETE",
      headers: { cookie: owner.cookie, ...tenantHeaders(organization.id, workspace.id) },
    });
    expect(again.status).toBe(200);
  });

  it("reports an unknown category id as not found", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);

    const response = await app.request(
      `${BASE}/00000000-0000-4000-8000-000000000001`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie, ...tenantHeaders(organization.id, workspace.id) },
      },
    );

    expect(response.status).toBe(404);
  });
});

describe("PATCH /workspace/catalog/categories/reorder", () => {
  it("rewrites positions from the full ordered list", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const starters = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );
    const mains = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Mains",
    );

    const response = await app.request(`${BASE}/reorder`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({
        categoryIds: [mains.category.id, starters.category.id],
      }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      categories: Array<{ id: string; position: number }>;
    }>(response);
    expect(body.categories.map((category) => category.id)).toEqual([
      mains.category.id,
      starters.category.id,
    ]);
    expect(body.categories.map((category) => category.position)).toEqual([0, 1]);
  });

  it("rejects a stale list with 409", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);
    const starters = await createCategory(
      owner.cookie,
      organization.id,
      workspace.id,
      "Starters",
    );
    await createCategory(owner.cookie, organization.id, workspace.id, "Mains");

    const response = await app.request(`${BASE}/reorder`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ categoryIds: [starters.category.id] }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects an invalid body with 400", async () => {
    const owner = await signUp();
    const { organization, workspace } = await createOrganization(owner.cookie);

    const response = await app.request(`${BASE}/reorder`, {
      method: "PATCH",
      headers: {
        ...jsonHeaders(),
        cookie: owner.cookie,
        ...tenantHeaders(organization.id, workspace.id),
      },
      body: JSON.stringify({ categoryIds: "not-a-list" }),
    });

    expect(response.status).toBe(400);
  });
});
