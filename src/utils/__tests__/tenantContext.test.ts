import { describe, expect, it } from "bun:test";
import { tenantHeadersSchema } from "../tenantContext";

// route contracts reuse this for the OpenAPI document: both tenant headers
// must appear as required uuid parameters for workspace-scoped routes
describe("tenantHeadersSchema", () => {
  it("accepts both tenant headers as uuids", () => {
    const result = tenantHeadersSchema.safeParse({
      "x-organization-id": "9b3a1f6e-0000-4000-8000-000000000001",
      "x-workspace-id": "9b3a1f6e-0000-4000-8000-000000000002",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a missing workspace header", () => {
    const result = tenantHeadersSchema.safeParse({
      "x-organization-id": "9b3a1f6e-0000-4000-8000-000000000001",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a malformed organization header", () => {
    const result = tenantHeadersSchema.safeParse({
      "x-organization-id": "not-a-uuid",
      "x-workspace-id": "9b3a1f6e-0000-4000-8000-000000000002",
    });

    expect(result.success).toBe(false);
  });
});
