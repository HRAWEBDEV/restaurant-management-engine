import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../../middlewares/authMiddleware";
import { authRoutes } from "./routes/auth";

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

export { apiV1Routes };
