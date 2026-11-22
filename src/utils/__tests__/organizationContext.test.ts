import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import type { AuthContext } from "../AuthContext";
import type { OrganizationMember } from "../../db/schemas/organizationMembers";
import {
  getOrganizationIdHeader,
  getContextOrganizationMember,
  setContextOrganizationMember,
} from "../organizationContext";

// the helpers only pass the member row through the context, so a minimal
// stand-in with the fields the tests assert on is enough
const member = {
  id: "0b3a0d66-6ff2-4d3a-9e2e-1b1ee6f3d001",
  organizationId: "0b3a0d66-6ff2-4d3a-9e2e-1b1ee6f3d002",
  userId: "user_1",
  role: "member",
} as OrganizationMember;

const app = new Hono<{ Variables: AuthContext }>();

app.get("/member", (c) => {
  setContextOrganizationMember(c, member);
  return c.json(getContextOrganizationMember(c));
});

app.get("/missing-member", (c) => {
  try {
    getContextOrganizationMember(c);
    return c.json({ message: "no error" });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

app.get("/organization-id", (c) => {
  try {
    return c.json({ organizationId: getOrganizationIdHeader(c) });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

describe("organizationContext helpers", () => {
  it("return the organization member set on the context", async () => {
    expect(await (await app.request("/member")).json()).toEqual(member);
  });

  it("throw when the organization member is not set", async () => {
    expect(await (await app.request("/missing-member")).json()).toEqual({
      message: "organization member context is not set",
    });
  });

  it("read the organization id from the request header", async () => {
    const response = await app.request("/organization-id", {
      headers: { "x-organization-id": member.organizationId },
    });
    expect(await response.json()).toEqual({
      organizationId: member.organizationId,
    });
  });

  it("reject a missing or invalid organization id header", async () => {
    expect(await (await app.request("/organization-id")).json()).toEqual({
      message: "x-organization-id header is missing",
    });
    expect(
      await (
        await app.request("/organization-id", {
          headers: { "x-organization-id": "not-a-uuid" },
        })
      ).json(),
    ).toEqual({
      message: "x-organization-id header is not a valid organization id",
    });
  });
});
