import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
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

describe("OrganizationMembersService.updateOrganizationRole", () => {
  it("updates the role and returns null for unknown ids", async () => {
    const owner = await createTestUser(testDb);
    const { membership } = await createTestOrganization(testDb, owner.id);

    const { member } = await membersService.updateOrganizationRole({
      id: membership.id,
      role: "admin",
    });
    expect(member).toMatchObject({ id: membership.id, role: "admin" });

    const { member: missing } = await membersService.updateOrganizationRole({
      id: randomUUID(),
      role: "member",
    });
    expect(missing).toBeNull();
  });
});
