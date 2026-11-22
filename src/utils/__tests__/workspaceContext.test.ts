import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import type { AuthContext } from "../AuthContext";
import type { workspaceRoles } from "../../db/schemas/workspaceMembers";
import {
  getWorkspaceIdHeader,
  getContextWorkspaceRole,
  setContextWorkspaceRole,
} from "../workspaceContext";

type WorkspaceRole = (typeof workspaceRoles)[number];

const role: WorkspaceRole = "admin";

const app = new Hono<{ Variables: AuthContext }>();

app.get("/role", (c) => {
  setContextWorkspaceRole(c, role);
  return c.json(getContextWorkspaceRole(c));
});

app.get("/missing-role", (c) => {
  try {
    getContextWorkspaceRole(c);
    return c.json({ message: "no error" });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

app.get("/workspace-id", (c) => {
  try {
    return c.json({ workspaceId: getWorkspaceIdHeader(c) });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

describe("workspaceContext helpers", () => {
  it("return the workspace role set on the context", async () => {
    expect(await (await app.request("/role")).json()).toEqual(role);
  });

  it("throw when the workspace role is not set", async () => {
    expect(await (await app.request("/missing-role")).json()).toEqual({
      message: "workspace role context is not set",
    });
  });

  it("read the workspace id from the request header", async () => {
    const workspaceId = "0b3a0d66-6ff2-4d3a-9e2e-1b1ee6f3d003";
    const response = await app.request("/workspace-id", {
      headers: { "x-workspace-id": workspaceId },
    });
    expect(await response.json()).toEqual({ workspaceId });
  });

  it("reject a missing or invalid workspace id header", async () => {
    expect(await (await app.request("/workspace-id")).json()).toEqual({
      message: "x-workspace-id header is missing",
    });
    expect(
      await (
        await app.request("/workspace-id", {
          headers: { "x-workspace-id": "not-a-uuid" },
        })
      ).json(),
    ).toEqual({
      message: "x-workspace-id header is not a valid workspace id",
    });
  });
});
