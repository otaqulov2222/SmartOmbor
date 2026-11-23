import { Router, type IRouter, type Request, type Response } from "express";
import { requireOfficeDirector } from "./local-auth";
import { assistantConfigured, runAssistantChat } from "../lib/assistant";
import {
  appendToSession,
  clearAssistantHistory,
  createAssistantSession,
  deleteAssistantSession,
  getAssistantSession,
  historyRetentionDays,
  listAssistantSessions,
  mergeAssistantSessions,
} from "../lib/assistant-history";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const hits = new Map<string, { n: number; at: number }>();

function rateLimit(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const row = hits.get(key);
  if (!row || now - row.at > windowMs) {
    hits.set(key, { n: 1, at: now });
    return true;
  }
  if (row.n >= limit) return false;
  row.n += 1;
  return true;
}

router.get("/assistant/status", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  res.json({
    configured: assistantConfigured(),
    model: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
    retentionDays: historyRetentionDays(),
  });
});

router.get("/assistant/sessions", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  res.json({
    retentionDays: historyRetentionDays(),
    sessions: listAssistantSessions(user.login),
  });
});

router.post("/assistant/sessions/merge", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  res.json({
    retentionDays: historyRetentionDays(),
    sessions: mergeAssistantSessions(user.login),
  });
});

router.post("/assistant/sessions", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  const session = createAssistantSession(user.login);
  res.json({ session: { id: session.id, title: session.title, updatedAt: session.updatedAt, createdAt: session.createdAt } });
});

router.get("/assistant/sessions/:id", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  const session = getAssistantSession(user.login, String(req.params.id || ""));
  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ session });
});

router.delete("/assistant/sessions/:id", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  deleteAssistantSession(user.login, String(req.params.id || ""));
  res.json({ ok: true, sessions: listAssistantSessions(user.login) });
});

router.delete("/assistant/history", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  clearAssistantHistory(user.login);
  res.json({ ok: true });
});

router.post("/assistant/chat", async (req: Request, res: Response) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  if (!rateLimit(user.id)) {
    res.status(429).json({ error: "rate_limit" });
    return;
  }
  if (!assistantConfigured()) {
    res.status(503).json({ error: "unconfigured", detail: "GROQ_API_KEY .env da yo‘q" });
    return;
  }
  try {
    const message = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    const forceNew = Boolean(req.body?.forceNew);
    const channelRaw = String(req.body?.channel || "").toLowerCase();
    const channel = channelRaw === "telegram" ? "telegram" as const : undefined;
    const result = await runAssistantChat({
      message,
      history,
      channel,
    });
    const files = Array.isArray(result.files) ? result.files : [];
    const saved = appendToSession(
      user.login,
      sessionId,
      [
        { role: "user", content: message },
        { role: "assistant", content: result.reply, tools: result.tools, files },
      ],
      { forceNew },
    );
    res.json({
      reply: result.reply,
      model: result.model,
      tools: result.tools,
      files,
      sessionId: saved.session.id,
      session: {
        id: saved.session.id,
        title: saved.session.title,
        updatedAt: saved.session.updatedAt,
        createdAt: saved.session.createdAt,
        messageCount: saved.session.messages.length,
        messages: saved.session.messages,
      },
      sessions: saved.sessions,
      retentionDays: historyRetentionDays(),
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status: number }).status)
      : 500;
    const code = error instanceof Error ? error.message : "assistant_failed";
    const detail = typeof error === "object" && error && "detail" in error
      ? String((error as { detail?: string }).detail || "")
      : "";
    logger.warn({ err: code, detail: detail || undefined, user: user.login }, "assistant chat failed");
    const friendly = code === "groq_unreachable" || code === "fetch failed"
      ? "yordamchi_tarmoq"
      : code;
    res.status(status || 500).json({ error: friendly, detail: detail || undefined });
  }
});

export default router;
