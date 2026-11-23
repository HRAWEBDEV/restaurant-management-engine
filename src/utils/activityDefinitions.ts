import type { OrganizationInvitation } from "../db/schemas/organizationInvitations";
import type { OrganizationMember } from "../db/schemas/organizationMembers";
import type { Organization } from "../db/schemas/organizations";
import type { WorkspaceMember } from "../db/schemas/workspaceMembers";
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

/**
 * Audit definition for organization invitations. The summary names the invitee
 * address so a feed stays readable after the invitation is deleted; `diff`
 * captures status transitions and the expiry window.
 */
const organizationInvitationActivity = defineActivity<OrganizationInvitation>()({
  entityType: "organization_invitation",
  actions: ["created", "accepted", "updated", "revoked"],
  diff: ["invitedUserEmail", "status", "expiresAt"],
  summarize: ({ action, actor, before, after }) => {
    const email = after?.invitedUserEmail ?? before?.invitedUserEmail;

    return `${actor} ${action} invitation${email ? ` for "${email}"` : ""}`;
  },
});

/**
 * Audit definition for organization memberships. The summary names the role so
 * a feed stays readable; `diff` captures role transitions.
 */
const organizationMemberActivity = defineActivity<OrganizationMember>()({
  entityType: "organization_member",
  actions: ["created", "updated", "deleted"],
  diff: ["role"],
  summarize: ({ action, actor, before, after }) => {
    const role = after?.role ?? before?.role;

    return `${actor} ${action} membership${role ? ` as "${role}"` : ""}`;
  },
});

/**
 * Audit definition for workspace memberships. The summary names the role so
 * a feed stays readable; `diff` captures role transitions.
 */
const workspaceMemberActivity = defineActivity<WorkspaceMember>()({
  entityType: "workspace_member",
  actions: ["created", "updated", "deleted"],
  diff: ["role"],
  summarize: ({ action, actor, before, after }) => {
    const role = after?.role ?? before?.role;

    return `${actor} ${action} workspace membership${role ? ` as "${role}"` : ""}`;
  },
});

type WorkspaceActivityAction = (typeof workspaceActivity)["actions"][number];

type OrganizationActivityAction =
  (typeof organizationActivity)["actions"][number];

type OrganizationInvitationActivityAction =
  (typeof organizationInvitationActivity)["actions"][number];

type OrganizationMemberActivityAction =
  (typeof organizationMemberActivity)["actions"][number];

type WorkspaceMemberActivityAction =
  (typeof workspaceMemberActivity)["actions"][number];

export type {
  WorkspaceActivityAction,
  OrganizationActivityAction,
  OrganizationInvitationActivityAction,
  OrganizationMemberActivityAction,
  WorkspaceMemberActivityAction,
};
export {
  workspaceActivity,
  organizationActivity,
  organizationInvitationActivity,
  organizationMemberActivity,
  workspaceMemberActivity,
};
