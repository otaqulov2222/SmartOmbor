import type { NextFunction, Request, Response } from "express";
import { billingStatus, isBillingLocked } from "../lib/server-billing";

/** `/api` ga mount qilinganda path `/server-billing` ko‘rinishida keladi. */
const ALLOW_PREFIXES = [
  "/healthz",
  "/health",
  "/local-auth",
  "/server-billing",
  "/assistant/status",
];

function allowed(path: string) {
  const p = (path.split("?")[0] || "").replace(/\/+$/, "") || "/";
  return ALLOW_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));
}

/** Muddat o‘tsa — asosiy API yopiladi (login + to‘lov belgilash ochiq qoladi). */
export function serverBillingLockMiddleware(req: Request, res: Response, next: NextFunction) {
  if (allowed(req.path)) return next();
  if (!isBillingLocked()) return next();
  const status = billingStatus();
  res.status(423).json({
    error: "server_billing_locked",
    message: "Server to‘lovi muddati o‘tgan. Tizim to‘xtatilgan. To‘lovdan keyin admin belgilashi kerak.",
    nextDue: status.nextDue,
    daysLeft: status.daysLeft,
  });
}
