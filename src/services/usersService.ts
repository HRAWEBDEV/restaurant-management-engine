import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import {
  selectUserSchema,
  updateUserInfoSchema,
  user,
} from "../../auth-schema";
import type { DBExecutor } from "../db/connect";
import { ConflictError } from "../utils/ConflictError";
import { InternalError } from "../utils/InternalError";

type GetUserByIdProps = {
  id: string;
};

const getUserByIdResponseSchema = z.object({
  user: selectUserSchema.nullable(),
});

type GetUserByIdResponse = z.infer<typeof getUserByIdResponseSchema>;

type UpdateUserInfoInput = z.infer<typeof updateUserInfoSchema>;

type UpdateUserInfoProps = UpdateUserInfoInput & {
  id: string;
};

const updateUserInfoResponseSchema = z.object({
  user: selectUserSchema.nullable(),
});

type UpdateUserInfoResponse = z.infer<typeof updateUserInfoResponseSchema>;

/**
 * Postgres reports unique-constraint violations with SQLSTATE 23505. Drizzle
 * wraps driver errors in `DrizzleQueryError`, so the `errno` may sit on the
 * error itself or on its `cause`.
 */
function isUniqueViolation(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("errno" in error) {
    return error.errno === "23505";
  }

  const cause = "cause" in error ? error.cause : null;

  return (
    typeof cause === "object" &&
    cause !== null &&
    "errno" in cause &&
    cause.errno === "23505"
  );
}

/**
 * Data access service for users.
 *
 * Accepts either the shared db instance or a transaction executor, so the same
 * service can be reused inside `db.transaction(...)` blocks.
 */
class UsersService {
  constructor(private readonly db: DBExecutor) {}

  /**
   * Returns a single user by id, or null when it does not exist.
   */
  async getUserById(props: GetUserByIdProps): Promise<GetUserByIdResponse> {
    const [foundUser] = await this.db
      .select()
      .from(user)
      .where(eq(user.id, props.id))
      .limit(1);

    return { user: foundUser ?? null };
  }

  /**
   * Updates the signed in user's own profile (name, first/last name, username,
   * and/or image). Email is excluded; it changes only through Better Auth's
   * verified change-email flow.
   *
   * Usernames follow Better Auth's username plugin convention: stored
   * lowercase for uniqueness, with the typed casing kept in `displayUsername`.
   * A username claimed by another user raises `ConflictError`.
   *
   * Returns the updated row, the current row when no fields differ, or null
   * when the user does not exist.
   */
  async updateUserInfo(props: UpdateUserInfoProps): Promise<UpdateUserInfoResponse> {
    const { user: existingUser } = await this.getUserById({ id: props.id });

    if (!existingUser) {
      return { user: null };
    }

    const values: Partial<typeof user.$inferInsert> = {};

    if (props.name !== undefined && props.name !== existingUser.name) {
      values.name = props.name;
    }

    if (
      props.firstName !== undefined &&
      props.firstName !== existingUser.firstName
    ) {
      values.firstName = props.firstName;
    }

    if (
      props.lastName !== undefined &&
      props.lastName !== existingUser.lastName
    ) {
      values.lastName = props.lastName;
    }

    if (
      props.image !== undefined &&
      props.image !== existingUser.image
    ) {
      values.image = props.image;
    }

    // Comparing lowercased: the stored username is always lowercase.
    if (
      props.username !== undefined &&
      props.username.toLowerCase() !== existingUser.username
    ) {
      values.username = props.username.toLowerCase();
      values.displayUsername = props.username;
    }

    if (Object.keys(values).length === 0) {
      return { user: existingUser };
    }

    try {
      const [updatedUser] = await this.db
        .update(user)
        .set(values)
        .where(eq(user.id, props.id))
        .returning();

      if (!updatedUser) {
        throw new InternalError("user update returned no row");
      }

      return { user: updatedUser };
    } catch (error) {
      // Only `username` carries a unique index among the mutable fields.
      if (isUniqueViolation(error)) {
        throw new ConflictError("username is already taken");
      }

      throw error;
    }
  }
}

export type {
  GetUserByIdProps,
  GetUserByIdResponse,
  UpdateUserInfoInput,
  UpdateUserInfoProps,
  UpdateUserInfoResponse,
};
export {
  getUserByIdResponseSchema,
  updateUserInfoSchema,
  updateUserInfoResponseSchema,
  UsersService,
};
