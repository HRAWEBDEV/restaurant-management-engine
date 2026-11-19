import { eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { OrganizationsService } from "../organizationsService";

const organizationsService = new OrganizationsService(testDb);

describe("OrganizationsService.getOrganizations", () => {
  it("returns only the caller's organizations when filtered by userId", async () => {
    const first = await createTestUser(testDb);
    const other = await createTestUser(testDb);
    const ownA = await createTestOrganization(testDb, first.id);
    const ownB = await createTestOrganization(testDb, first.id);
    await createTestOrganization(testDb, other.id);

    const { organizations: list } = await organizationsService.getOrganizations(
      { filters: { userId: first.id } },
    );

    const ownIds = [ownA.organization.id, ownB.organization.id].sort();
    expect(
      list
        .map((organization) => organization.id)
        .filter((id) => ownIds.includes(id))
        .sort(),
    ).toEqual(ownIds);
  });
});

describe("OrganizationsService.getOrganizationById", () => {
  it("returns the organization and membership for members, nulls for non-members", async () => {
    const owner = await createTestUser(testDb);
    const outsider = await createTestUser(testDb);
    const { organization, membership } = await createTestOrganization(
      testDb,
      owner.id,
    );

    const memberView = await organizationsService.getOrganizationById({
      id: organization.id,
      userId: owner.id,
    });
    expect(memberView.organization?.id).toBe(organization.id);
    expect(memberView.membership?.id).toBe(membership.id);

    const outsiderView = await organizationsService.getOrganizationById({
      id: organization.id,
      userId: outsider.id,
    });
    expect(outsiderView.organization).toBeNull();
    expect(outsiderView.membership).toBeNull();
  });
});

describe("OrganizationsService.updateOrganization", () => {
  it("updates fields, regenerates the slug on rename, and writes the audit diff", async () => {
    const owner = await createTestUser(testDb, { name: "Hamid" });
    const { organization } = await createTestOrganization(testDb, owner.id, {
      name: "Blue Fig",
    });

    const { organization: updated } =
      await organizationsService.updateOrganization({
        id: organization.id,
        userId: owner.id,
        name: "Red Fig",
        description: "Updated",
      });

    expect(updated?.name).toBe("Red Fig");
    expect(updated?.description).toBe("Updated");
    expect(updated?.slug).toMatch(/^red-fig-/);
    expect(updated?.slug).not.toBe(organization.slug);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, organization.id));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "updated",
      entityType: "organization",
      actorLabel: "Hamid",
      organizationId: organization.id,
    });
    expect(logs[0]?.changes).toEqual({
      name: { from: "Blue Fig", to: "Red Fig" },
      description: { from: null, to: "Updated" },
      slug: { from: organization.slug, to: updated?.slug },
    });
  });

  it("returns null when the caller is not a member", async () => {
    const owner = await createTestUser(testDb);
    const outsider = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, owner.id);

    const { organization: result } =
      await organizationsService.updateOrganization({
        id: organization.id,
        userId: outsider.id,
        name: "Hijacked",
      });

    expect(result).toBeNull();
  });
});
