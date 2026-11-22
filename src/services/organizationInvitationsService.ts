import { z } from "@hono/zod-openapi";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DBExecutor } from "../db/connect";
import {
  organizationInvitations,
  organizationInvitationStatusEnum,
  selectOrganizationInvitationSchema,
} from "../db/schemas/organizationInvitations";
import {
  organizations,
  selectOrganizationSchema,
} from "../db/schemas/organizations";
import { organizationMembers } from "../db/schemas/organizationMembers";
import { selectUserSchema, user } from "../../auth-schema";
import { organizationInvitationActivity } from "../utils/activityDefinitions";
import { ConflictError } from "../utils/ConflictError";
import { InternalError } from "../utils/InternalError";
import { ActivityLogger } from "./activityLoggerService";
import { UsersService } from "./usersService";

const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Postgres reports unique-constraint violations with SQLSTATE 23505. Drizzle
 * wraps driver errors in `DrizzleQueryError`, so the `errno` may sit on the
 * error itself or on its `cause`.
 */
function isUniqueViolation(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("errno" in error) {
    return error.errno === "23505";
  }

  const cause = "cause" in error ? error.cause : null;

  return (
    typeof cause === "object" &&
    cause !== null &&
    "errno" in cause &&
    cause.errno === "23505"
  );
}

const getOrganizationInvitationsFiltersSchema = z
  .object({
    organizationId: z.uuid().optional(),
    userId: z.string().optional(),
    status: z.enum(organizationInvitationStatusEnum.enumValues).optional(),
  })
  .refine(
    (filters) =>
      filters.organizationId !== undefined || filters.userId !== undefined,
    { message: "organizationId or userId is required" },
  );

type GetOrganizationInvitationsFilters = z.infer<
  typeof getOrganizationInvitationsFiltersSchema
>;

type GetOrganizationInvitationsProps = {
  filters: GetOrganizationInvitationsFilters;
};

const organizationInvitationWithRelationsSchema = z.object({
  invitation: selectOrganizationInvitationSchema,
  organization: selectOrganizationSchema,
  invitedByUser: selectUserSchema,
});

const getOrganizationInvitationsResponseSchema = z.object({
  invitations: z.array(organizationInvitationWithRelationsSchema),
});

type GetOrganizationInvitationsResponse = z.infer<
  typeof getOrganizationInvitationsResponseSchema
>;

const sendInviteSchema = z.object({
  organizationId: z.uuid(),
  invitedUserEmail: z.email().max(255),
});

type SendInviteInput = z.infer<typeof sendInviteSchema>;

type SendInviteProps = SendInviteInput & {
  invitedBy: string;
};

const sendInviteResponseSchema = z.object({
  invitation: selectOrganizationInvitationSchema,
});

type SendInviteResponse = z.infer<typeof sendInviteResponseSchema>;

const invitedByUser = alias(user, "invited_by_user");

