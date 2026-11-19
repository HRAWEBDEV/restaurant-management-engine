import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
} from "../../db/__tests__/helpers/factories";
import { defineActivity } from "../../utils/activityLoggerHelpers";
import { ActivityLogger } from "../activityLoggerService";

const activityLogger = new ActivityLogger(testDb);

describe("ActivityLogger.record", () => {
  it("writes the row with the documented defaults", async () => {
    const actor = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, actor.id);

    const log = await activityLogger.record({
      organizationId: organization.id,
      actorUserId: actor.id,
      actorLabel: "Hamid",
      action: "created",
      entityType: "organization",
      entityId: organization.id,
      summary: 'Hamid created organization "Acme"',
    });

    expect(log).toMatchObject({
      organizationId: organization.id,
      workspaceId: null,
      actorUserId: actor.id,
      actorLabel: "Hamid",
      source: "api",
      action: "created",
      entityType: "organization",
      entityId: organization.id,
      summary: 'Hamid created organization "Acme"',
      changes: null,
      metadata: null,
    });
  });
});

describe("ActivityLogger.recordChange", () => {
  const definition = defineActivity<{
    name: string;
    description: string | null;
  }>()({
    entityType: "organization",
    actions: ["updated"] as const,
    diff: ["name", "description"],
  });

  it("renders the summary and builds the diff from the definition", async () => {
    const actor = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, actor.id);

    const log = await activityLogger.recordChange(definition, {
      organizationId: organization.id,
      actor: { userId: actor.id, label: "Hamid" },
      action: "updated",
      entityId: organization.id,
      before: { name: "Old", description: null },
      after: { name: "New", description: null },
    });

    expect(log.summary).toBe("Hamid updated organization");
    expect(log.changes).toEqual({ name: { from: "Old", to: "New" } });
  });

  it("throws for an action outside the definition", async () => {
    const actor = await createTestUser(testDb);
    const { organization } = await createTestOrganization(testDb, actor.id);
    const unlistedAction = "deleted" as "updated";

    expect(() =>
      activityLogger.recordChange(definition, {
        organizationId: organization.id,
        actor: { userId: actor.id, label: "Hamid" },
        action: unlistedAction,
        entityId: organization.id,
      }),
    ).toThrow('activity action "deleted" is not defined for "organization"');
  });
});
