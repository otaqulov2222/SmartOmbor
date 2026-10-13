import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const appUsersTable = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    role: text("role").notNull().default("warehouse_staff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    oneSuperAdmin: uniqueIndex("app_users_one_super_admin")
      .on(table.role)
      .where(sql`${table.role} = 'super_admin'`),
  }),
);
