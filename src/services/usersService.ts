import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { selectUserSchema, user } from "../../auth-schema";
import type { DBExecutor } from "../db/connect";

type GetUserByIdProps = {
  id: string;
};

const getUserByIdResponseSchema = z.object({
  user: selectUserSchema.nullable(),
});

type GetUserByIdResponse = z.infer<typeof getUserByIdResponseSchema>;

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
}

export type { GetUserByIdProps, GetUserByIdResponse };
export { getUserByIdResponseSchema, UsersService };
