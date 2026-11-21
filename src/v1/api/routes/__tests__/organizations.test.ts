import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { apiV1Routes } from "../../index";
import { testDb } from "../../../../db/__tests__/helpers/db";
import { addOrganizationMember } from "../../../../db/__tests__/helpers/factories";
import { organizationMembers } from "../../../../db/schemas/organizationMembers";
import { workspaceMembers } from "../../../../db/schemas/workspaceMembers";
import { organizations } from "../../../../db/schemas/organizations";

/**
 * Route tests for /api/v1/organizations, driven through the full apiV1 app so
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
    throw new Error(
      `organization creation failed with status ${response.status}`,
    );
  }
  return jsonBody<{
    organization: {
      id: string;
      name: string;
      slug: string;
      logo: string | null;
    };
    workspace: { id: string; name: string };
  }>(response);
}

// Logo files saved by upload tests, cleaned up after each test.
const savedLogoPaths: string[] = [];

afterEach(async () => {
  for (const storedPath of savedLogoPaths.splice(0)) {
    await rm(`static/${storedPath}`, { force: true });
  }
});

function pngFile(name = "logo.png") {
  // 1x1 transparent PNG
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

describe("authentication guard", () => {
  it("rejects organization requests without a session with 401", async () => {
    const response = await app.request("/api/v1/organizations");

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });
});

describe("POST /organizations/account", () => {
  it("creates an organization and default workspace for the session user", async () => {
    const { cookie } = await signUp();

    const response = await app.request("/api/v1/organizations/account", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({
        organization: { name: `Acme ${nanoid(8)}` },
      }),
    });

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      organization: { id: string; slug: string };
      workspace: { id: string; name: string; organizationId: string };
    }>(response);
    expect(body.organization.slug).toBeTruthy();
    expect(body.workspace.organizationId).toBe(body.organization.id);

    const memberships = await testDb
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, body.organization.id));
    expect(memberships).toHaveLength(1);

    const workspaceMemberships = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, body.workspace.id));
    expect(workspaceMemberships).toHaveLength(1);
  });

  it("rejects invalid organization input with 400", async () => {
    const { cookie } = await signUp();

    const response = await app.request("/api/v1/organizations/account", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ organization: { name: "" } }),
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /organizations", () => {
  it("lists only the session user's organizations", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const createdA = await createOrganization(userA.cookie);
    await createOrganization(userB.cookie);

    const response = await app.request("/api/v1/organizations", {
      headers: { cookie: userA.cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      organizations: Array<{ id: string }>;
    }>(response);
    const ids = body.organizations.map((organization) => organization.id);
    expect(ids).toContain(createdA.organization.id);
    expect(ids).toHaveLength(1);
  });
});

describe("GET /organizations/{id}", () => {
  it("returns the organization with the caller's membership row", async () => {
    const userA = await signUp();
    const { organization } = await createOrganization(userA.cookie);

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      { headers: { cookie: userA.cookie } },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      organization: { id: string };
      membership: { role: string };
    }>(response);
    expect(body.organization.id).toBe(organization.id);
    expect(body.membership.role).toBe("owner");
  });

  it("reports an organization outside the caller's memberships as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      { headers: { cookie: userB.cookie } },
    );

    expect(response.status).toBe(404);
  });
});

describe("PATCH /organizations/{id}", () => {
  it("updates the organization and regenerates the slug on a name change", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);
    const newName = `Renamed ${nanoid(8)}`;

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie },
        body: JSON.stringify({ name: newName }),
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      organization: { name: string; slug: string };
    }>(response);
    expect(body.organization.name).toBe(newName);
    expect(body.organization.slug).not.toBe(organization.slug);

    const [row] = await testDb
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(row?.name).toBe(newName);
    expect(row?.slug).toBe(body.organization.slug);
  });

  it("rejects a member whose role does not grant organization:update with 403", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: userB.userId,
      role: "member",
    });

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: userB.cookie },
        body: JSON.stringify({ name: `Renamed ${nanoid(8)}` }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("reports an organization outside the caller's memberships as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie: userB.cookie },
        body: JSON.stringify({ name: `Renamed ${nanoid(8)}` }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("rejects invalid input with 400", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const response = await app.request(
      `/api/v1/organizations/${organization.id}`,
      {
        method: "PATCH",
        headers: { ...jsonHeaders(), cookie },
        body: JSON.stringify({ name: "" }),
      },
    );

    expect(response.status).toBe(400);
  });
});

describe("PUT /organizations/{id}/logo", () => {
  it("stores the uploaded logo and updates the organization", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const response = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      {
        method: "PUT",
        headers: { cookie },
        body: (() => {
          const form = new FormData();
          form.append("logo", pngFile(), "logo.png");
          return form;
        })(),
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      organization: { logo: string };
    }>(response);
    expect(body.organization.logo).toMatch(
      /^organizations\/logos\/logo-.+\.png$/,
    );
    savedLogoPaths.push(body.organization.logo);

    const file = Bun.file(`static/${body.organization.logo}`);
    expect(await file.exists()).toBe(true);
  });

  it("removes the replaced logo file", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const first = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      {
        method: "PUT",
        headers: { cookie },
        body: (() => {
          const form = new FormData();
          form.append("logo", pngFile(), "logo.png");
          return form;
        })(),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = await jsonBody<{ organization: { logo: string } }>(first);
    savedLogoPaths.push(firstBody.organization.logo);

    const second = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      {
        method: "PUT",
        headers: { cookie },
        body: (() => {
          const form = new FormData();
          form.append("logo", pngFile(), "replacement.png");
          return form;
        })(),
      },
    );
    expect(second.status).toBe(200);
    const secondBody = await jsonBody<{ organization: { logo: string } }>(
      second,
    );
    expect(secondBody.organization.logo).not.toBe(firstBody.organization.logo);
    savedLogoPaths.push(secondBody.organization.logo);

    expect(
      await Bun.file(`static/${firstBody.organization.logo}`).exists(),
    ).toBe(false);
    expect(
      await Bun.file(`static/${secondBody.organization.logo}`).exists(),
    ).toBe(true);
  });

  it("rejects an unsupported file type with 400", async () => {
    const { cookie } = await signUp();
    const { organization } = await createOrganization(cookie);

    const form = new FormData();
    form.append(
      "logo",
      new File([new Uint8Array([1, 2, 3])], "logo.gif", { type: "image/gif" }),
      "logo.gif",
    );

    const response = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      { method: "PUT", headers: { cookie }, body: form },
    );

    expect(response.status).toBe(400);
  });

  it("rejects a member whose role does not grant organization:update with 403", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: userB.userId,
      role: "member",
    });

    const form = new FormData();
    form.append("logo", pngFile(), "logo.png");

    const response = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      { method: "PUT", headers: { cookie: userB.cookie }, body: form },
    );

    expect(response.status).toBe(403);
  });

  it("reports an organization outside the caller's memberships as 404", async () => {
    const userA = await signUp();
    const userB = await signUp();
    const { organization } = await createOrganization(userA.cookie);

    const form = new FormData();
    form.append("logo", pngFile(), "logo.png");

    const response = await app.request(
      `/api/v1/organizations/${organization.id}/logo`,
      { method: "PUT", headers: { cookie: userB.cookie }, body: form },
    );

    expect(response.status).toBe(404);
  });
});
