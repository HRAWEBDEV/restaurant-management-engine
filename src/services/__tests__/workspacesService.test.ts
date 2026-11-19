import { eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { workspaceMembers } from "../../db/schemas/workspaceMembers";
import { WorkspacesService } from "../workspacesService";

const workspacesService = new WorkspacesService(testDb);

describe("WorkspacesService.createWorkspace", () => {
  it("creates the workspace, adds the creator as admin, and writes the audit row", async () => {
    const owner = await createTestUser(testDb, { name: "Hamid" });
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { workspace } = await workspacesService.createWorkspace({
      organizationId: organization.id,
      userId: owner.id,
      name: "Downtown",
    });

    if (!workspace) {
      throw new Error("workspace was not created");
    }

    expect(workspace.slug).toMatch(/^downtown-/);

    const memberships = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      role: "admin",
      addedBy: owner.id,
    });

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.workspaceId, workspace.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "created",
      entityType: "workspace",
      actorLabel: "Hamid",
    });
  });

  it("returns null when the caller is not an organization member", async () => {
    const owner = await createTestUser(testDb);
    const outsider = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { workspace } = await workspacesService.createWorkspace({
      organizationId: organization.id,
      userId: outsider.id,
      name: "Hijacked",
    });

    expect(workspace).toBeNull();
  });
});

describe("WorkspacesService.getWorkspaces", () => {
  it("lists workspaces of the caller's organizations with membership context", async () => {
    const owner = await createTestUser(testDb);
    const other = await createTestUser(testDb);
    const own = await createTestOrganization(testDb, owner.id);
    const theirs = await createTestOrganization(testDb, other.id);
    const first = await createTestWorkspace(testDb, own.organization.id, owner.id);
    const second = await createTestWorkspace(testDb, own.organization.id, owner.id);
    await createTestWorkspace(testDb, theirs.organization.id, other.id);

    const { workspaces: list } = await workspacesService.getWorkspaces({
      filters: { userId: owner.id },
    });

    const ownItems = list.filter(
      (item) => item.workspace.organizationId === own.organization.id,
    );
    expect(ownItems).toHaveLength(2);
    expect(ownItems.map((item) => item.workspace.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(ownItems[0]?.member.id).toBe(own.membership.id);
  });
});

describe("WorkspacesService.updateWorkspace", () => {
  it("renames with a regenerated slug and writes the audit diff", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
      { name: "Downtown" },
    );

    const { workspace: updated } = await workspacesService.updateWorkspace({
      id: workspace.id,
      userId: owner.id,
      name: "Harbor",
    });

    expect(updated?.name).toBe("Harbor");
    expect(updated?.slug).toMatch(/^harbor-/);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.workspaceId, workspace.id));
    const updateLogs = logs.filter((log) => log.action === "updated");
    expect(updateLogs).toHaveLength(1);
    expect(updateLogs[0]?.changes).toEqual({
      name: { from: "Downtown", to: "Harbor" },
      slug: { from: workspace.slug, to: updated?.slug },
    });
  });
});
