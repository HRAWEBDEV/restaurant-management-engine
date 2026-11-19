import { z } from "@hono/zod-openapi";
import type { DBExecutor } from "../db/connect";
import { selectOrganizationSchema } from "../db/schemas/organizations";
import { selectWorkspaceSchema } from "../db/schemas/workspaces";
import { InternalError } from "../utils/InternalError";
import { OrganizationsService } from "./organizationsService";
import { WorkspacesService } from "./workspacesService";

const createAccountOrganizationSchema = z.object({
  name: z.string().min(1).max(100),
  logo: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const createAccountWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
});

type CreateAccountOrganization = z.infer<typeof createAccountOrganizationSchema>;
type CreateAccountWorkspace = z.infer<typeof createAccountWorkspaceSchema>;

type CreateAccountProps = {
  userId: string;
  organization: CreateAccountOrganization;
  workspace?: CreateAccountWorkspace;
};

const createAccountResponseSchema = z.object({
  organization: selectOrganizationSchema,
  workspace: selectWorkspaceSchema,
});

type CreateAccountResponse = z.infer<typeof createAccountResponseSchema>;

/**
 * Account setup service.
 *
 * Orchestrates the aggregates created together when a user account is set up.
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class AccountsService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Creates the user's organization (the user becomes its owner, membership
   * included) and a default workspace inside it (the user becomes a workspace
   * admin, membership and audit row included).
   *
   * The workspace name defaults to the organization name. Returns the created
   * organization and workspace.
   */
  async create(props: CreateAccountProps): Promise<CreateAccountResponse> {
    const { organization } = await new OrganizationsService(
      this.db,
    ).createOrganization({
      userId: props.userId,
      name: props.organization.name,
      logo: props.organization.logo,
      description: props.organization.description,
    });

    const { workspace } = await new WorkspacesService(this.db).createWorkspace({
      organizationId: organization.id,
      userId: props.userId,
      name: props.workspace?.name ?? props.organization.name,
      description: props.workspace?.description,
    });

    if (!workspace) {
      // createWorkspace returns null only when the caller is not an
      // organization member, which cannot happen here: createOrganization
      // added the caller as the organization owner in the step above.
      throw new InternalError("default workspace was not created");
    }

    return { organization, workspace };
  }
}

export type {
  CreateAccountOrganization,
  CreateAccountWorkspace,
  CreateAccountProps,
  CreateAccountResponse,
};
export {
  createAccountOrganizationSchema,
  createAccountWorkspaceSchema,
  createAccountResponseSchema,
  AccountsService,
};
