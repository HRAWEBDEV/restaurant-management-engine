import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import type { AuthContext, Session } from "../AuthContext";
import {
  getContextSession,
  getContextUser,
  setContextSession,
  setContextUser,
} from "../AuthContext";

// minimal stand-ins for Better Auth's session user/session row; the helpers
// only pass them through the context, so the full shape is irrelevant here
const user = { id: "user_1", email: "test@example.com" } as Session["user"];
const session = { id: "session_1", userId: "user_1" } as Session["session"];

const app = new Hono<{ Variables: AuthContext }>();

app.get("/user", (c) => {
  setContextUser(c, user);
  return c.json(getContextUser(c));
});

app.get("/session", (c) => {
  setContextSession(c, session);
  return c.json(getContextSession(c));
});

app.get("/missing-user", (c) => {
  try {
    getContextUser(c);
    return c.json({ message: "no error" });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

app.get("/missing-session", (c) => {
  try {
    getContextSession(c);
    return c.json({ message: "no error" });
  } catch (error) {
    return c.json({ message: (error as Error).message });
  }
});

describe("AuthContext helpers", () => {
  it("return the user and session set on the context", async () => {
    expect(await (await app.request("/user")).json()).toEqual(user);
    expect(await (await app.request("/session")).json()).toEqual(session);
  });

  it("throw when the user or session is not set", async () => {
    expect(await (await app.request("/missing-user")).json()).toEqual({
      message: "user context is not set",
    });
    expect(await (await app.request("/missing-session")).json()).toEqual({
      message: "session is not set",
    });
  });
});
