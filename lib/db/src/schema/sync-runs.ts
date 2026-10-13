import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const syncRunsTable = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  productCount: integer("product_count").notNull().default(0),
  warehouseCount: integer("warehouse_count").notNull().default(0),
  error: text("error"),
  result: jsonb("result").$type<Record<string, unknown> | null>(),
});
