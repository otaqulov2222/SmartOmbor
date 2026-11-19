import { Router, type IRouter } from "express";
import { requireOfficeDirector } from "./local-auth";
import {
  billingStatus,
  ensureBillingInitialized,
  isBillingLocked,
  markServerPaid,
} from "../lib/server-billing";

const router: IRouter = Router();

/** Holat — login qilganlar ko‘radi (banner uchun). */
router.get("/server-billing", (req, res) => {
  ensureBillingInitialized();
  const status = billingStatus();
  res.json({
    nextDue: status.nextDue,
    paidAt: status.paidAt,
    daysLeft: status.daysLeft,
    locked: status.locked,
    periodDays: status.periodDays,
    remindHour: status.remindHour,
    today: status.today,
  });
});

/** To‘lov qilindi — faqat rahbar/menejer. */
router.post("/server-billing/paid", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  const paidAt = typeof req.body?.paidAt === "string" ? req.body.paidAt : undefined;
  const periodDays = req.body?.periodDays != null ? Number(req.body.periodDays) : undefined;
  const note = typeof req.body?.note === "string" ? req.body.note : `admin:${user.login}`;
  const next = markServerPaid({ paidAt, periodDays, note });
  res.json({
    ok: true,
    paidAt: next.paidAt,
    nextDue: next.nextDue,
    periodDays: next.periodDays,
    locked: isBillingLocked(),
  });
});

export default router;
