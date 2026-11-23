import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  addOrganizationMember,
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
import { organizationInvitations } from "../../db/schemas/organizationInvitations";
import { activityLogs } from "../../db/schemas/activityLogs";
import {
  getOrganizationInvitationsFiltersSchema,
  OrganizationInvitationsService,
} from "../organizationInvitationsService";
import { OrganizationMembersService } from "../organizationMembersService";

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

  it("lists invitations addressed to the user's email across organizations", async () => {
    const invitee = await createTestUser(testDb);
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { organization: orgA } = await createTestOrganization(
      testDb,
      ownerA.id,
    );
    const { organization: orgB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );

    const inOrgA = await invitationsService.sendInvite({
      organizationId: orgA.id,
      invitedBy: ownerA.id,
      invitedUserEmail: invitee.email,
    });
    await invitationsService.sendInvite({
      organizationId: orgB.id,
      invitedBy: ownerB.id,
      invitedUserEmail: invitee.email,
    });
    // Same organization, addressed to someone else: must not appear.
    await invitationsService.sendInvite({
      organizationId: orgA.id,
      invitedBy: ownerA.id,
      invitedUserEmail: "someone-else@example.com",
    });

    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { userId: invitee.id },
    });

    expect(invitations).toHaveLength(2);
    expect(invitations.map((row) => row.invitation.id)).toContain(
      inOrgA.invitation.id,
    );
    expect(
      new Set(invitations.map((row) => row.organization.id)),
    ).toEqual(new Set([orgA.id, orgB.id]));
  });

  it("narrows to one organization when both organizationId and userId are given", async () => {
    const invitee = await createTestUser(testDb);
    const ownerA = await createTestUser(testDb);
    const ownerB = await createTestUser(testDb);
    const { organization: orgA } = await createTestOrganization(
      testDb,
      ownerA.id,
    );
    const { organization: orgB } = await createTestOrganization(
      testDb,
      ownerB.id,
    );

    await invitationsService.sendInvite({
      organizationId: orgA.id,
      invitedBy: ownerA.id,
      invitedUserEmail: invitee.email,
    });
    await invitationsService.sendInvite({
      organizationId: orgB.id,
      invitedBy: ownerB.id,
      invitedUserEmail: invitee.email,
    });

    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { organizationId: orgA.id, userId: invitee.id },
    });

    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.organization.id).toBe(orgA.id);
  });

  it("returns no invitations for an unknown user", async () => {
    const { invitations } = await invitationsService.getOrganizationInvitations({
      filters: { userId: randomUUID() },
    });

    expect(invitations).toEqual([]);
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

describe("OrganizationInvitationsService.getOrganizationInvitation", () => {
  it("returns the invitation for an id in the organization", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "get-me@example.com",
    });

    const { invitation } = (await invitationsService.getOrganizationInvitation({
      organizationId: organization.id,
      invitationId: sent.id,
    }))!;

    expect(invitation.id).toBe(sent.id);
    expect(invitation.status).toBe("pending");
    expect(invitation.invitedUserEmail).toBe("get-me@example.com");
  });

  it("returns null for an unknown id or an invitation in another organization", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const otherOwner = await createTestUser(testDb);
    const { organization: otherOrganization } = await createTestOrganization(
      testDb,
      otherOwner.id,
    );

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: otherOrganization.id,
      invitedBy: otherOwner.id,
      invitedUserEmail: "elsewhere@example.com",
    });

    expect(
      await invitationsService.getOrganizationInvitation({
        organizationId: organization.id,
        invitationId: sent.id,
      }),
    ).toBeNull();

    expect(
      await invitationsService.getOrganizationInvitation({
        organizationId: organization.id,
        invitationId: randomUUID(),
      }),
    ).toBeNull();
  });

  it("expires a stale pending row on read", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const [stale] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "stale@example.com",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    const staleId = stale?.id ?? randomUUID();

    const { invitation } = (await invitationsService.getOrganizationInvitation({
      organizationId: organization.id,
      invitationId: staleId,
    }))!;

    expect(invitation.id).toBe(staleId);
    expect(invitation.status).toBe("expired");
  });
});

