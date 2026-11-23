import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  addWorkspaceMember,
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { workspaceMembers } from "../../db/schemas/workspaceMembers";
import { WorkspaceMembersService } from "../workspaceMembersService";

const membersService = new WorkspaceMembersService(testDb);

describe("WorkspaceMembersService.getWorkspaceMembers", () => {
  it("lists members oldest join first with their workspace, organization, user, and addedByUser", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
      addedBy: owner.id,
    });
    await membersService.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: memberUser.id,
      addedBy: owner.id,
    });

    const { members } = await membersService.getWorkspaceMembers({
      filters: { workspaceId: workspace.id },
    });

    expect(members).toHaveLength(2);
    expect(members[0]?.member.workspaceId).toBe(workspace.id);
    expect(members[0]?.member.role).toBe("admin");
    expect(members[0]?.user.id).toBe(owner.id);
    expect(members[0]?.organization.id).toBe(organization.id);
    expect(members[0]?.addedByUser?.id).toBe(owner.id);
    expect(members[1]?.user.id).toBe(memberUser.id);
    expect(members[1]?.member.role).toBe("member");
    expect(members[1]?.addedByUser?.id).toBe(owner.id);
  });

  it("filters by role and by user", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const byRole = await membersService.getWorkspaceMembers({
      filters: { workspaceId: workspace.id, role: "admin" },
    });
    expect(byRole.members).toHaveLength(1);
    expect(byRole.members[0]?.user.id).toBe(owner.id);

    const byUser = await membersService.getWorkspaceMembers({
      filters: { workspaceId: workspace.id, userId: memberUser.id },
    });
    expect(byUser.members).toHaveLength(1);
    expect(byUser.members[0]?.user.id).toBe(memberUser.id);
  });
});

describe("WorkspaceMembersService.getWorkspaceMemberById", () => {
  it("returns the membership scoped to its workspace", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));

    const { member } = await membersService.getWorkspaceMemberById({
      id: membership?.id as string,
      workspaceId: workspace.id,
    });

    expect(member).toMatchObject({
      id: membership?.id,
      workspaceId: workspace.id,
      organizationId: organization.id,
      role: "admin",
    });
  });

  it("returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );

    const { member } = await membersService.getWorkspaceMemberById({
      id: randomUUID(),
      workspaceId: workspace.id,
    });

    expect(member).toBeNull();
  });

  it("reports a membership from another workspace as missing", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspaceA = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const workspaceB = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceA.id));

    const { member } = await membersService.getWorkspaceMemberById({
      id: membership?.id as string,
      workspaceId: workspaceB.id,
    });

    expect(member).toBeNull();
  });
});

describe("WorkspaceMembersService.updateWorkspaceRole", () => {
  it("updates the role and returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    const { member } = await membersService.updateWorkspaceRole({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
      role: "admin",
      actorUserId: owner.id,
    });
    expect(member).toMatchObject({ id: workspaceMembership.id, role: "admin" });

    const { member: missing } = await membersService.updateWorkspaceRole({
      id: randomUUID(),
      workspaceId: workspace.id,
      role: "member",
      actorUserId: owner.id,
    });
    expect(missing).toBeNull();
  });

  it("reports a membership from another workspace as missing", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspaceA = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const workspaceB = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceA.id));

    const { member } = await membersService.updateWorkspaceRole({
      id: membership?.id as string,
      workspaceId: workspaceB.id,
      role: "member",
      actorUserId: owner.id,
    });

    expect(member).toBeNull();
  });

  it("writes a workspace_member.updated activity row with the role diff", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    await membersService.updateWorkspaceRole({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
      role: "admin",
      actorUserId: owner.id,
    });

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, workspaceMembership.id));

    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      action: "updated",
      entityType: "workspace_member",
      entityId: workspaceMembership.id,
      changes: { role: { from: "member", to: "admin" } },
    });
  });

  it("rolls the audit row back together with the membership update", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));

    await expect(
      testDb.transaction(async (tx) => {
        const { member } = await new WorkspaceMembersService(
          tx,
        ).updateWorkspaceRole({
          id: membership?.id as string,
          workspaceId: workspace.id,
          role: "member",
          actorUserId: owner.id,
        });
        expect(member).not.toBeNull();

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const [unchanged] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, membership?.id as string));
    expect(unchanged?.role).toBe("admin");

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, membership?.id as string));
    expect(logs).toHaveLength(0);
  });
});

