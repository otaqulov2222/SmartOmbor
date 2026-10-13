import { desc, sql } from "drizzle-orm";
import { db, auditEventsTable } from "@workspace/db";
import { logger } from "./logger";

let ready: Promise<void> | null = null;

function ensureTable() {
  ready ??= db.execute(sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text,
      actor_id text NOT NULL,
      actor_name text NOT NULL,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `).then(() => undefined);
  return ready;
}

export async function recordAudit(entry: {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorName?: string;
  details?: string | null;
}) {
  try {
    await ensureTable();
    await db.insert(auditEventsTable).values({
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      actorId: "local",
      actorName: entry.actorName || "Administrator",
      details: entry.details ? { text: entry.details } : null,
    });
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : "audit" }, "Audit event was not saved");
  }
}

export async function listAudit(limit = 200) {
  await ensureTable();
  return db.select().from(auditEventsTable).orderBy(desc(auditEventsTable.createdAt)).limit(limit);
}

export function auditDetail(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  return null;
}
