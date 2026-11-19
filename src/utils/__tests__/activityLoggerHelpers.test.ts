import { describe, expect, it } from "bun:test";
import {
  assertAllowedAction,
  buildChanges,
  defineActivity,
  renderSummary,
} from "../activityLoggerHelpers";

type OrganizationRow = {
  name: string;
  slug: string;
  createdAt: Date;
};

const before: OrganizationRow = {
  name: "Old Name",
  slug: "old-name",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("buildChanges", () => {
  it("captures changed fields with from/to and drops unchanged ones", () => {
    expect(
      buildChanges(before, { ...before, name: "New Name" }, ["name", "slug"]),
    ).toEqual({ name: { from: "Old Name", to: "New Name" } });
  });

  it("uses null for the missing side", () => {
    // create: nothing existed before
    expect(buildChanges(null, before, ["name", "slug"])).toEqual({
      name: { from: null, to: "Old Name" },
      slug: { from: null, to: "old-name" },
    });

    // delete: nothing exists after
    expect(buildChanges(before, null, ["slug"])).toEqual({
      slug: { from: "old-name", to: null },
    });
  });

  it("returns null when nothing changed", () => {
    expect(buildChanges(before, before, ["name", "slug"])).toBeNull();

    // equal timestamps are unchanged even as distinct Date instances,
    // since every row carries fresh created_at/updated_at Date objects
    const after = { ...before, createdAt: new Date("2026-01-01T00:00:00.000Z") };
    expect(buildChanges(before, after, ["createdAt"])).toBeNull();
  });

  it("returns null without an allowlist of fields", () => {
    expect(
      buildChanges(before, { ...before, name: "New Name" }, undefined),
    ).toBeNull();
    expect(buildChanges(before, { ...before, name: "New Name" }, [])).toBeNull();
  });
});

type WorkspaceRow = { name: string };

const workspaceDefinition = defineActivity<WorkspaceRow>()({
  entityType: "workspace",
  actions: ["create", "update", "delete"] as const,
  summarize: ({ action, actor, before, after }) =>
    `${actor} renamed workspace from "${before?.name}" to "${after?.name}" via ${action}`,
});

describe("renderSummary", () => {
  it("uses the definition's summarize with the actor label and before/after", () => {
    expect(
      renderSummary(workspaceDefinition, {
        action: "update",
        actor: { userId: "user_1", label: "Hamid" },
        before: { name: "Main" },
        after: { name: "Downtown" },
      }),
    ).toBe('Hamid renamed workspace from "Main" to "Downtown" via update');
  });

  it("falls back to \"actor action entityType\" without a summarize", () => {
    const definition = defineActivity<WorkspaceRow>()({
      entityType: "workspace",
      actions: ["create"] as const,
    });

    expect(
      renderSummary(definition, {
        action: "create",
        actor: { userId: null, label: "system" },
      }),
    ).toBe("system create workspace");
  });
});

describe("assertAllowedAction", () => {
  it("passes actions listed in the definition", () => {
    expect(() =>
      assertAllowedAction(workspaceDefinition, "create"),
    ).not.toThrow();
  });

  it("throws for actions not listed in the definition", () => {
    const unlistedAction = "restore" as "create";
    expect(() =>
      assertAllowedAction(workspaceDefinition, unlistedAction),
    ).toThrow('activity action "restore" is not defined for "workspace"');
  });
});
