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

const getOrganizationInvitationResponseSchema = z.object({
  invitation: selectOrganizationInvitationSchema,
});

type GetOrganizationInvitationResponse = z.infer<
  typeof getOrganizationInvitationResponseSchema
>;

type GetOrganizationInvitationProps = {
  organizationId: string;
  invitationId: string;
  /** Runs on the given executor instead of the service's db, e.g. inside a transaction. */
  executor?: DBExecutor;
};

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

const revokeInviteSchema = z.object({
  organizationId: z.uuid(),
  invitationId: z.uuid(),
});

type RevokeInviteInput = z.infer<typeof revokeInviteSchema>;

type RevokeInviteProps = RevokeInviteInput & {
  revokedBy: string;
};

const revokeInviteResponseSchema = z.object({
  invitation: selectOrganizationInvitationSchema,
});

type RevokeInviteResponse = z.infer<typeof revokeInviteResponseSchema>;

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
      filterConditions.push(eq(organizationInvitations.status, filters.status));
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
   * Returns a single invitation by id, scoped to an organization so an
   * invitation belonging to another organization is indistinguishable from a
   * missing one (`null` in both cases; the route layer maps that to 404).
   *
   * Like the list read, a pending row past `expires_at` is flipped to `expired`
   * (scoped to this row) before it is returned, so callers never see stale
   * pending rows. Runs on the caller's executor when one is passed, so it
   * participates in an enclosing transaction.
   */
  async getOrganizationInvitation(
    props: GetOrganizationInvitationProps,
  ): Promise<GetOrganizationInvitationResponse | null> {
    const executor = props.executor ?? this.db;

    const [invitation] = await executor
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.id, props.invitationId),
          eq(organizationInvitations.organizationId, props.organizationId),
        ),
      )
      .limit(1);

    if (!invitation) {
      return null;
    }

    if (
      invitation.status === "pending" &&
      invitation.expiresAt.getTime() < Date.now()
    ) {
      await this.expireStalePendingInvitations({
        organizationId: props.organizationId,
        invitationId: invitation.id,
        executor,
      });

      const [refreshed] = await executor
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.id, invitation.id))
        .limit(1);

      return { invitation: refreshed ?? invitation };
    }

    return { invitation };
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
          throw new InternalError(
            "organization invitation insert returned no row",
          );
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
   * Revokes a pending invitation, flipping it to the terminal `revoked` status
   * (rows are kept as history, never deleted). The revoker is set from the
   * session by the route layer; the lookup is scoped to `organizationId`, so an
   * invitation from another organization is indistinguishable from a missing
   * one.
   *
   * Returns `null` when no invitation with that id exists in the organization
   * (the route layer maps that to 404). Revoking anything that is not pending
   * raises `ConflictError`; stale pending rows are lazily expired first, so an
   * expired invitation is rejected rather than revoked. Revoking frees the
   * invitee's email for a new pending invitation (the partial-unique index only
   * covers pending rows). An `invitation.revoked` activity row is written on
   * the same transaction.
   */
  async revokeInvite(
    props: RevokeInviteProps,
  ): Promise<RevokeInviteResponse | null> {
    // Snapshot label for the audit row; survives later user renames/deletes.
    const { user: revoker } = await new UsersService(this.db).getUserById({
      id: props.revokedBy,
    });
    const actorLabel = revoker?.name ?? "unknown user";

    const invitation = await this.db.transaction(async (tx) => {
      await this.expireStalePendingInvitations({
        organizationId: props.organizationId,
        executor: tx,
      });

      // Conditional update: only a still-pending row in this organization is
      // revocable, so no separate read is needed on the happy path.
      const [revoked] = await tx
        .update(organizationInvitations)
        .set({ status: "revoked" })
        .where(
          and(
            eq(organizationInvitations.id, props.invitationId),
            eq(organizationInvitations.organizationId, props.organizationId),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .returning();

      if (revoked) {
        // Written on the same transaction, so the audit row commits or
        // rolls back together with the revocation.
        await new ActivityLogger(tx).recordChange(
          organizationInvitationActivity,
          {
            organizationId: props.organizationId,
            workspaceId: null,
            actor: { userId: props.revokedBy, label: actorLabel },
            action: "revoked",
            entityId: revoked.id,
            before: { ...revoked, status: "pending" },
            after: revoked,
          },
        );

        return revoked;
      }

      // No row updated: distinguish a missing invitation from one that is not
      // pending anymore.
      const existing = await this.getOrganizationInvitation({
        organizationId: props.organizationId,
        invitationId: props.invitationId,
        executor: tx,
      });

      if (!existing) {
        return null;
      }

      throw new ConflictError("only pending invitations can be revoked");
    });

    if (!invitation) {
      return null;
    }

    return { invitation };
  }

  /**
   * Flips pending rows past `expires_at` to `expired` (lazy expiry). Scoped to
   * an organization, a single invitee address, and/or a single invitation id;
   * at least one scope is required. Runs on the caller's executor so it
   * participates in an enclosing transaction.
   */
  private async expireStalePendingInvitations(props: {
    organizationId?: string;
    invitedUserEmail?: string;
    invitationId?: string;
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

    if (props.invitationId) {
      conditions.push(eq(organizationInvitations.id, props.invitationId));
    }

    const executor = props.executor ?? this.db;

    await executor
      .update(organizationInvitations)
      .set({ status: "expired" })
      .where(and(...conditions));
  }
}

export type {
  GetOrganizationInvitationProps,
  GetOrganizationInvitationResponse,
  GetOrganizationInvitationsFilters,
  GetOrganizationInvitationsProps,
  GetOrganizationInvitationsResponse,
  SendInviteInput,
  SendInviteProps,
  SendInviteResponse,
  RevokeInviteInput,
  RevokeInviteProps,
  RevokeInviteResponse,
};
export {
  getOrganizationInvitationResponseSchema,
  getOrganizationInvitationsFiltersSchema,
  organizationInvitationWithRelationsSchema,
  getOrganizationInvitationsResponseSchema,
  sendInviteSchema,
  sendInviteResponseSchema,
  revokeInviteSchema,
  revokeInviteResponseSchema,
  OrganizationInvitationsService,
};
