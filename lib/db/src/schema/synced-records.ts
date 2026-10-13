import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const syncedRecordsTable = pgTable(
  "synced_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordKey: text("record_key").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    warehouseId: text("warehouse_id").notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    generation: text("generation").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    recordKeyUnique: uniqueIndex("synced_records_record_key_unique").on(
      table.recordKey,
    ),
    kindIndex: index("synced_records_kind_idx").on(table.kind),
    warehouseIndex: index("synced_records_warehouse_idx").on(
      table.kind,
      table.warehouseId,
    ),
  }),
);
