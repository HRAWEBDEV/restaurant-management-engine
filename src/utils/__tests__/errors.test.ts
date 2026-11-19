import { Hono } from "hono";
import { describe, expect, it } from "bun:test";
import { StatusCodes } from "http-status-codes";
import { ForbiddenError } from "../ForbiddenError";
import { InternalError } from "../InternalError";
import { NotFoundError } from "../NotFoundError";

// every error class is documented to share this shape: a stable name, a
// stable machine-readable code, and handle() rendering the documented
// status + body
const errorClasses = [
  {
    ErrorClass: InternalError,
    name: "InternalError",
    code: "INTERNAL_SERVER_ERROR",
    defaultMessage: "internal server error",
    status: StatusCodes.INTERNAL_SERVER_ERROR,
  },
  {
    ErrorClass: NotFoundError,
    name: "NotFoundError",
    code: "NOT_FOUND",
    defaultMessage: "resource not found",
    status: StatusCodes.NOT_FOUND,
  },
  {
    ErrorClass: ForbiddenError,
    name: "ForbiddenError",
    code: "FORBIDDEN",
    defaultMessage: "forbidden",
    status: StatusCodes.FORBIDDEN,
  },
] as const;

const app = new Hono();
for (const { ErrorClass } of errorClasses) {
  app.get(`/${ErrorClass.name}`, (c) => new ErrorClass().handle(c));
}

describe("error classes", () => {
  it("are errors with a stable name, code, and default message", () => {
    for (const { ErrorClass, name, code, defaultMessage } of errorClasses) {
      const error = new ErrorClass();
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message).toBe(defaultMessage);
    }
  });

  it("keep a custom message instead of the default", () => {
    for (const { ErrorClass } of errorClasses) {
      expect(new ErrorClass("custom message").message).toBe("custom message");
    }
  });

  it("render handle() as an error response with the documented status", async () => {
    for (const { ErrorClass, code, defaultMessage, status } of errorClasses) {
      const response = await app.request(`/${ErrorClass.name}`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        message: defaultMessage,
        code,
      });
    }
  });
});
