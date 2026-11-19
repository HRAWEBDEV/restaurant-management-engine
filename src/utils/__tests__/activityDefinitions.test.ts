import { describe, expect, it } from "bun:test";
import type { Organization } from "../../db/schemas/organizations";
import type { Workspace } from "../../db/schemas/workspaces";
import {
  organizationActivity,
  workspaceActivity,
} from "../activityDefinitions";
import { renderSummary } from "../activityLoggerHelpers";

const actor = { userId: "user_1", label: "Hamid" };

describe("activityDefinitions", () => {
  it("summarizes create and update with the current name", () => {
    expect(
      renderSummary(organizationActivity, {
        action: "created",
        actor,
        after: { name: "Acme" } as Organization,
      }),
    ).toBe('Hamid created organization "Acme"');

    expect(
      renderSummary(organizationActivity, {
        action: "updated",
        actor,
        before: { name: "Old Name" } as Organization,
        after: { name: "Acme" } as Organization,
      }),
    ).toBe('Hamid updated organization "Acme"');
  });

  it("summarizes delete with the name of the removed record", () => {
    expect(
      renderSummary(organizationActivity, {
        action: "deleted",
        actor,
        before: { name: "Acme" } as Organization,
      }),
    ).toBe('Hamid deleted organization "Acme"');
  });

  it("summarizes workspace activity the same way", () => {
    expect(
      renderSummary(workspaceActivity, {
        action: "created",
        actor,
        after: { name: "Main" } as Workspace,
      }),
    ).toBe('Hamid created workspace "Main"');
  });
});
