import { nanoid } from "nanoid";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "bun:test";
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

describe("PUT /users/image", () => {
  // Image files saved by upload tests, cleaned up after each test.
  const savedImagePaths: string[] = [];

  afterEach(async () => {
    for (const storedPath of savedImagePaths.splice(0)) {
      await rm(`static/${storedPath}`, { force: true });
    }
  });

  function pngFile(name = "image.png") {
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

  it("rejects a request without a session with 401", async () => {
    const form = new FormData();
    form.append("image", pngFile(), "image.png");

    const response = await app.request("/api/v1/users/image", {
      method: "PUT",
      body: form,
    });

    expect(response.status).toBe(401);
    const body = await jsonBody<{ code?: string }>(response);
    expect(body.code).toBe("NOT_SIGNED_IN");
  });

  it("stores the uploaded image and updates the user", async () => {
    const { cookie } = await signUp();

    const response = await app.request("/api/v1/users/image", {
      method: "PUT",
      headers: { cookie },
      body: (() => {
        const form = new FormData();
        form.append("image", pngFile(), "image.png");
        return form;
      })(),
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ user: { image: string } }>(response);
    expect(body.user.image).toMatch(/^users\/images\/image-.+\.png$/);
    savedImagePaths.push(body.user.image);

    const file = Bun.file(`static/${body.user.image}`);
    expect(await file.exists()).toBe(true);
  });

  it("removes the replaced image file", async () => {
    const { cookie } = await signUp();

    const first = await app.request("/api/v1/users/image", {
      method: "PUT",
      headers: { cookie },
      body: (() => {
        const form = new FormData();
        form.append("image", pngFile(), "image.png");
        return form;
      })(),
    });
    const firstBody = await jsonBody<{ user: { image: string } }>(first);
    savedImagePaths.push(firstBody.user.image);

    const second = await app.request("/api/v1/users/image", {
      method: "PUT",
      headers: { cookie },
      body: (() => {
        const form = new FormData();
        form.append("image", pngFile(), "replacement.png");
        return form;
      })(),
    });
    const secondBody = await jsonBody<{ user: { image: string } }>(second);
    expect(secondBody.user.image).not.toBe(firstBody.user.image);
    savedImagePaths.push(secondBody.user.image);

    expect(await Bun.file(`static/${firstBody.user.image}`).exists()).toBe(
      false,
    );
    expect(await Bun.file(`static/${secondBody.user.image}`).exists()).toBe(
      true,
    );
  });

  it("rejects an unsupported file type with 400", async () => {
    const { cookie } = await signUp();

    const form = new FormData();
    form.append(
      "image",
      new File([new Uint8Array([1, 2, 3])], "image.gif", { type: "image/gif" }),
      "image.gif",
    );

    const response = await app.request("/api/v1/users/image", {
      method: "PUT",
      headers: { cookie },
      body: form,
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
