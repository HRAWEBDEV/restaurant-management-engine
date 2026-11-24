import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import {
  createTestOrganization,
  createTestUser,
  createTestWorkspace,
} from "../../db/__tests__/helpers/factories";
import { activityLogs } from "../../db/schemas/activityLogs";
import { taxClasses } from "../../db/schemas/taxClasses";
import { ConflictError } from "../../utils/ConflictError";
import { TaxClassesService } from "../taxClassesService";

const taxClassesService = new TaxClassesService(testDb);

/** Creates a workspace and returns everything the tests need. */
async function createWorkspace() {
  const owner = await createTestUser(testDb, { name: "Hamid" });
  const { organization } = await createTestOrganization(testDb, owner.id);
  const workspace = await createTestWorkspace(testDb, organization.id, owner.id);

  return { owner, organization, workspace };
}

async function createTaxClass(
  workspaceId: string,
  userId: string,
  name: string,
  rate = 825,
) {
  const { taxClass } = await taxClassesService.createTaxClass({
    workspaceId,
    userId,
    name,
    rate,
  });

  if (!taxClass) {
    throw new Error(`tax class "${name}" was not created`);
  }

  return taxClass;
}

describe("TaxClassesService.createTaxClass", () => {
  it("creates the class and makes the first class of a workspace the default", async () => {
    const { owner, organization, workspace } = await createWorkspace();

    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, first.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "created",
      entityType: "tax_class",
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
      actorLabel: "Hamid",
    });
  });

  it("promotes a new default and demotes the previous one on the same transaction", async () => {
    const { owner, workspace } = await createWorkspace();
    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const { taxClass: second } = await taxClassesService.createTaxClass({
      workspaceId: workspace.id,
      userId: owner.id,
      name: "VAT 19%",
      rate: 1900,
      isDefault: true,
    });

    if (!second) {
      throw new Error("tax class was not created");
    }

    expect(second.isDefault).toBe(true);

    const [demoted] = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.id, first.id));
    expect(demoted?.isDefault).toBe(false);
  });

  it("raises ConflictError when the name is already used in the workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    expect(
      taxClassesService.createTaxClass({
        workspaceId: workspace.id,
        userId: owner.id,
        name: "VAT 8.25%",
        rate: 825,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same name in another workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const other = await createWorkspace();
    const taxClass = await createTaxClass(
      other.workspace.id,
      other.owner.id,
      "VAT 8.25%",
    );

    expect(taxClass.workspaceId).toBe(other.workspace.id);
  });

  it("returns null when the workspace does not exist", async () => {
    const owner = await createTestUser(testDb);

    const { taxClass } = await taxClassesService.createTaxClass({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      userId: owner.id,
      name: "Nowhere",
      rate: 825,
    });

    expect(taxClass).toBeNull();
  });
});

