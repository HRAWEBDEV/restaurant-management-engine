import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { organizationMembers } from "../../db/schemas/organizationMembers";
import { OrganizationMembersService } from "../organizationMembersService";

const membersService = new OrganizationMembersService(testDb);

describe("OrganizationMembersService.getOrganizationMembers", () => {
  it("lists members oldest join first with their user and addedByUser", async () => {
    const owner = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );
    const member = await createTestUser(testDb);
    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: member.id,
      role: "member",
      addedBy: owner.id,
    });

    const { members } = await membersService.getOrganizationMembers({
      filters: { organizationId: organization.id },
    });

    expect(members).toHaveLength(2);
    expect(members[0]?.member.id).toBe(membership.id);
    expect(members[0]?.user.id).toBe(owner.id);
    expect(members[0]?.addedByUser?.id).toBe(owner.id);
    expect(members[1]?.user.id).toBe(member.id);
    expect(members[1]?.addedByUser?.id).toBe(owner.id);
  });

  it("filters by role", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { members } = await membersService.getOrganizationMembers({
      filters: { organizationId: organization.id, role: "owner" },
    });

    expect(members).toHaveLength(1);
    expect(members[0]?.member.role).toBe("owner");
  });
});

describe("OrganizationMembersService.getOrganizationMemberById", () => {
  it("returns the membership scoped to its organization", async () => {
    const owner = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );

    const { member } = await membersService.getOrganizationMemberById({
      id: membership.id,
      organizationId: organization.id,
    });

    expect(member).toMatchObject({
      id: membership.id,
      organizationId: organization.id,
      userId: owner.id,
      role: "owner",
    });
  });

  it("returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { member } = await membersService.getOrganizationMemberById({
      id: randomUUID(),
      organizationId: organization.id,
    });

    expect(member).toBeNull();
  });

  it("reports a membership from another organization as missing", async () => {
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { membership } = await createTestOrganization(testDb, ownerA.id);
    const { organization: organizationB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );

    const { member } = await membersService.getOrganizationMemberById({
      id: membership.id,
      organizationId: organizationB.id,
    });

    expect(member).toBeNull();
  });
});

describe("OrganizationMembersService.updateOrganizationRole", () => {
  it("updates the role and returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );

    const { member } = await membersService.updateOrganizationRole({
      id: membership.id,
      organizationId: organization.id,
      role: "admin",
      actorUserId: owner.id,
    });
    expect(member).toMatchObject({ id: membership.id, role: "admin" });

    const { member: missing } = await membersService.updateOrganizationRole({
      id: randomUUID(),
      organizationId: organization.id,
      role: "member",
      actorUserId: owner.id,
    });
    expect(missing).toBeNull();
  });

  it("reports a membership from another organization as missing", async () => {
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { membership } = await createTestOrganization(testDb, ownerA.id);
    const { organization: organizationB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );

    const { member } = await membersService.updateOrganizationRole({
      id: membership.id,
      organizationId: organizationB.id,
      role: "admin",
      actorUserId: ownerB.id,
    });

    expect(member).toBeNull();
  });

  it("writes an organization_member.updated activity row with the role diff", async () => {
    const owner = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );

    await membersService.updateOrganizationRole({
      id: membership.id,
      organizationId: organization.id,
      role: "admin",
      actorUserId: owner.id,
    });

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, membership.id));

    expect(log).toMatchObject({
      organizationId: organization.id,
      actorUserId: owner.id,
      action: "updated",
      entityType: "organization_member",
      entityId: membership.id,
      changes: { role: { from: "owner", to: "admin" } },
    });
  });

  it("rolls the audit row back together with the membership update", async () => {
    const owner = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );

    await expect(
      testDb.transaction(async (tx) => {
        const { member } = await new OrganizationMembersService(
          tx,
        ).updateOrganizationRole({
          id: membership.id,
          organizationId: organization.id,
          role: "admin",
          actorUserId: owner.id,
        });
        expect(member).not.toBeNull();

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const [unchanged] = await testDb
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.id, membership.id));
    expect(unchanged?.role).toBe("owner");

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, membership.id));
    expect(logs).toHaveLength(0);
  });
});

