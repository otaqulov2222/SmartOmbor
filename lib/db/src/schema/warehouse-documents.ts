import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const warehouseDocumentsTable = pgTable(
  "warehouse_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    number: text("number").notNull(),
    status: text("status").notNull(),
    sourceWarehouseId: text("source_warehouse_id"),
    targetWarehouseId: text("target_warehouse_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    externalDocumentId: text("external_document_id"),
    externalCode: text("external_code").notNull(),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    kindStatusIndex: index("warehouse_documents_kind_status_idx").on(
      table.kind,
      table.status,
    ),
    externalCodeIndex: index("warehouse_documents_external_code_idx").on(
      table.externalCode,
    ),
  }),
);
