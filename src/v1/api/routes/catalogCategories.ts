import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { StatusCodes } from "http-status-codes";
import { db } from "../../../db/connect";
import {
  CatalogCategoriesService,
  createCategoryResponseSchema,
  createCategorySchema,
  getCatalogCategoriesResponseSchema,
  reorderCategoriesResponseSchema,
  reorderCategoriesSchema,
  updateCategoryResponseSchema,
  updateCategorySchema,
} from "../../../services/catalogCategoriesService";
import { type AuthContext, getContextUser } from "../../../utils/AuthContext";
import { requireLevelPermissions } from "../../../middlewares/requireLevelPermissions";
import { NotFoundError } from "../../../utils/NotFoundError";
import { organizationIdHeaderSchema } from "../../../utils/organizationContext";
import {
  getWorkspaceIdHeader,
  workspaceIdHeaderSchema,
} from "../../../utils/workspaceContext";
import { errorResponseSchema } from "../../utils/apiErrorResponse";

/**
 * Catalog category routes, the first workspace-scoped mount: both tenant
 * headers are required — organizationMemberMiddleware resolves the
 * organization membership and workspaceRoleMiddleware the effective
 * workspace role before the handler runs — and the workspace is addressed
 * only through the x-workspace-id header (no path param, so the header is
 * the single source of truth and cannot disagree with the path).
 * requireLevelPermissions enforces the catalog grants at
 * organizationWorkspace level — organization owners (implicit workspace
 * admins) and workspace admins manage the menu, workspace members get 403
 * until granted.
 */
const catalogCategoriesRoutes = new OpenAPIHono<{
  Variables: AuthContext;
}>();

/**
 * Declared (not validated) so both required tenant headers show up as
 * parameters in the OpenAPI document; the middlewares enforce them first.
 */
const catalogTenantHeadersSchema = organizationIdHeaderSchema.extend(
  workspaceIdHeaderSchema.shape,
);

