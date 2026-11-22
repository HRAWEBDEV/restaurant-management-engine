import { describe, expect, it } from "bun:test";
import { testDb } from "../../db/__tests__/helpers/db";
import { createTestUser } from "../../db/__tests__/helpers/factories";
import { ConflictError } from "../../utils/ConflictError";
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

describe("UsersService.updateUserInfo", () => {
  it("updates the given fields and keeps others untouched", async () => {
    const created = await createTestUser(testDb);

    const { user: updated } = await usersService.updateUserInfo({
      id: created.id,
      name: "Renamed User",
      firstName: "Renamed",
      lastName: "User",
    });

    expect(updated?.name).toBe("Renamed User");
    expect(updated?.firstName).toBe("Renamed");
    expect(updated?.lastName).toBe("User");
    expect(updated?.email).toBe(created.email);
    expect(updated?.username).toBe(created.username);
  });

  it("stores usernames lowercase and keeps typed casing in displayUsername", async () => {
    const created = await createTestUser(testDb);

    const { user: updated } = await usersService.updateUserInfo({
      id: created.id,
      username: "Fresh.Name",
    });

    expect(updated?.username).toBe("fresh.name");
    expect(updated?.displayUsername).toBe("Fresh.Name");
  });

  it("returns the current row when no field differs", async () => {
    const created = await createTestUser(testDb);

    const { user: result } = await usersService.updateUserInfo({
      id: created.id,
      name: created.name,
      ...(created.username ? { username: created.username } : {}),
    });

    expect(result).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    const { user: result } = await usersService.updateUserInfo({
      id: "user_none",
      name: "Ghost",
    });

    expect(result).toBeNull();
  });

  it("throws ConflictError when the username is taken by another user", async () => {
    const first = await createTestUser(testDb);
    const second = await createTestUser(testDb);

    const conflict = usersService.updateUserInfo({
      id: second.id,
      // Same name lowercased; case differences do not bypass uniqueness.
      username: first.username ? first.username.toUpperCase() : undefined,
    });

    expect(conflict).rejects.toBeInstanceOf(ConflictError);
  });
});
