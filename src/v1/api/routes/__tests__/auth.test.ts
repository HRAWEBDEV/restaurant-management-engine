import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../../../db/__tests__/helpers/db";
import { organizationMembers } from "../../../../db/schemas/organizationMembers";
import { workspaces } from "../../../../db/schemas/workspaces";
import { authRoutes } from "../auth";

/**
 * Route tests for /api/v1/auth, driven through the router itself with
 * app.request() — no server, no Supertest. Sign-up/sign-in responses carry
 * the session cookies, which are replayed via the Cookie header.
 */

const app = authRoutes;

function jsonHeaders() {
  return { "content-type": "application/json" };
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

async function signUp(payload = signUpBody()) {
  const response = await app.request("/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (response.status !== 200) {
    throw new Error(`sign up failed with status ${response.status}`);
  }
  return { body: await response.json(), credentials: payload };
}

describe("POST /auth/sign-up/email", () => {
  it("creates the user and sets the session cookies", async () => {
    const credentials = signUpBody();

    const response = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(credentials),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ user: { email: string; name: string } }>(
      response,
    );
    expect(body.user.email).toBe(credentials.email);
    expect(body.user.name).toBe(credentials.name);
    expect(response.headers.get("set-cookie")).toBeTruthy();
  });

  it("rejects an already-registered email with 422", async () => {
    const { credentials } = await signUp();

    // same email with a different username reaches the email-exists check
    const response = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...credentials,
        username: `user_${nanoid(12).replaceAll("-", "").toLowerCase()}`,
      }),
    });

    expect(response.status).toBe(422);
    const body = await jsonBody<{ message?: string }>(response);
    expect(typeof body.message).toBe("string");

    // same username is rejected earlier, with 400
    const sameUsername = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(credentials),
    });
    expect(sameUsername.status).toBe(400);
  });

  it("rejects invalid input with 400", async () => {
    const response = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ...signUpBody(), password: "short" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/sign-in/email", () => {
  it("signs in with valid credentials and sets the session cookies", async () => {
    const { credentials } = await signUp();

    const response = await app.request("/auth/sign-in/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ user: { email: string }; token: string }>(
      response,
    );
    expect(body.user.email).toBe(credentials.email);
    expect(typeof body.token).toBe("string");
    expect(response.headers.get("set-cookie")).toBeTruthy();
  });

  it("returns 401 with an error body for a wrong password", async () => {
    const { credentials } = await signUp();

    const response = await app.request("/auth/sign-in/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        email: credentials.email,
        password: "wrongpassword",
      }),
    });

    expect(response.status).toBe(401);
    const body = await jsonBody<{ message?: string }>(response);
    expect(typeof body.message).toBe("string");
  });
});

describe("POST /auth/sign-out", () => {
  it("revokes the session and clears the cookies", async () => {
    const signUpResponse = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(signUpBody()),
    });

    const response = await app.request("/auth/sign-out", {
      method: "POST",
      headers: { cookie: cookieFrom(signUpResponse) },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ success: boolean }>(response);
    expect(body.success).toBe(true);
    expect(response.headers.get("set-cookie")).toBeTruthy();
  });
});

describe("POST /auth/account", () => {
  it("creates the account, organization, and default workspace in one call", async () => {
    const credentials = signUpBody();

    const response = await app.request("/auth/account", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        user: credentials,
        organization: { name: "Acme Restaurant" },
        workspace: { name: "Downtown" },
      }),
    });

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      user: { id: string; email: string };
      organization: { id: string; name: string };
      workspace: { id: string; name: string; organizationId: string };
    }>(response);
    expect(body.user.email).toBe(credentials.email);
    expect(body.organization.name).toBe("Acme Restaurant");
    expect(body.workspace.name).toBe("Downtown");
    expect(body.workspace.organizationId).toBe(body.organization.id);
    expect(response.headers.get("set-cookie")).toBeTruthy();

    // the route operates on the test database via the shared db instance
    const memberships = await testDb
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, body.organization.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      userId: body.user.id,
      role: "owner",
    });

    const workspaceRows = await testDb
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, body.workspace.id));
    expect(workspaceRows).toHaveLength(1);
  });

  it("rejects invalid organization input with 400", async () => {
    const response = await app.request("/auth/account", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        user: signUpBody(),
        organization: { name: "" },
      }),
    });

    expect(response.status).toBe(400);
  });

  it("defaults the workspace name to the organization name when omitted", async () => {
    const credentials = signUpBody();

    const response = await app.request("/auth/account", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        user: credentials,
        organization: { name: `Acme ${nanoid(6)}` },
      }),
    });

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      organization: { name: string };
      workspace: { name: string; organizationId: string };
    }>(response);
    expect(body.workspace.name).toBe(body.organization.name);
  });

  it("rejects an already-registered email with 422", async () => {
    const { credentials } = await signUp();

    const response = await app.request("/auth/account", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        user: {
          ...credentials,
          username: `user_${nanoid(12).replaceAll("-", "").toLowerCase()}`,
        },
        organization: { name: "Acme Restaurant" },
      }),
    });

    expect(response.status).toBe(422);
    const body = await jsonBody<{ message?: string }>(response);
    expect(typeof body.message).toBe("string");
  });
});