describe("getOrganizationInvitationsFiltersSchema", () => {
  it("requires at least one of organizationId or userId", () => {
    expect(getOrganizationInvitationsFiltersSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      getOrganizationInvitationsFiltersSchema.safeParse({
        organizationId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      getOrganizationInvitationsFiltersSchema.safeParse({ userId: "user_x" })
        .success,
    ).toBe(true);
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

describe("OrganizationInvitationsService.revokeInvite", () => {
  it("revokes a pending invitation and writes a revoked audit row", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "revoke-me@example.com",
    });

    const { invitation } = (await invitationsService.revokeInvite({
      organizationId: organization.id,
      invitationId: sent.id,
      revokedBy: owner.id,
    }))!;

    expect(invitation.id).toBe(sent.id);
    expect(invitation.status).toBe("revoked");

    const [log] = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, invitation.id),
          eq(activityLogs.action, "revoked"),
        ),
      );

    expect(log?.entityType).toBe("organization_invitation");
    expect(log?.summary).toContain("revoke-me@example.com");
    expect(log?.changes).toMatchObject({
      status: { from: "pending", to: "revoked" },
    });
  });

  it("returns null for an invitation outside the organization or unknown", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const otherOwner = await createTestUser(testDb);
    const { organization: otherOrganization } = await createTestOrganization(
      testDb,
      otherOwner.id,
    );

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: otherOrganization.id,
      invitedBy: otherOwner.id,
      invitedUserEmail: "elsewhere@example.com",
    });

    expect(
      await invitationsService.revokeInvite({
        organizationId: organization.id,
        invitationId: sent.id,
        revokedBy: owner.id,
      }),
    ).toBeNull();

    expect(
      await invitationsService.revokeInvite({
        organizationId: organization.id,
        invitationId: randomUUID(),
        revokedBy: owner.id,
      }),
    ).toBeNull();
  });

  it("raises ConflictError when the invitation is not pending", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const [declined] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "declined@example.com",
        status: "declined",
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning();

    await expect(
      invitationsService.revokeInvite({
        organizationId: organization.id,
        invitationId: declined?.id ?? randomUUID(),
        revokedBy: owner.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("raises ConflictError for a stale pending invitation instead of revoking it", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const [stale] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: "stale@example.com",
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    await expect(
      invitationsService.revokeInvite({
        organizationId: organization.id,
        invitationId: stale?.id ?? randomUUID(),
        revokedBy: owner.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("frees the email for a new pending invitation after revoking", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "re-invite@example.com",
    });

    await invitationsService.revokeInvite({
      organizationId: organization.id,
      invitationId: sent.id,
      revokedBy: owner.id,
    });

    const { invitation: resent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "re-invite@example.com",
    });

    expect(resent.status).toBe("pending");
    expect(resent.id).not.toBe(sent.id);
  });
});

describe("OrganizationInvitationsService.acceptInvite", () => {
  it("accepts a pending invitation, creates a member, and writes audit rows", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const invitee = await createTestUser(testDb);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: invitee.email,
    });

    const { invitation, member } = (await invitationsService.acceptInvite({
      organizationId: organization.id,
      invitationId: sent.id,
      acceptedBy: invitee.id,
    }))!;

    expect(invitation.id).toBe(sent.id);
    expect(invitation.status).toBe("accepted");
    expect(invitation.acceptedAt?.getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );

    expect(member.organizationId).toBe(organization.id);
    expect(member.userId).toBe(invitee.id);
    expect(member.role).toBe("member");
    expect(member.addedBy).toBe(owner.id);

    const [acceptedLog] = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, invitation.id),
          eq(activityLogs.action, "accepted"),
        ),
      );

    expect(acceptedLog?.entityType).toBe("organization_invitation");
    expect(acceptedLog?.actorUserId).toBe(invitee.id);
    expect(acceptedLog?.changes).toMatchObject({
      status: { from: "pending", to: "accepted" },
    });

    const [memberLog] = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, member.id),
          eq(activityLogs.action, "created"),
        ),
      );

    expect(memberLog?.entityType).toBe("organization_member");
    expect(memberLog?.changes).toMatchObject({
      role: { from: null, to: "member" },
    });
  });

  it("matches the invitee email case-insensitively", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const invitee = await createTestUser(testDb);

    // Sent with different casing than the stored account email; acceptance
    // must still match.
    const [sent] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: invitee.email.toUpperCase(),
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning();

    const { invitation } = (await invitationsService.acceptInvite({
      organizationId: organization.id,
      invitationId: sent?.id ?? randomUUID(),
      acceptedBy: invitee.id,
    }))!;

    expect(invitation.status).toBe("accepted");
  });

  it("raises ForbiddenError when the invitation is addressed to another email", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const someoneElse = await createTestUser(testDb);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: "addressed@example.com",
    });

    await expect(
      invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: sent.id,
        acceptedBy: someoneElse.id,
      }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });

    const [unchanged] = await testDb
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, sent.id));

    expect(unchanged?.status).toBe("pending");
    expect(unchanged?.acceptedAt).toBeNull();
  });

  it("returns null for an invitation outside the organization or unknown", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const otherOwner = await createTestUser(testDb);
    const { organization: otherOrganization } = await createTestOrganization(
      testDb,
      otherOwner.id,
    );
    const invitee = await createTestUser(testDb);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: otherOrganization.id,
      invitedBy: otherOwner.id,
      invitedUserEmail: invitee.email,
    });

    expect(
      await invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: sent.id,
        acceptedBy: invitee.id,
      }),
    ).toBeNull();

    expect(
      await invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: randomUUID(),
        acceptedBy: invitee.id,
      }),
    ).toBeNull();
  });

  it("raises ConflictError when the invitation is not pending anymore", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const invitee = await createTestUser(testDb);

    const { invitation: sent } = await invitationsService.sendInvite({
      organizationId: organization.id,
      invitedBy: owner.id,
      invitedUserEmail: invitee.email,
    });

    await invitationsService.revokeInvite({
      organizationId: organization.id,
      invitationId: sent.id,
      revokedBy: owner.id,
    });

    await expect(
      invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: sent.id,
        acceptedBy: invitee.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("raises ConflictError for a stale pending invitation instead of accepting it", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const invitee = await createTestUser(testDb);

    const [stale] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: invitee.email,
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning();

    await expect(
      invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: stale?.id ?? randomUUID(),
        acceptedBy: invitee.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });
  });

  it("raises ConflictError when the invitee is already a member and keeps the invitation pending", async () => {
    const owner = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);
    const invitee = await createTestUser(testDb);

    await addOrganizationMember(testDb, {
      organizationId: organization.id,
      userId: invitee.id,
    });

    const [pending] = await testDb
      .insert(organizationInvitations)
      .values({
        organizationId: organization.id,
        invitedBy: owner.id,
        invitedUserEmail: invitee.email,
        expiresAt: new Date(Date.now() + 1000),
      })
      .returning();

    await expect(
      invitationsService.acceptInvite({
        organizationId: organization.id,
        invitationId: pending?.id ?? randomUUID(),
        acceptedBy: invitee.id,
      }),
    ).rejects.toMatchObject({ name: "ConflictError" });

    // The acceptance must roll back whole: no member row, invitation untouched.
    const [invitation] = await testDb
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, pending?.id ?? randomUUID()));

    expect(invitation?.status).toBe("pending");
    expect(invitation?.acceptedAt).toBeNull();

    const { members } = await new OrganizationMembersService(
      testDb,
    ).getOrganizationMembers({
      filters: { organizationId: organization.id, userId: invitee.id },
    });

    // Only the pre-existing membership; the failed acceptance added none.
    expect(members).toHaveLength(1);
  });
});
