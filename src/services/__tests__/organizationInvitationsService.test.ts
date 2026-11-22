import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
import { organizationInvitations } from "../../db/schemas/organizationInvitations";
import { activityLogs } from "../../db/schemas/activityLogs";
import { OrganizationInvitationsService } from "../organizationInvitationsService";

const invitationsService = new OrganizationInvitationsService(testDb);

describe("OrganizationInvitationsService.getOrganizationInvitations", () => {
  it("lists invitations newest first with their organization and inviter", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { invitation: first } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: `First@example.com`,
    });
    const { invitation: second } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "second@example.com",
    });

    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { organizationId: organization.id },
    });

    expect(invitations).toHaveLength(2);
    expect(invitations[0]?.invitation.id).toBe(second.id);
    expect(invitations[0]?.organization.id).toBe(organization.id);
    expect(invitations[0]?.invitedByUser.id).toBe(owner.id);
    expect(invitations[1]?.invitation.id).toBe(first.id);
  });

  it("filters by status", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "pending@example.com",
    });

    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { organizationId: organization.id, status: "declined" },
    });

    expect(invitations).toHaveLength(0);

    const { invitations: pending } =
      await invitationsService.getOrganizationInvitations({
        filters: { organizationId: organization.id, status: "pending" },
      });

    expect(pending).toHaveLength(1);
  });

  it("expires stale pending rows on read", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const [stale] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "stale@example.com",
        // Pending but already past its expiry window.
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { organizationId: organization.id },
    });

    expect(invitations[0]?.invitation.id).toBe(stale?.id);
    expect(invitations[0]?.invitation.status).toBe("expired");
  });
});

describe("OrganizationInvitationsService.sendInvite", () => {
  it("creates a pending invitation with a normalized email and an audit row", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { invitation } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "  Invitee@Example.COM  ",
    });

    expect(invitation.status).toBe("pending");
    expect(invitation.invitedUserEmail).toBe("invitee@example.com");
    expect(invitation.invitedBy).toBe(owner.id);
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(invitation.acceptedAt).toBeNull();

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, invitation.id));

    expect(log?.entityType).toBe("organization_invitation");
    expect(log?.action).toBe("created");
    expect(log?.summary).toContain("invitee@example.com");
  });

  it("raises ConflictError when the email already belongs to a member", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    await expect(
      invitationsService.sendInvite({
        organizationId: organization.id,
        invitedBy: owner.id,
        // Different casing than the stored email, to verify normalization.
        invitedUserEmail: owner.email.toUpperCase(),
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("raises ConflictError when a live invitation is already pending", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "pending@example.com",
    });

    await expect(
      invitationsService.sendInvite({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "PENDING@example.com",
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("allows re-inviting after the pending invitation expired", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    // A pending invitation already past its expiry, as it would be left by a
    // previous send that was never answered.
    const [stale] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "stale@example.com",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const { invitation } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "stale@example.com",
    });

    expect(invitation.id).not.toBe(stale?.id);

    const [staleRow] = await testDb
      .select()
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.id, stale?.id ?? ""),
          eq(organizationInvitations.status, "expired"),
        ),
      );

    expect(staleRow).toBeDefined();
  });
});
