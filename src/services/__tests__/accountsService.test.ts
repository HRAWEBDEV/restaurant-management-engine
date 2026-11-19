import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import { createTestUser } from "../../db/__tests__/helpers/factories";
import { organizationMembers } from "../../db/schemas/organizationMembers";
import { workspaceMembers } from "../../db/schemas/workspaceMembers";
import { AccountsService } from "../accountsService";

const accountsService = new AccountsService(testDb);

describe("AccountsService.create", () => {
  it("creates the organization with the caller as its owner", async () => {
    const created = await createTestUser(testDb);

    const { organization } = await accountsService.create({
      userId: created.id,
      organization: { name: "Acme Restaurant" },
    });

    expect(organization.name).toBe("Acme Restaurant");
    expect(organization.slug).toMatch(/^acme-restaurant-/);
    expect(organization.description).toBeNull();

    const memberships = await testDb
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organization.id));

    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      userId: created.id,
      role: "owner",
      addedBy: created.id,
    });
  });

  it("creates a default workspace named after the organization with the caller as workspace admin", async () => {
    const created = await createTestUser(testDb);

    const { organization, workspace } = await accountsService.create({
      userId: created.id,
      organization: { name: "Acme Restaurant" },
    });

    expect(workspace.name).toBe(organization.name);
    expect(workspace.organizationId).toBe(organization.id);
    expect(workspace.createdBy).toBe(created.id);

    const [membership] = await testDb
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organization.id),
          eq(organizationMembers.userId, created.id),
        ),
      );

    const workspaceMemberships = await testDb
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));

    expect(workspaceMemberships).toHaveLength(1);
    expect(workspaceMemberships[0]).toMatchObject({
      workspaceId: workspace.id,
      organizationMemberId: membership?.id,
      role: "admin",
      addedBy: created.id,
    });
  });

  it("honors an explicit workspace name and description", async () => {
    const created = await createTestUser(testDb);

    const { workspace } = await accountsService.create({
      userId: created.id,
      organization: { name: "Acme Restaurant" },
      workspace: { name: "Downtown", description: "First location" },
    });

    expect(workspace.name).toBe("Downtown");
    expect(workspace.description).toBe("First location");
    expect(workspace.slug).toMatch(/^downtown-/);
  });
});
