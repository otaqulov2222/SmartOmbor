import { Router, type IRouter } from "express";
import { ListAuditEventsResponse } from "@workspace/api-zod";
import { auditDetail, listAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/audit", async (_req, res, next) => {
  try {
    const rows = await listAudit();
    res.json(ListAuditEventsResponse.parse(rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actorName,
      createdAt: row.createdAt,
      details: auditDetail(row.details),
    }))));
  } catch (error) {
    next(error);
  }
});

export default router;
