import { describe, expect, it } from "bun:test";
import type { CatalogCategory } from "../../db/schemas/catalogCategories";
import type { Organization } from "../../db/schemas/organizations";
import type { WorkspaceMember } from "../../db/schemas/workspaceMembers";
import type { Workspace } from "../../db/schemas/workspaces";
import {
  catalogCategoryActivity,
  organizationActivity,
  workspaceActivity,
  workspaceMemberActivity,
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

  it("summarizes workspace member activity with the membership role", () => {
    expect(
      renderSummary(workspaceMemberActivity, {
        action: "created",
        actor,
        after: { role: "member" } as WorkspaceMember,
      }),
    ).toBe('Hamid created workspace membership as "member"');

    expect(
      renderSummary(workspaceMemberActivity, {
        action: "updated",
        actor,
        before: { role: "member" } as WorkspaceMember,
        after: { role: "admin" } as WorkspaceMember,
      }),
    ).toBe('Hamid updated workspace membership as "admin"');

    expect(
      renderSummary(workspaceMemberActivity, {
        action: "deleted",
        actor,
        before: { role: "admin" } as WorkspaceMember,
      }),
    ).toBe('Hamid deleted workspace membership as "admin"');
  });

  it("summarizes catalog category activity with the category name", () => {
    expect(
      renderSummary(catalogCategoryActivity, {
        action: "created",
        actor,
        after: { name: "Starters" } as CatalogCategory,
      }),
    ).toBe('Hamid created category "Starters"');

    expect(
      renderSummary(catalogCategoryActivity, {
        action: "updated",
        actor,
        before: { name: "Starters" } as CatalogCategory,
        after: { name: "Appetizers" } as CatalogCategory,
      }),
    ).toBe('Hamid updated category "Appetizers"');

    expect(
      renderSummary(catalogCategoryActivity, {
        action: "archived",
        actor,
        before: { name: "Starters" } as CatalogCategory,
      }),
    ).toBe('Hamid archived category "Starters"');
  });
});
