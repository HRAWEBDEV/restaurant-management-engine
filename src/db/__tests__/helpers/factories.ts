import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { user } from "../../../../auth-schema";
import { organizationMembers } from "../../schemas/organizationMembers";
import { workspaceMembers } from "../../schemas/workspaceMembers";
import { OrganizationsService } from "../../../services/organizationsService";
import { WorkspacesService } from "../../../services/workspacesService";
import type { TestDb } from "./db";

/**
 * Inserts a Better Auth user row directly, the way a signup would. Emails and
 * usernames are unique per call, so tests can run in parallel without colliding.
 */
async function createTestUser(
  db: TestDb,
  overrides: {
    name?: string;
    email?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  } = {},
) {
  const id = `user_${nanoid(10)}`;
  // Better Auth's username plugin stores usernames lowercase; match that so
  // fixtures reflect what production rows look like.
  const username = (overrides.username ?? id).toLowerCase();
  const [created] = await db
    .insert(user)
    .values({
      id,
      name: overrides.name ?? `Test User ${id}`,
      email: overrides.email ?? `${id}@example.com`,
      username,
      firstName: overrides.firstName ?? "Test",
      lastName: overrides.lastName ?? "User",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  if (!created) {
    throw new Error("user insert returned no row");
  }

  return created;
}

/**
 * Creates an organization through the service (generated slug, owner
 * membership included) and returns it with the owner membership row.
 */
async function createTestOrganization(
  db: TestDb,
  userId: string,
  props: { name?: string; description?: string | null } = {},
) {
  const { organization } = await new OrganizationsService(
    db,
  ).createOrganization({
    userId,
    name: props.name ?? `Acme ${nanoid(8)}`,
    description: props.description ?? null,
  });

  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organization.id),
        eq(organizationMembers.userId, userId),
      ),
    );

  if (!membership) {
    throw new Error("organization membership was not created");
  }

  return { organization, membership };
}

/** Creates a workspace through the service (creator becomes workspace admin). */
async function createTestWorkspace(
  db: TestDb,
  organizationId: string,
  userId: string,
  props: { name?: string; description?: string | null } = {},
) {
  const { workspace } = await new WorkspacesService(db).createWorkspace({
    organizationId,
    userId,
    name: props.name ?? `Workspace ${nanoid(8)}`,
    description: props.description ?? null,
  });

  if (!workspace) {
    throw new Error("workspace was not created; caller is not an organization member");
  }

  return workspace;
}

/** Inserts an additional organization membership directly. */
async function addOrganizationMember(
  db: TestDb,
  props: {
    organizationId: string;
    userId: string;
    role?: "owner" | "admin" | "member";
    addedBy?: string | null;
  },
) {
  const [member] = await db
    .insert(organizationMembers)
    .values({
      organizationId: props.organizationId,
      userId: props.userId,
      role: props.role ?? "member",
      addedBy: props.addedBy ?? null,
    })
    .returning();

  if (!member) {
    throw new Error("organization member insert returned no row");
  }

  return member;
}

/**
 * Inserts a workspace membership directly, tied to an existing organization
 * membership row (the composite FK requires it).
 */
async function addWorkspaceMember(
  db: TestDb,
  props: {
    workspaceId: string;
    organizationMemberId: string;
    organizationId: string;
    role?: "admin" | "member";
    addedBy?: string | null;
  },
) {
  const [member] = await db
    .insert(workspaceMembers)
    .values({
      workspaceId: props.workspaceId,
      organizationMemberId: props.organizationMemberId,
      organizationId: props.organizationId,
      role: props.role ?? "member",
      addedBy: props.addedBy ?? null,
    })
    .returning();

  if (!member) {
    throw new Error("workspace member insert returned no row");
  }

  return member;
}

export {
  addOrganizationMember,
  addWorkspaceMember,
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
};
