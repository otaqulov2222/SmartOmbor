import { Router, type IRouter } from "express";
import { loadCatalog, resetCatalog } from "../lib/catalog";
import { clearConnection, connectionView, probeMoySklad, saveConnection } from "../lib/connection";
import { loadMarkup, saveMarkup } from "../lib/markup";
import { recordAudit } from "../lib/audit";
import { requireLocalAdmin } from "./local-auth";

const router: IRouter = Router();

router.get("/settings/markup", (_req, res) => {
  res.json(loadMarkup());
});

router.put("/settings/markup", (req, res) => {
  if (!requireLocalAdmin(req, res)) return;
  const saved = saveMarkup({
    Premium: req.body?.Premium,
    Exclusive: req.body?.Exclusive,
    Standard: req.body?.Standard,
  });
  void recordAudit({ action: "settings.markup", entityType: "settings", details: JSON.stringify(saved) });
  res.json(saved);
});

router.get("/settings/connection", (req, res) => {
  if (!requireLocalAdmin(req, res)) return;
  res.json(connectionView());
});

router.post("/settings/connection", async (req, res) => {
  if (!requireLocalAdmin(req, res)) return;
  const token = String(req.body?.token ?? "").trim();
  if (token.length < 20) {
    res.status(400).json({ error: "rejected" });
    return;
  }
  try {
    const companyName = await probeMoySklad(token);
    saveConnection(token, companyName);
    resetCatalog();
    void loadCatalog(true).catch(() => undefined);
    void recordAudit({ action: "connection.saved", entityType: "moysklad", details: companyName });
    const view = connectionView();
    res.json({ ...view, companyName });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "rejected";
    res.status(400).json({ error: reason === "api-denied" || reason === "forbidden" ? reason : "rejected" });
  }
});

router.delete("/settings/connection", (req, res) => {
  if (!requireLocalAdmin(req, res)) return;
  clearConnection();
  resetCatalog();
  void loadCatalog(true).catch(() => undefined);
  void recordAudit({ action: "connection.cleared", entityType: "moysklad" });
  res.json(connectionView());
});

export default router;