describe("TaxClassesService.getTaxClasses", () => {
  it("lists the workspace's tax classes oldest first, excluding other workspaces", async () => {
    const { owner, workspace } = await createWorkspace();
    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    const other = await createWorkspace();
    await createTaxClass(other.workspace.id, other.owner.id, "Other");

    const { taxClasses: listed } = await taxClassesService.getTaxClasses({
      filters: { workspaceId: workspace.id },
    });

    expect(listed.map((taxClass) => taxClass.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

describe("TaxClassesService.getTaxClassById", () => {
  it("returns the tax class scoped to the workspace", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const { taxClass } = await taxClassesService.getTaxClassById({
      id: created.id,
      workspaceId: workspace.id,
    });

    expect(taxClass?.id).toBe(created.id);
  });

  it("returns null for another workspace's tax class or an unknown id", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const other = await createWorkspace();

    const foreign = await taxClassesService.getTaxClassById({
      id: created.id,
      workspaceId: other.workspace.id,
    });
    const unknown = await taxClassesService.getTaxClassById({
      id: "00000000-0000-4000-8000-000000000002",
      workspaceId: workspace.id,
    });

    expect(foreign.taxClass).toBeNull();
    expect(unknown.taxClass).toBeNull();
  });
});

describe("TaxClassesService.updateTaxClass", () => {
  it("updates name and rate and writes the audit row", async () => {
    const { owner, organization, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const { taxClass } = await taxClassesService.updateTaxClass({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
      name: "Sales Tax 8.55%",
      rate: 855,
    });

    expect(taxClass).toMatchObject({
      name: "Sales Tax 8.55%",
      rate: 855,
      isDefault: true,
    });

    const createdLog = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, created.id),
          eq(activityLogs.action, "created"),
        ),
      );
    expect(createdLog).toHaveLength(1);

    const updatedLog = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, created.id),
          eq(activityLogs.action, "updated"),
        ),
      );
    expect(updatedLog).toHaveLength(1);
    expect(updatedLog[0]).toMatchObject({
      entityType: "tax_class",
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
  });

  it("promotes the class and demotes the previous default", async () => {
    const { owner, workspace } = await createWorkspace();
    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    const { taxClass } = await taxClassesService.updateTaxClass({
      id: second.id,
      workspaceId: workspace.id,
      userId: owner.id,
      isDefault: true,
    });

    expect(taxClass?.isDefault).toBe(true);

    const [demoted] = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.id, first.id));
    expect(demoted?.isDefault).toBe(false);
  });

  it("raises ConflictError when unsetting the default flag on the default class", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    expect(
      taxClassesService.updateTaxClass({
        id: created.id,
        workspaceId: workspace.id,
        userId: owner.id,
        isDefault: false,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("raises ConflictError when the name is already used by another class", async () => {
    const { owner, workspace } = await createWorkspace();
    await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    expect(
      taxClassesService.updateTaxClass({
        id: second.id,
        workspaceId: workspace.id,
        userId: owner.id,
        name: "VAT 8.25%",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns the row without writing an audit row on a no-change request", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const { taxClass } = await taxClassesService.updateTaxClass({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
      name: "VAT 8.25%",
      rate: 825,
      isDefault: true,
    });

    expect(taxClass?.id).toBe(created.id);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(eq(activityLogs.entityId, created.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe("created");
  });

  it("returns null when the tax class does not exist in this workspace", async () => {
    const { owner, workspace } = await createWorkspace();

    const { taxClass } = await taxClassesService.updateTaxClass({
      id: "00000000-0000-4000-8000-000000000002",
      workspaceId: workspace.id,
      userId: owner.id,
      name: "Nowhere",
    });

    expect(taxClass).toBeNull();
  });
});

describe("TaxClassesService.deleteTaxClass", () => {
  it("hard-deletes the class and writes the audit row", async () => {
    const { owner, organization, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    const { taxClass } = await taxClassesService.deleteTaxClass({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    expect(taxClass?.id).toBe(created.id);

    const [row] = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.id, created.id));
    expect(row).toBeUndefined();

    const createdLog = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, created.id),
          eq(activityLogs.action, "created"),
        ),
      );
    expect(createdLog).toHaveLength(1);

    const deletedLog = await testDb
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityId, created.id),
          eq(activityLogs.action, "deleted"),
        ),
      );
    expect(deletedLog).toHaveLength(1);
    expect(deletedLog[0]).toMatchObject({
      entityType: "tax_class",
      organizationId: organization.id,
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
  });

  it("promotes the oldest remaining class when the default is deleted", async () => {
    const { owner, workspace } = await createWorkspace();
    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    const { taxClass } = await taxClassesService.deleteTaxClass({
      id: first.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    expect(taxClass?.id).toBe(first.id);

    const [promoted] = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.id, second.id));
    expect(promoted?.isDefault).toBe(true);

    const logs = await testDb
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.entityId, second.id), eq(activityLogs.action, "updated")));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.summary).toContain("workspace default");
  });

  it("leaves the workspace without a default when the last class is deleted", async () => {
    const { owner, workspace } = await createWorkspace();
    const created = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");

    await taxClassesService.deleteTaxClass({
      id: created.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    const rows = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.workspaceId, workspace.id));
    expect(rows).toHaveLength(0);
  });

  it("does not change the default when a non-default class is deleted", async () => {
    const { owner, workspace } = await createWorkspace();
    const first = await createTaxClass(workspace.id, owner.id, "VAT 8.25%");
    const second = await createTaxClass(workspace.id, owner.id, "VAT 5%", 500);

    await taxClassesService.deleteTaxClass({
      id: second.id,
      workspaceId: workspace.id,
      userId: owner.id,
    });

    const [kept] = await testDb
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.id, first.id));
    expect(kept?.isDefault).toBe(true);
  });

  it("returns null when the tax class does not exist in this workspace", async () => {
    const { owner, workspace } = await createWorkspace();

    const { taxClass } = await taxClassesService.deleteTaxClass({
      id: "00000000-0000-4000-8000-000000000002",
      workspaceId: workspace.id,
      userId: owner.id,
    });

    expect(taxClass).toBeNull();
  });
});
