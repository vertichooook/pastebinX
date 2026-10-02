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
export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  username: varchar({ length: 64 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: varchar({ length: 8 }).notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  nextDefNumber: integer("next_def_number").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const entries = pgTable(
  "entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    defNumber: integer("def_number").notNull(),
    slug: varchar({ length: 32 }).notNull(),
    title: varchar({ length: 200 }),
    content: text().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.userId, t.defNumber), unique().on(t.userId, t.slug)],
);
export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.userId)],
);
export const auditLogs = pgTable("audit_logs", {
  id: uuid().primaryKey().defaultRandom(),
  adminId: uuid("admin_id"),
  action: varchar({ length: 32 }).notNull(),
  targetUserId: uuid("target_user_id"),
  targetEntryId: uuid("target_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const loginLimits = pgTable("login_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
