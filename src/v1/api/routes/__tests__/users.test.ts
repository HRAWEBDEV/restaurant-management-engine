import { nanoid } from "nanoid";
import { describe, expect, it } from "bun:test";
import { apiV1Routes } from "../../index";

/**
 * Route tests for /api/v1/users, driven through the full apiV1 app so
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

describe("PATCH /users/info", () => {
  it("rejects a request without a session with 401", async () => {
    const response = await app.request("/api/v1/users/info", {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "No Session" }),
    });

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });

  it("updates the signed in user's info and persists it", async () => {
    const { credentials, cookie } = await signUp();

    const response = await app.request("/api/v1/users/info", {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({
        name: "Updated User",
        firstName: "Updated",
        lastName: "Person",
      }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      user: {
        id: string;
        name: string;
        firstName: string;
        lastName: string;
        email: string;
      };
    }>(response);
    expect(body.user.name).toBe("Updated User");
    expect(body.user.firstName).toBe("Updated");
    expect(body.user.lastName).toBe("Person");
    expect(body.user.email).toBe(credentials.email);

    const readBack = await app.request("/api/v1/users/info", {
      headers: { cookie },
    });
    expect(readBack.status).toBe(200);
    const readBody = await jsonBody<{ user: { name: string } }>(readBack);
    expect(readBody.user.name).toBe("Updated User");
  });

  it("returns the current user when no field differs", async () => {
    const { userId, credentials, cookie } = await signUp();

    const response = await app.request("/api/v1/users/info", {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ name: credentials.name }),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ user: { id: string } }>(response);
    expect(body.user.id).toBe(userId);
  });

  it("rejects a taken username with 409", async () => {
    const first = await signUp();
    const second = await signUp();

    const response = await app.request("/api/v1/users/info", {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie: second.cookie },
      body: JSON.stringify({ username: first.credentials.username }),
    });

    expect(response.status).toBe(409);
    const body = await jsonBody<{ message?: string }>(response);
    expect(body.message).toBe("username is already taken");
  });

  it("rejects invalid input with 400", async () => {
    const { cookie } = await signUp();

    const response = await app.request("/api/v1/users/info", {
      method: "PATCH",
      headers: { ...jsonHeaders(), cookie },
      body: JSON.stringify({ name: "" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("GET /users/info", () => {
  it("rejects a request without a session with 401", async () => {
    const response = await app.request("/api/v1/users/info");

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });

  it("returns the signed in user's info", async () => {
    const { userId, credentials, cookie } = await signUp();

    const response = await app.request("/api/v1/users/info", {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      user: {
        id: string;
        name: string;
        email: string;
        username: string | null;
        firstName: string;
        lastName: string;
      };
    }>(response);
    expect(body.user.id).toBe(userId);
    expect(body.user.name).toBe(credentials.name);
    expect(body.user.email).toBe(credentials.email);
    expect(body.user.username).toBe(credentials.username);
    expect(body.user.firstName).toBe(credentials.firstName);
    expect(body.user.lastName).toBe(credentials.lastName);
  });
});