const getCategoriesRoute = createRoute({
  method: "get",
  path: "/workspace/catalog/categories",
  middleware: [
    requireLevelPermissions({
      level: "organizationWorkspace",
      permission: "catalog:read",
    }),
  ],
  tags: ["catalog"],
  summary: "List the active workspace's menu categories",
  description:
    "Returns every category of the workspace named by the x-workspace-id header in position order (oldest created breaks ties), archived ones included — this is the back-office read, availability filtering happens in the composite menu read. Requires membership of the workspace's organization and catalog:read.",
  request: {
    headers: catalogTenantHeadersSchema,
  },
  responses: {
    200: {
      description: "The workspace's categories, position ordered",
      content: {
        "application/json": {
          schema: getCatalogCategoriesResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Missing or invalid tenant headers, not a member of the organization/workspace, or the caller's roles do not grant catalog:read",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const createCategoryRoute = createRoute({
  method: "post",
  path: "/workspace/catalog/categories",
  middleware: [
    requireLevelPermissions({
      level: "organizationWorkspace",
      permission: "catalog:category:create",
    }),
  ],
  tags: ["catalog"],
  summary: "Create a menu category in the active workspace",
  description:
    "Creates a category in the workspace named by the x-workspace-id header, appended to the end of the current order (max position + 1). The actor is taken from the session and a catalog_category.created audit row is written on the same transaction. Requires catalog:category:create; a name already used in the workspace is rejected as a conflict.",
  request: {
    headers: catalogTenantHeadersSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createCategorySchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Category created",
      content: {
        "application/json": {
          schema: createCategoryResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Missing or invalid tenant headers, not a member of the organization/workspace, or the caller's roles do not grant catalog:category:create",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description: "The workspace disappeared between the tenant check and the insert",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description: "A category with that name already exists in the workspace",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const reorderCategoriesRoute = createRoute({
  method: "patch",
  path: "/workspace/catalog/categories/reorder",
  middleware: [
    requireLevelPermissions({
      level: "organizationWorkspace",
      permission: "catalog:category:update",
    }),
  ],
  tags: ["catalog"],
  summary: "Reorder the active workspace's menu categories",
  description:
    "Rewrites category positions from a full ordered id list — the client sends every category id of the workspace exactly once, in display order, and positions become 0..n-1. A list that does not match the workspace's current categories (stale view, foreign id, duplicate) is rejected as a conflict, so a reorder never silently drops or resurrects rows. Requires catalog:category:update; one catalog_category.updated audit row is written per moved category on the same transaction.",
  request: {
    headers: catalogTenantHeadersSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: reorderCategoriesSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "The workspace's categories in the new order",
      content: {
        "application/json": {
          schema: reorderCategoriesResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Missing or invalid tenant headers, not a member of the organization/workspace, or the caller's roles do not grant catalog:category:update",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description: "The id list does not match the workspace's categories",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/workspace/catalog/categories/{categoryId}",
  middleware: [
    requireLevelPermissions({
      level: "organizationWorkspace",
      permission: "catalog:category:update",
    }),
  ],
  tags: ["catalog"],
  summary: "Update a menu category of the active workspace",
  description:
    "Updates a category's name, description, and/or active flag. A no-change request returns the current row without writing an audit row. Requires catalog:category:update; a catalog_category.updated audit row with the field-level diff is written on the same transaction. A category of another workspace is indistinguishable from a missing one and reported as not found; a name already used in the workspace is rejected as a conflict.",
  request: {
    headers: catalogTenantHeadersSchema,
    params: z.object({
      categoryId: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: updateCategorySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Category updated (or unchanged)",
      content: {
        "application/json": {
          schema: updateCategoryResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Missing or invalid tenant headers, not a member of the organization/workspace, or the caller's roles do not grant catalog:category:update",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "No category with that id in the x-workspace-id workspace",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    409: {
      description: "Another category in the workspace already uses that name",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

const archiveCategoryRoute = createRoute({
  method: "delete",
  path: "/workspace/catalog/categories/{categoryId}",
  middleware: [
    requireLevelPermissions({
      level: "organizationWorkspace",
      permission: "catalog:category:delete",
    }),
  ],
  tags: ["catalog"],
  summary: "Archive a menu category of the active workspace",
  description:
    "Archives the category (is_active = false) instead of deleting it, so rows stay referenceable by menu items and future orders; archiving an already archived category returns the current row without writing an audit row. Requires catalog:category:delete; a catalog_category.archived audit row is written on the same transaction. A category of another workspace is indistinguishable from a missing one and reported as not found.",
  request: {
    headers: catalogTenantHeadersSchema,
    params: z.object({
      categoryId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: "Category archived",
      content: {
        "application/json": {
          schema: updateCategoryResponseSchema,
        },
      },
    },
    400: {
      description: "Invalid input",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    401: {
      description: "Not signed in",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    403: {
      description:
        "Missing or invalid tenant headers, not a member of the organization/workspace, or the caller's roles do not grant catalog:category:delete",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
    404: {
      description:
        "No category with that id in the x-workspace-id workspace",
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
    },
  },
});

// The reorder route must be registered before the {categoryId} param routes so
// PATCH /categories/reorder is not captured by the param pattern.
catalogCategoriesRoutes.openapi(reorderCategoriesRoute, async (c) => {
  const body = c.req.valid("json");
  const workspaceId = getWorkspaceIdHeader(c);
  const user = getContextUser(c);

  const result = await new CatalogCategoriesService(db).reorderCategories({
    ...body,
    workspaceId,
    // Always from the session; never from the request body.
    userId: user.id,
  });

  return c.json(result, StatusCodes.OK);
});

catalogCategoriesRoutes.openapi(getCategoriesRoute, async (c) => {
  const workspaceId = getWorkspaceIdHeader(c);

  const result = await new CatalogCategoriesService(db).getCatalogCategories({
    filters: { workspaceId },
  });

  return c.json(result, StatusCodes.OK);
});

catalogCategoriesRoutes.openapi(createCategoryRoute, async (c) => {
  const body = c.req.valid("json");
  const workspaceId = getWorkspaceIdHeader(c);
  const user = getContextUser(c);

  const result = await new CatalogCategoriesService(db).createCategory({
    ...body,
    workspaceId,
    // Always from the session; never from the request body.
    userId: user.id,
  });

  if (!result.category) {
    throw new NotFoundError("workspace not found");
  }

  return c.json(result, StatusCodes.CREATED);
});

catalogCategoriesRoutes.openapi(updateCategoryRoute, async (c) => {
  const { categoryId } = c.req.valid("param");
  const body = c.req.valid("json");
  const workspaceId = getWorkspaceIdHeader(c);
  const user = getContextUser(c);

  const result = await new CatalogCategoriesService(db).updateCategory({
    ...body,
    id: categoryId,
    workspaceId,
    // Always from the session; never from the request body.
    userId: user.id,
  });

  if (!result.category) {
    throw new NotFoundError("category not found in this workspace");
  }

  return c.json(result, StatusCodes.OK);
});

catalogCategoriesRoutes.openapi(archiveCategoryRoute, async (c) => {
  const { categoryId } = c.req.valid("param");
  const workspaceId = getWorkspaceIdHeader(c);
  const user = getContextUser(c);

  const result = await new CatalogCategoriesService(db).archiveCategory({
    id: categoryId,
    workspaceId,
    // Always from the session; never from the request body.
    userId: user.id,
  });

  if (!result.category) {
    throw new NotFoundError("category not found in this workspace");
  }

  return c.json(result, StatusCodes.OK);
});

export { catalogCategoriesRoutes };
