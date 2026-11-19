import type { Workspace } from "../db/schemas/workspaces";
import { defineActivity } from "./activityLoggerHelpers";

/**
 * Audit definition for workspaces. Actions are the legal verbs recorded on
 * activity rows; `diff` is the field allowlist captured in `changes`; the
 * summary is rendered once at write time and never regenerated.
 */
const workspaceActivity = defineActivity<Workspace>()({
  entityType: "workspace",
  actions: ["created", "updated", "deleted"],
  diff: ["name", "slug", "description"],
  summarize: ({ action, actor, before, after }) => {
    const name = after?.name ?? before?.name;

    return `${actor} ${action} workspace${name ? ` "${name}"` : ""}`;
  },
});

type WorkspaceActivityAction = (typeof workspaceActivity)["actions"][number];

export type { WorkspaceActivityAction };
export { workspaceActivity };
