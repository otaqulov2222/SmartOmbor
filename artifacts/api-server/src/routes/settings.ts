import { Router, type IRouter } from "express";
import { loadCatalog, resetCatalog } from "../lib/catalog";
import { clearConnection, connectionView, probeMoySklad, saveConnection } from "../lib/connection";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

router.get("/settings/connection", (_req, res) => {
  res.json(connectionView());
});

router.post("/settings/connection", async (req, res) => {
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
  } catch {
    res.status(400).json({ error: "rejected" });
  }
});

router.delete("/settings/connection", (_req, res) => {
  clearConnection();
  resetCatalog();
  void loadCatalog(true).catch(() => undefined);
  void recordAudit({ action: "connection.cleared", entityType: "moysklad" });
  res.json(connectionView());
});

export default router;
