import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import { createTestUser } from "../../db/__tests__/helpers/factories";
import { UsersService } from "../usersService";

const usersService = new UsersService(testDb);

describe("UsersService.getUserById", () => {
  it("returns the user for an existing id", async () => {
    const created = await createTestUser(testDb);
    const { user: found } = await usersService.getUserById({ id: created.id });
    expect(found).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    const { user: found } = await usersService.getUserById({ id: "user_none" });
    expect(found).toBeNull();
  });
});