/**
 * Data access service for organization invitations.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class OrganizationInvitationsService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns invitations newest first, joined with the organization and the
   * inviter's user row. At least one of `organizationId` (an organization's
   * invitations) or `userId` (invitations addressed to that user's email, their
   * inbox) is required; both narrow the read to one organization's invitations
   * for one user. Optionally narrowed by status.
   *
   * There is no scheduler: pending rows past `expires_at` are flipped to
   * `expired` here before the read, scoped to the filters being read, so
   * callers never see stale pending rows.
   */
  async getOrganizationInvitations(
    props: GetOrganizationInvitationsProps,
  ): Promise<GetOrganizationInvitationsResponse> {
    const filters = props.filters;
    let inviteeEmail: string | undefined;

    if (filters.userId) {
      const { user: invitee } = await new UsersService(this.db).getUserById({
        id: filters.userId,
      });

      if (!invitee) {
        return { invitations: [] };
      }

      inviteeEmail = invitee.email.toLowerCase();
    }

    if (!filters.organizationId && !inviteeEmail) {
      // Unreachable through the filters schema; guarded so the read can never
      // degrade into an unscoped full-table scan.
      throw new InternalError("organizationId or userId filter is required");
    }

    await this.expireStalePendingInvitations({
      organizationId: filters.organizationId,
      invitedUserEmail: inviteeEmail,
    });

    const filterConditions: SQL[] = [];

    if (filters.organizationId) {
      filterConditions.push(
        eq(organizationInvitations.organizationId, filters.organizationId),
      );
    }

    if (inviteeEmail) {
      // Invitations are stored normalized to lowercase; lowering both sides
      // keeps the comparison safe for rows written before that invariant.
      filterConditions.push(
        sql`lower(${organizationInvitations.invitedUserEmail}) = ${inviteeEmail}`,
      );
    }

    if (filters.status) {
      filterConditions.push(
        eq(organizationInvitations.status, filters.status),
      );
    }

    const invitations = await this.db
      .select({
        invitation: organizationInvitations,
        organization: organizations,
        invitedByUser,
      })
      .from(organizationInvitations)
      .innerJoin(
        organizations,
        eq(organizationInvitations.organizationId, organizations.id),
      )
      .innerJoin(
        invitedByUser,
        eq(organizationInvitations.invitedBy, invitedByUser.id),
      )
      .where(and(...filterConditions))
      .orderBy(desc(organizationInvitations.createdAt));

    return { invitations };
  }

  /**
   * Creates a pending invitation for an email address. The inviter is set from
   * the session by the route layer; the email is normalized to lowercase and
   * the expiry is server-managed (7 days).
   *
   * Inviting an existing member raises `ConflictError`. Within one transaction,
   * a stale pending invitation for the same address is expired first, then the
   * fresh row is inserted — so a partial-unique violation means a live
   * invitation is still pending, which also raises `ConflictError` (re-inviting
   * is only possible after the pending row reaches a terminal status). An
   * `invitation.created` activity row is written on the same transaction.
   */
  async sendInvite(props: SendInviteProps): Promise<SendInviteResponse> {
    const invitedUserEmail = props.invitedUserEmail.trim().toLowerCase();

    const [existingMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .innerJoin(user, eq(organizationMembers.userId, user.id))
      .where(
        and(
          eq(organizationMembers.organizationId, props.organizationId),
          sql`lower(${user.email}) = ${invitedUserEmail}`,
        ),
      )
      .limit(1);

    if (existingMember) {
      throw new ConflictError("user is already a member of this organization");
    }

    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: inviter } = await new UsersService(this.db).getUserById({
      id: props.invitedBy,
    });
    const actorLabel = inviter?.name ?? "unknown user";

    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    try {
      return await this.db.transaction(async (tx) => {
        await this.expireStalePendingInvitations({
          organizationId: props.organizationId,
          invitedUserEmail,
          executor: tx,
        });

        const [invitation] = await tx
          .insert(organizationInvitations)
          .values({
            organizationId: props.organizationId,
            invitedBy: props.invitedBy,
            invitedUserEmail,
            expiresAt,
          })
          .returning();

        if (!invitation) {
          throw new InternalError("organization invitation insert returned no row");
        }

        // Written on the same transaction, so the audit row commits or
        // rolls back together with the invitation.
        await new ActivityLogger(tx).recordChange(
          organizationInvitationActivity,
          {
            organizationId: props.organizationId,
            workspaceId: null,
            actor: { userId: props.invitedBy, label: actorLabel },
            action: "created",
            entityId: invitation.id,
            after: invitation,
          },
        );

        return { invitation };
      });
    } catch (error) {
      // Only the pending-unique index carries a unique constraint on this
      // table; a violation means a live invitation is already pending.
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "an invitation is already pending for this email",
        );
      }

      throw error;
    }
  }

  /**
   * Flips pending rows past `expires_at` to `expired` (lazy expiry). Scoped to
   * an organization and/or a single invitee address; at least one scope is
   * required. Runs on the caller's executor so it participates in an enclosing
   * transaction.
   */
  private async expireStalePendingInvitations(props: {
    organizationId?: string;
    invitedUserEmail?: string;
    executor?: DBExecutor;
  }) {
    const conditions: SQL[] = [
      eq(organizationInvitations.status, "pending"),
      lt(organizationInvitations.expiresAt, new Date()),
    ];

    if (props.organizationId) {
      conditions.push(
        eq(organizationInvitations.organizationId, props.organizationId),
      );
    }

    if (props.invitedUserEmail) {
      conditions.push(
        sql`lower(${organizationInvitations.invitedUserEmail}) = ${props.invitedUserEmail}`,
      );
    }

    const executor = props.executor ?? this.db;

    await executor
      .update(organizationInvitations)
      .set({ status: "expired" })
      .where(and(...conditions));
  }
}

export type {
  GetOrganizationInvitationsFilters,
  GetOrganizationInvitationsProps,
  GetOrganizationInvitationsResponse,
  SendInviteInput,
  SendInviteProps,
  SendInviteResponse,
};
export {
  getOrganizationInvitationsFiltersSchema,
  organizationInvitationWithRelationsSchema,
  getOrganizationInvitationsResponseSchema,
  sendInviteSchema,
  sendInviteResponseSchema,
  OrganizationInvitationsService,
};