describe("WorkspaceMembersService.addWorkspaceMember", () => {
  it("inserts a membership defaulting to plain member with a null addedBy", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });

    const { member } = await membersService.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: memberUser.id,
    });

    expect(member).not.toBeNull();
    expect(member?.workspaceId).toBe(workspace.id);
    expect(member?.organizationId).toBe(organization.id);
    expect(member?.role).toBe("member");
    expect(member?.addedBy).toBeNull();

    const { members } = await membersService.getWorkspaceMembers({
      filters: { workspaceId: workspace.id, userId: memberUser.id },
    });
    expect(members).toHaveLength(1);
  });

  it("stores an explicit role and addedBy", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });

    const { member } = await membersService.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: memberUser.id,
      role: "admin",
      addedBy: owner.id,
    });

    expect(member?.role).toBe("admin");
    expect(member?.addedBy).toBe(owner.id);
  });

  it("returns null when the user is not a member of the workspace's organization", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const outsider = await createTestUser(testDb);

    const { member } = await membersService.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: outsider.id,
    });

    expect(member).toBeNull();
  });

  it("returns null for unknown workspaces", async () => {
    const memberUser = await createTestUser(testDb);

    const { member } = await membersService.addWorkspaceMember({
      workspaceId: randomUUID(),
      userId: memberUser.id,
    });

    expect(member).toBeNull();
  });

  it("raises ConflictError when the user is already a workspace member", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );

    // The creator became a workspace member on create.
    await expect(
      membersService.addWorkspaceMember({
        workspaceId: workspace.id,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });

    const memberUser = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    await membersService.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: memberUser.id,
    });

    await expect(
      membersService.addWorkspaceMember({
        workspaceId: workspace.id,
        userId: memberUser.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("runs on the caller's executor so a rollback undoes the insert", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });

    await expect(
      testDb.transaction(async (tx) => {
        await new WorkspaceMembersService(tx).addWorkspaceMember({
          workspaceId: workspace.id,
          userId: memberUser.id,
        });

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const { members } = await membersService.getWorkspaceMembers({
      filters: { workspaceId: workspace.id, userId: memberUser.id },
    });

    expect(members).toHaveLength(0);
  });
});

describe("WorkspaceMembersService.removeWorkspaceMember", () => {
  it("deletes the membership and returns the removed row", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
      addedBy: owner.id,
    });

    const { member } = await membersService.removeWorkspaceMember({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(member).toMatchObject({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
      organizationId: organization.id,
      role: "member",
    });

    const { member: gone } = await membersService.getWorkspaceMemberById({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
    });
    expect(gone).toBeNull();
  });

  it("returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );

    const { member } = await membersService.removeWorkspaceMember({
      id: randomUUID(),
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    expect(member).toBeNull();
  });

  it("reports a membership from another workspace as missing", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspaceA = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const workspaceB = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const [membership] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceA.id));

    const { member } = await membersService.removeWorkspaceMember({
      id: membership?.id as string,
      workspaceId: workspaceB.id,
      actorUserId: owner.id,
    });

    expect(member).toBeNull();

    const { member: untouched } =
      await membersService.getWorkspaceMemberById({
        id: membership?.id as string,
        workspaceId: workspaceA.id,
      });
    expect(untouched).not.toBeNull();
  });

  it("writes a workspace_member.deleted activity row with the role diff", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "admin",
    });

    await membersService.removeWorkspaceMember({
      id: workspaceMembership.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, workspaceMembership.id));

    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      action: "deleted",
      entityType: "workspace_member",
      entityId: workspaceMembership.id,
      changes: { role: { from: "admin", to: null } },
    });
  });

  it("rolls the audit row back together with the membership delete", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const workspace = await createTestWorkspace(
      testDb,
      organization.id,
      owner.id,
    );
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });
    const workspaceMembership = await addWorkspaceMember(testDb, {
      workspaceId: workspace.id,
      organizationMemberId: membership.id,
      organizationId: organization.id,
      role: "member",
    });

    await expect(
      testDb.transaction(async (tx) => {
        const { member } = await new WorkspaceMembersService(
          tx,
        ).removeWorkspaceMember({
          id: workspaceMembership.id,
          workspaceId: workspace.id,
          actorUserId: owner.id,
        });
        expect(member).not.toBeNull();

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const [stillThere] = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, workspaceMembership.id));
    expect(stillThere?.id).toBe(workspaceMembership.id);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, workspaceMembership.id));
    expect(logs).toHaveLength(0);
  });
});
