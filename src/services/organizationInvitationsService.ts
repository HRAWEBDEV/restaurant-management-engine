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

const getOrganizationInvitationsFiltersSchema = z.object({
  organizationId: z.uuid(),
  status: z.enum(organizationInvitationStatusEnum.enumValues).optional(),
});

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
   * Returns an organization's invitations, newest first, joined with the
   * organization and the inviter's user row. Optionally narrowed by status.
   *
   * There is no scheduler: pending rows past `expires_at` are flipped to
   * `expired` here before the read, so callers never see stale pending rows.
   */
  async getOrganizationInvitations(
    props: GetOrganizationInvitationsProps,
  ): Promise<GetOrganizationInvitationsResponse> {
    const filterConditions: SQL[] = [
      eq(
        organizationInvitations.organizationId,
        props.filters.organizationId,
      ),
    ];

    if (props.filters.status) {
      filterConditions.push(
        eq(organizationInvitations.status, props.filters.status),
      );
    }

    await this.expireStalePendingInvitations({
      organizationId: props.filters.organizationId,
    });

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
   * one organization, optionally to a single invitee address. Runs on the
   * caller's executor so it participates in an enclosing transaction.
   */
  private async expireStalePendingInvitations(props: {
    organizationId: string;
    invitedUserEmail?: string;
    executor?: DBExecutor;
  }) {
    const conditions: SQL[] = [
      eq(organizationInvitations.organizationId, props.organizationId),
      eq(organizationInvitations.status, "pending"),
      lt(organizationInvitations.expiresAt, new Date()),
    ];

    if (props.invitedUserEmail) {
      conditions.push(
        eq(organizationInvitations.invitedUserEmail, props.invitedUserEmail),
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
