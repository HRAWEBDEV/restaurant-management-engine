import { nanoid } from "nanoid";
import { describe, expect, it } from "bun:test";
import { apiV1Routes } from "../../index";
import { testDb } from "../../../../db/__tests__/helpers/db";
import { addOrganizationMember } from "../../../../db/__tests__/helpers/factories";

/**
 * Route tests for the invitations endpoints, driven through the full apiV1
 * app so authMiddleware, routing, validation, and error handlers run exactly
 * as production. Sessions are carried by replaying the sign-up cookies.
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
  return {
    userId: body.user.id,
    email: credentials.email,
    cookie: cookieFrom(response),
  };
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
  return jsonBody<{ organization: { id: string } }>(response);
}

/** Sends an invitation through the api; the tenant header names the org. */
async function sendInvite(
  cookie: string,
  organizationId: string,
  invitedUserEmail: string,
) {
  return app.request("/api/v1/organization/invitations", {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      cookie,
      "x-organization-id": organizationId,
    },
    body: JSON.stringify({ invitedUserEmail }),
  });
}

describe("authentication guard", () => {
  it("rejects invitation requests without a session with 401", async () => {
    const responses = await Promise.all([
      app.request("/api/v1/invitations"),
      app.request("/api/v1/organization/invitations"),
      app.request("/api/v1/organization/invitations", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ invitedUserEmail: "x@example.com" }),
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      const body = await jsonBody<{ code?: string }>(response);
      expect(body.code).toBe("NOT_SIGNED_IN");
    }
  });
});

describe("POST /organizations/{organizationId}/invitations", () => {
  it("creates a pending invitation for the invited email", async () => {
    const owner = await signUp();
    const invitee = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);

    const response = await sendInvite(
      owner.cookie,
      organizationId,
      // Different casing than stored: the service normalizes to lowercase.
      invitee.email.toUpperCase(),
    );

    expect(response.status).toBe(201);
    const body = await jsonBody<{
      invitation: {
        invitedUserEmail: string;
        status: string;
        invitedBy: string;
      };
    }>(response);
    expect(body.invitation.invitedUserEmail).toBe(invitee.email);
    expect(body.invitation.status).toBe("pending");
    expect(body.invitation.invitedBy).toBe(owner.userId);
  });

  it("rejects a caller without organization:member:invite with 403", async () => {
    const owner = await signUp();
    const member = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    await addOrganizationMember(testDb, {
      organizationId,
      userId: member.userId,
      role: "member",
      addedBy: owner.userId,
    });

    const response = await sendInvite(
      member.cookie,
      organizationId,
      "someone@example.com",
    );

    expect(response.status).toBe(403);
  });

  it("rejects callers whose x-organization-id organization they are not members of with 403", async () => {
    const owner = await signUp();
    const outsider = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);

    const response = await sendInvite(
      outsider.cookie,
      organizationId,
      "someone@example.com",
    );

    expect(response.status).toBe(403);
  });

  it("rejects requests without the x-organization-id header with 403", async () => {
    const owner = await signUp();
    await createOrganization(owner.cookie);

    const response = await app.request("/api/v1/organization/invitations", {
      method: "POST",
      headers: { ...jsonHeaders(), cookie: owner.cookie },
      body: JSON.stringify({ invitedUserEmail: "someone@example.com" }),
    });

    expect(response.status).toBe(403);
    const body = await jsonBody<{ message?: string }>(response);
    expect(body.message).toContain("header is missing");
  });

  it("rejects an invalid email with 400", async () => {
    const owner = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);

    const response = await sendInvite(
      owner.cookie,
      organizationId,
      "not-an-email",
    );

    expect(response.status).toBe(400);
  });

  it("rejects a second pending invitation for the same email with 409", async () => {
    const owner = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    const email = "pending@example.com";
    await sendInvite(owner.cookie, organizationId, email);

    const response = await sendInvite(owner.cookie, organizationId, email);

    expect(response.status).toBe(409);
    const body = await jsonBody<{ message?: string }>(response);
    expect(body.message).toContain("already pending");
  });

  it("rejects inviting an existing member with 409", async () => {
    const owner = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);

    const response = await sendInvite(
      owner.cookie,
      organizationId,
      owner.email,
    );

    expect(response.status).toBe(409);
    const body = await jsonBody<{ message?: string }>(response);
    expect(body.message).toContain("already a member");
  });
});

