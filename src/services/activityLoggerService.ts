import type { DBExecutor } from "../db/connect";
import {
  activityLogs,
  type ActivityChanges,
  type ActivityLog,
  type ActivityLogMetadata,
} from "../db/schemas/activityLogs";
import {
  assertAllowedAction,
  buildChanges,
  renderSummary,
  type ActivityDefinition,
  type RecordChangeInput,
} from "../utils/activityLoggerHelpers";

type RecordActivityInput = {
  organizationId: string;
  workspaceId?: string | null;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  source?: string;
  changes?: ActivityChanges | null;
  metadata?: ActivityLogMetadata | null;
};

/**
 * Writes append-only activity/audit rows. Construct it with the caller's
 * executor (`db` or a transaction) so a log is committed or rolled back with
 * the state change it describes.
 */
class ActivityLogger {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Inserts one activity log row and returns it. The caller is responsible for
   * supplying an already-rendered `summary`, the tenant scope, and the diff
   * payload; everything is frozen as written.
   */
  async record(input: RecordActivityInput): Promise<ActivityLog> {
    const [log] = await this.db
      .insert(activityLogs)
      .values({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId ?? null,
        actorUserId: input.actorUserId,
        actorLabel: input.actorLabel,
        source: input.source ?? "api",
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        summary: input.summary,
        changes: input.changes ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    if (!log) {
      throw new Error("failed to write activity log");
    }

    return log;
  }

  /**
   * Records a change using an entity definition: validates the action, renders
   * the summary, and builds the diff from the definition's allowlist unless the
   * caller overrides them. Must run in the same transaction as the mutation.
   */
  async recordChange<TEntity, TAction extends string>(
    definition: ActivityDefinition<TEntity, TAction>,
    input: RecordChangeInput<TEntity, TAction>,
  ): Promise<ActivityLog> {
    assertAllowedAction(definition, input.action);

    return this.record({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      actorUserId: input.actor.userId,
      actorLabel: input.actor.label,
      source: input.source,
      action: input.action,
      entityType: definition.entityType,
      entityId: input.entityId,
      summary: input.summary ?? renderSummary(definition, input),
      changes:
        input.changes !== undefined
          ? input.changes
          : buildChanges(input.before, input.after, definition.diff),
      metadata: input.metadata,
    });
  }
}

export type { RecordActivityInput };
export { ActivityLogger };
