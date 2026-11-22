import { relations } from "drizzle-orm/_relations";
import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { z } from "@hono/zod-openapi";
import { createSchemaFactory } from "drizzle-orm/zod";

type User = typeof user.$inferSelect;
type InsertUser = typeof user.$inferInsert;

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at")
    .$onUpdate(() => new Date())
    .notNull(),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
});

const { createSelectSchema, createInsertSchema, createUpdateSchema } =
  createSchemaFactory({
    zodInstance: z,
  });
const selectUserSchema = createSelectSchema(user);
const insertUserSchema = createInsertSchema(user).omit({
  id: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
  displayUsername: true,
});
const updateUserSchema = createUpdateSchema(user).pick({
  name: true,
  email: true,
  username: true,
  image: true,
  firstName: true,
  lastName: true,
});

/**
 * Shared per-field user schemas, reused by the sign-up (insert) and the
 * profile-update schemas so both validate identically.
 */
const userNameSchema = z
  .string()
  .min(1)
  .max(100)
  .openapi({ example: "Jane Doe" });
const userFirstNameSchema = z
  .string()
  .min(1)
  .max(100)
  .openapi({ example: "Jane" });
const userLastNameSchema = z
  .string()
  .min(1)
  .max(100)
  .openapi({ example: "Doe" });
const userUsernameSchema = z
  .string()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_.]+$/)
  .optional()
  .openapi({ example: "jane.doe" });

/**
 * Mutable profile fields for self-updates. Email is intentionally excluded:
 * changing it must go through Better Auth's verified change-email flow.
 */
const updateUserInfoSchema = z.object({
  name: userNameSchema.optional(),
  firstName: userFirstNameSchema.optional(),
  lastName: userLastNameSchema.optional(),
  username: userUsernameSchema,
  image: z.string().nullable().optional(),
});

const signUpWithEmailSchema = insertUserSchema
  .omit({ image: true })
  .extend({
    name: userNameSchema,
    email: z.email().openapi({ example: "jane@example.com" }),
    password: z.string().min(8).max(128).openapi({ example: "supersecret" }),
    username: userUsernameSchema,
    firstName: userFirstNameSchema,
    lastName: userLastNameSchema,
  })
  .openapi({
    example: {
      name: "Jane Doe",
      email: "jane@example.com",
      password: "supersecret",
      username: "jane.doe",
      firstName: "Jane",
      lastName: "Doe",
    },
  });
const signInWithEmailSchema = z.object({
  email: z.email().openapi({ example: "jane@example.com" }),
  password: z.string().min(1).openapi({ example: "supersecret" }),
  rememberMe: z.boolean().openapi({ example: true }).optional(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export type { User, InsertUser };
export {
  selectUserSchema,
  insertUserSchema,
  updateUserSchema,
  updateUserInfoSchema,
  signUpWithEmailSchema,
  signInWithEmailSchema,
};