describe("GET /organizations/{organizationId}/invitations", () => {
  it("lists the organization's invitations for a permitted caller", async () => {
    const owner = await signUp();
    const invitee = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    await sendInvite(owner.cookie, organizationId, invitee.email);

    const response = await app.request("/api/v1/organization/invitations", {
      headers: {
        cookie: owner.cookie,
        "x-organization-id": organizationId,
      },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      invitations: Array<{
        invitation: { invitedUserEmail: string; status: string };
        organization: { id: string };
        invitedByUser: { id: string };
      }>;
    }>(response);
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.invitation.invitedUserEmail).toBe(
      invitee.email,
    );
    expect(body.invitations[0]?.organization.id).toBe(organizationId);
    expect(body.invitations[0]?.invitedByUser.id).toBe(owner.userId);
  });

  it("filters by status", async () => {
    const owner = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    await sendInvite(owner.cookie, organizationId, "pending@example.com");

    const response = await app.request(
      "/api/v1/organization/invitations?status=declined",
      {
        headers: {
          cookie: owner.cookie,
          "x-organization-id": organizationId,
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await jsonBody<{ invitations: unknown[] }>(response);
    expect(body.invitations).toHaveLength(0);
  });

  it("rejects a caller without organization:invitation:read with 403", async () => {
    const owner = await signUp();
    const member = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    await addOrganizationMember(testDb, {
      organizationId,
      userId: member.userId,
      role: "member",
      addedBy: owner.userId,
    });

    const response = await app.request("/api/v1/organization/invitations", {
      headers: {
        cookie: member.cookie,
        "x-organization-id": organizationId,
      },
    });

    expect(response.status).toBe(403);
  });

  it("rejects callers whose x-organization-id organization they are not members of with 403", async () => {
    const owner = await signUp();
    const outsider = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);

    const response = await app.request("/api/v1/organization/invitations", {
      headers: {
        cookie: outsider.cookie,
        "x-organization-id": organizationId,
      },
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /invitations", () => {
  it("lists only invitations addressed to the session user's email, across organizations", async () => {
    const owner = await signUp();
    const otherOwner = await signUp();
    const invitee = await signUp();
    const otherInvitee = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    const {
      organization: { id: otherOrganizationId },
    } = await createOrganization(otherOwner.cookie);
    await sendInvite(owner.cookie, organizationId, invitee.email);
    await sendInvite(owner.cookie, organizationId, otherInvitee.email);
    await sendInvite(otherOwner.cookie, otherOrganizationId, invitee.email);

    const response = await app.request("/api/v1/invitations", {
      headers: { cookie: invitee.cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{
      invitations: Array<{
        invitation: { invitedUserEmail: string };
        organization: { id: string };
      }>;
    }>(response);
    expect(body.invitations).toHaveLength(2);
    expect(
      body.invitations.map((row) => row.organization.id),
    ).toEqual(expect.arrayContaining([organizationId, otherOrganizationId]));
    for (const row of body.invitations) {
      expect(row.invitation.invitedUserEmail).toBe(invitee.email);
    }
  });

  it("filters by status", async () => {
    const owner = await signUp();
    const invitee = await signUp();
    const {
      organization: { id: organizationId },
    } = await createOrganization(owner.cookie);
    await sendInvite(owner.cookie, organizationId, invitee.email);

    const response = await app.request("/api/v1/invitations?status=accepted", {
      headers: { cookie: invitee.cookie },
    });

    expect(response.status).toBe(200);
    const body = await jsonBody<{ invitations: unknown[] }>(response);
    expect(body.invitations).toHaveLength(0);
  });
});
