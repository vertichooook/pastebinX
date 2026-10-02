import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  unique,
  index,
} from "drizzle-orm/pg-core";
const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const admins = pgTable("admins", {
  id: uuid().primaryKey().defaultRandom(),
  singleton: boolean().notNull().default(true).unique(),
  passwordHash: text("password_hash").notNull(),
  ...dates(),
});
export const profiles = pgTable("profiles", {
  id: uuid().primaryKey().defaultRandom(),
  name: varchar({ length: 64 }).notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  ...dates(),
});
export const functions = pgTable("functions", {
  id: uuid().primaryKey().defaultRandom(),
  defNumber: integer("def_number").notNull().unique(),
  slug: varchar({ length: 32 }).notNull().unique(),
  title: varchar({ length: 200 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...dates(),
});
export const functionCounter = pgTable("function_counter", {
  singleton: boolean().primaryKey().default(true),
  nextNumber: integer("next_number").notNull().default(1),
});
export const variants = pgTable(
  "variants",
  {
    id: uuid().primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    content: text().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...dates(),
  },
  (t) => [unique().on(t.profileId, t.functionId), index().on(t.functionId)],
);
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => admins.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.adminId)],
);
export const auditLogs = pgTable("audit_logs", {
  id: uuid().primaryKey().defaultRandom(),
  adminId: uuid("admin_id"),
  action: varchar({ length: 32 }).notNull(),
  targetUserId: uuid("target_user_id"),
  targetEntryId: uuid("target_entry_id"),
  targetFunctionId: uuid("target_function_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const loginLimits = pgTable("login_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