describe("OrganizationMembersService.addOrganizationMember", () => {
  it("inserts a membership defaulting to plain member with a null addedBy", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const member = await createTestUser(testDb);

    const { member: inserted } = await membersService.addOrganizationMember({
      organizationId: organization.id,
      userId: member.id,
    });

    expect(inserted.organizationId).toBe(organization.id);
    expect(inserted.userId).toBe(member.id);
    expect(inserted.role).toBe("member");
    expect(inserted.addedBy).toBeNull();

    const { members } = await membersService.getOrganizationMembers({
      filters: { organizationId: organization.id, userId: member.id },
    });

    expect(members).toHaveLength(1);
  });

  it("stores an explicit role and addedBy", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const member = await createTestUser(testDb);

    const { member: inserted } = await membersService.addOrganizationMember({
      organizationId: organization.id,
      userId: member.id,
      role: "admin",
      addedBy: owner.id,
    });

    expect(inserted.role).toBe("admin");
    expect(inserted.addedBy).toBe(owner.id);
  });

  it("raises ConflictError when the user is already a member", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    await expect(
      membersService.addOrganizationMember({
        organizationId: organization.id,
        userId: owner.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });

    const member = await createTestUser(testDb);
    await membersService.addOrganizationMember({
      organizationId: organization.id,
      userId: member.id,
    });

    await expect(
      membersService.addOrganizationMember({
        organizationId: organization.id,
        userId: member.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("runs on the caller's executor so a rollback undoes the insert", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const member = await createTestUser(testDb);

    await expect(
      testDb.transaction(async (tx) => {
        await new OrganizationMembersService(tx).addOrganizationMember({
          organizationId: organization.id,
          userId: member.id,
        });

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const { members } = await membersService.getOrganizationMembers({
      filters: { organizationId: organization.id, userId: member.id },
    });

    expect(members).toHaveLength(0);
  });
});

describe("OrganizationMembersService.removeOrganizationMember", () => {
  it("deletes the membership and returns the removed row", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
      addedBy: owner.id,
    });

    const { member } = await membersService.removeOrganizationMember({
      id: membership.id,
      organizationId: organization.id,
      actorUserId: owner.id,
    });

    expect(member).toMatchObject({
      id: membership.id,
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });

    const { member: gone } = await membersService.getOrganizationMemberById({
      id: membership.id,
      organizationId: organization.id,
    });
    expect(gone).toBeNull();
  });

  it("returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { member } = await membersService.removeOrganizationMember({
      id: randomUUID(),
      organizationId: organization.id,
      actorUserId: owner.id,
    });

    expect(member).toBeNull();
  });

  it("reports a membership from another organization as missing", async () => {
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      ownerA.id,
    );
    const { organization: organizationB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );

    const { member } = await membersService.removeOrganizationMember({
      id: membership.id,
      organizationId: organizationB.id,
      actorUserId: ownerB.id,
    });

    expect(member).toBeNull();

    const { member: untouched } = await membersService.getOrganizationMemberById(
      {
        id: membership.id,
        organizationId: organization.id,
      },
    );
    expect(untouched).not.toBeNull();
  });

  it("writes an organization_member.deleted activity row with the role diff", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "admin",
      addedBy: owner.id,
    });

    await membersService.removeOrganizationMember({
      id: membership.id,
      organizationId: organization.id,
      actorUserId: owner.id,
    });

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, membership.id));

    expect(log).toMatchObject({
      organizationId: organization.id,
      actorUserId: owner.id,
      action: "deleted",
      entityType: "organization_member",
      entityId: membership.id,
      changes: { role: { from: "admin", to: null } },
    });
  });

  it("rolls the audit row back together with the membership delete", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const memberUser = await createTestUser(testDb);
    const membership = await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: memberUser.id,
      role: "member",
    });

    await expect(
      testDb.transaction(async (tx) => {
        const { member } = await new OrganizationMembersService(
          tx,
        ).removeOrganizationMember({
          id: membership.id,
          organizationId: organization.id,
          actorUserId: owner.id,
        });
        expect(member).not.toBeNull();

        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const [stillThere] = await testDb
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.id, membership.id));
    expect(stillThere?.id).toBe(membership.id);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, membership.id));
    expect(logs).toHaveLength(0);
  });
});
