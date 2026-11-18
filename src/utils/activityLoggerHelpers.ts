import type {
  ActivityChanges,
  ActivityLogMetadata,
} from "../db/schemas/activityLogs";

type ActivityActor = {
  /** null for jobs, webhooks, and other non-user actors */
  userId: string | null;
  /** Snapshot stored on the row; survives user deletion or rename. */
  label: string;
};

type ActivityDefinition<TEntity, TAction extends string = string> = {
  entityType: string;
  /** Legal verbs for this entity; enforced when recording a change. */
  actions: readonly TAction[];
  /** Fields captured in `changes`; everything else is ignored. */
  diff?: readonly (keyof TEntity & string)[];
  /** Frozen summary rendered at write time. */
  summarize?: (context: {
    action: TAction;
    actor: string;
    before?: TEntity;
    after?: TEntity;
  }) => string;
};

type RecordChangeInput<TEntity, TAction extends string> = {
  organizationId: string;
  workspaceId?: string | null;
  actor: ActivityActor;
  action: TAction;
  entityId: string;
  source?: string;
  before?: TEntity | null;
  after?: TEntity | null;
  /** Overrides the definition's summary. */
  summary?: string;
  /** Overrides the diff built from the definition's allowlist. */
  changes?: ActivityChanges | null;
  metadata?: ActivityLogMetadata | null;
};

/**
 * Types the definition and preserves the literal action union, so a typo in
 * `action` fails at compile time instead of writing a bad audit row.
 */
function defineActivity<TEntity>() {
  return <const TAction extends string>(
    definition: ActivityDefinition<TEntity, TAction>,
  ): ActivityDefinition<TEntity, TAction> => definition;
}

function isSameValue(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Builds a field-level diff limited to `fields`. Unchanged fields are dropped,
 * a missing side becomes `null` (create: `from: null`, delete: `to: null`), and
 * the result is `null` when nothing changed.
 */
function buildChanges<TEntity>(
  before: TEntity | null | undefined,
  after: TEntity | null | undefined,
  fields: readonly (keyof TEntity & string)[] | undefined,
): ActivityChanges | null {
  if (!fields || fields.length === 0) return null;

  const changes: ActivityChanges = {};
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (!isSameValue(from, to)) {
      changes[field] = { from, to };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

function assertAllowedAction<TEntity, TAction extends string>(
  definition: ActivityDefinition<TEntity, TAction>,
  action: TAction,
) {
  if (!definition.actions.includes(action)) {
    throw new Error(
      `activity action "${action}" is not defined for "${definition.entityType}"`,
    );
  }
}

function renderSummary<TEntity, TAction extends string>(
  definition: ActivityDefinition<TEntity, TAction>,
  input: Pick<
    RecordChangeInput<TEntity, TAction>,
    "action" | "actor" | "before" | "after"
  >,
) {
  return (
    definition.summarize?.({
      action: input.action,
      actor: input.actor.label,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
    }) ?? `${input.actor.label} ${input.action} ${definition.entityType}`
  );
}

export type { ActivityActor, ActivityDefinition, RecordChangeInput };
export { assertAllowedAction, buildChanges, defineActivity, renderSummary };
