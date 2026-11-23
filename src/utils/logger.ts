import { pinoLogger } from "hono-pino";
import pino, { type Logger } from "pino";
import pinoPretty from "pino-pretty";
import type { Context } from "hono";

// Only x-* headers (the tenant headers) are logged; cookie and authorization
// headers must never reach the log output.
function requestBindings(c: Context) {
  return {
    req: {
      url: c.req.path,
      method: c.req.method,
      headers: Object.fromEntries(
        Object.entries(c.req.header()).filter(([key]) => key.startsWith("x-")),
      ),
    },
  };
}

// Response headers carry Set-Cookie; only the status is useful here.
function responseBindings(c: Context) {
  return {
    res: {
      status: c.res.status,
    },
  };
}

const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info" },
  process.env.NODE_ENV === "development"
    ? pinoPretty({
        colorize: true,
        ignore: "pid,hostname",
        translateTime: "SYS:standard",
      })
    : undefined,
);

function requestLogger(instance: Logger = logger) {
  return pinoLogger({
    pino: instance,
    http: {
      onReqBindings: requestBindings,
      onResBindings: responseBindings,
    },
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export { logger, requestLogger, toError };
