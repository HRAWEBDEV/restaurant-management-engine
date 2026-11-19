import { OpenAPIHono } from "@hono/zod-openapi";

const organizationsRoutes = new OpenAPIHono().basePath("/organizations");

export { organizationsRoutes };
