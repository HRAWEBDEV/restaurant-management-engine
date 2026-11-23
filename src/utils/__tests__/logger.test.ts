import { Hono } from "hono";
import { requestId } from "hono/request-id";
import pino from "pino";
import { Writable } from "node:stream";
import { describe, expect, it } from "bun:test";
import { requestLogger } from "../logger";

/**
 * Structured logging tests: run the requestLogger middleware in-process,
 * chained after requestId exactly as production mounts it, and capture the
 * JSON lines it writes through an injected pino instance instead of stdout.
 */

type LogLine = {
  level: number;
  msg: string;
  reqId?: string;
  req?: { url?: string; method?: string; headers?: Record<string, string> };
  res?: Record<string, unknown>;
  responseTime?: number;
};

function createCapturingLogger() {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as LogLine);
      callback();
    },
  });
  return { lines, instance: pino({ level: "info" }, stream) };
}

async function waitForLines(lines: LogLine[], count: number) {
  const deadline = Date.now() + 1000;
  while (lines.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} log lines, got ${lines.length}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildApp(instance: pino.Logger) {
  const app = new Hono();

  app.use(requestId());
  app.use(requestLogger(instance));
  app.get("/ping", (c) => c.json({ message: "pong" }));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.onError((_error, c) => c.text("internal server error", 500));

  return app;
}

describe("requestLogger", () => {
  it("writes one structured response line per request, correlated with the request id", async () => {
    const { lines, instance } = createCapturingLogger();
    const app = buildApp(instance);

    const response = await app.request("/ping", {
      headers: {
        "x-request-id": "req-123",
        cookie: "better-auth.session_token=secret",
        "x-organization-id": "org-1",
      },
    });

    expect(response.status).toBe(200);
    await waitForLines(lines, 1);

    expect(lines.length).toBe(1);
    const line = lines[0];
    if (!line) {
      throw new Error("expected a log line");
    }
    expect(line.reqId).toBe("req-123");
    expect(line.level).toBe(30);
    expect(line.msg).toBe("Request completed");
    expect(line.req?.url).toBe("/ping");
    expect(line.req?.method).toBe("GET");
    expect(line.req?.headers?.["x-organization-id"]).toBe("org-1");
    expect(line.res).toEqual({ status: 200 });
    expect(typeof line.responseTime).toBe("number");
  });

  it("never logs sensitive request or response headers", async () => {
    const { lines, instance } = createCapturingLogger();
    const app = buildApp(instance);

    await app.request("/ping", {
      headers: {
        cookie: "better-auth.session_token=secret",
        authorization: "Bearer secret",
      },
    });
    await waitForLines(lines, 1);

    const line = lines[0];
    if (!line) {
      throw new Error("expected a log line");
    }
    expect(line.req?.headers?.["cookie"]).toBeUndefined();
    expect(line.req?.headers?.["authorization"]).toBeUndefined();
    expect(Object.keys(line.res ?? {})).toEqual(["status"]);
  });

  it("logs thrown errors at error level with the error message", async () => {
    const { lines, instance } = createCapturingLogger();
    const app = buildApp(instance);

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    await waitForLines(lines, 1);

    expect(lines.length).toBe(1);
    const line = lines[0];
    if (!line) {
      throw new Error("expected a log line");
    }
    expect(line.level).toBe(50);
    expect(line.msg).toBe("boom");
    expect(line.res).toEqual({ status: 500 });
    expect(typeof line.reqId).toBe("string");
  });
});
