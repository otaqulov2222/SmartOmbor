import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { date } from "drizzle-orm/pg-core";

export const tasksTable = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    assignedTo: text("assigned_to"),
    dueDate: date("due_date", { mode: "string" }),
    priority: text("priority").notNull().default("normal"),
    status: text("status").notNull().default("open"),
    source: text("source"),
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
    statusDueIndex: index("tasks_status_due_idx").on(
      table.status,
      table.dueDate,
    ),
  }),
);
