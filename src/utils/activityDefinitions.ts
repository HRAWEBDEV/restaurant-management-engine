import type { Organization } from "../db/schemas/organizations";
import type { Workspace } from "../db/schemas/workspaces";
import { defineActivity } from "./activityLoggerHelpers";

/**
 * Audit definition for organizations. Actions are the legal verbs recorded on
 * activity rows; `diff` is the field allowlist captured in `changes`; the
 * summary is rendered once at write time and never regenerated.
 */
const organizationActivity = defineActivity<Organization>()({
  entityType: "organization",
  actions: ["created", "updated", "deleted"],
  diff: ["name", "slug", "logo", "description"],
  summarize: ({ action, actor, before, after }) => {
    const name = after?.name ?? before?.name;

    return `${actor} ${action} organization${name ? ` "${name}"` : ""}`;
  },
});

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

type OrganizationActivityAction =
  (typeof organizationActivity)["actions"][number];

export type { WorkspaceActivityAction, OrganizationActivityAction };
export { workspaceActivity, organizationActivity };
