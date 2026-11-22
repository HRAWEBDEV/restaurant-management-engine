import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../../middlewares/authMiddleware";
import { organizationMemberMiddleware } from "../../middlewares/organizationMemberMiddleware";
import { workspaceRoleMiddleware } from "../../middlewares/workspaceRoleMiddleware";
import { ConflictError } from "../../utils/ConflictError";
import { ForbiddenError } from "../../utils/ForbiddenError";
import { InternalError } from "../../utils/InternalError";
import { NotFoundError } from "../../utils/NotFoundError";
import { authRoutes } from "./routes/auth";
import {
  invitationsRoutes,
  organizationInvitationsRoutes,
} from "./routes/invitations";
import { organizationsRoutes } from "./routes/organizations";
import { usersRoutes } from "./routes/users";
import { workspacesRoutes } from "./routes/workspaces";

const checkHealth = createRoute({
  method: "get",
  description: "check if api is running",
  path: "/health",
  tags: ["health"],
  responses: {
    200: {
      description: "application is running",
    },
  },
});

const apiV1Routes = new OpenAPIHono().basePath("/api/v1");
apiV1Routes.openapi(checkHealth, (c) => {
  return c.json({
    message: "version one is running",
  });
});
// doc
apiV1Routes.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "Restaurant Manager API",
    version: "1.0.0",
    description: "Version 1 API",
  },
});
apiV1Routes.get(
  "/doc/ui",
  swaggerUI({
    url: "/api/v1/doc",
  }),
);

apiV1Routes.route("/", authRoutes);

// every route registered after this line requires a signed in user
apiV1Routes.use(authMiddleware);

apiV1Routes.route("/", organizationsRoutes);
apiV1Routes.route("/", usersRoutes);
apiV1Routes.route("/", workspacesRoutes);
// the invitee inbox is session-scoped (an invitee is not a member yet), so it
// mounts before the tenant middlewares
apiV1Routes.route("/", invitationsRoutes);

// tenant context middlewares, applied from here on — every route registered
// after these lines requires the x-organization-id / x-workspace-id headers.
// organizationMemberMiddleware MUST stay above workspaceRoleMiddleware,
// which reads the organization membership it puts on the context.
apiV1Routes.use(organizationMemberMiddleware);

// organization-scoped invitations: the tenant header scopes every route and
// permission middleware enforces the grants; no workspace role is needed, so
// they mount between the two tenant middlewares.
apiV1Routes.route("/", organizationInvitationsRoutes);

apiV1Routes.use(workspaceRoleMiddleware);

// global error handling, keep this after all routes
apiV1Routes.notFound((c) => new NotFoundError().handle(c));

apiV1Routes.onError((error, c) => {
  if (error instanceof NotFoundError) {
    return error.handle(c);
  }

  if (error instanceof ForbiddenError) {
    return error.handle(c);
  }

  if (error instanceof ConflictError) {
    return error.handle(c);
  }

  console.error("unhandled api error", error);
  return new InternalError().handle(c);
});

export { apiV1Routes };
