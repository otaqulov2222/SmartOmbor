import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { db, kpiAgentSessionsTable, kpiAgentsTable } from "@workspace/db";
import { ensureAppUser, type AppActor, type AppRole } from "../auth";

export const KPI_ADMIN_ROLES: AppRole[] = ["super_admin", "manager", "sales_admin"];
const ADMIN_SET = new Set(["super_admin", "manager", "sales_admin"]);

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const digest = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `${salt}$${digest}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split("$");
  if (!salt || !digest) return false;
  const next = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(next, "hex"));
  } catch {
    return false;
  }
}

export type KpiAgentActor = {
  id: string;
  fullName: string;
  login: string;
  status: string;
  territoryId: string | null;
};

export async function loginAgent(login: string, password: string): Promise<{ token: string; agent: KpiAgentActor } | null> {
  const key = login.trim().toLowerCase();
  const rows = await db
    .select()
    .from(kpiAgentsTable)
    .where(eq(kpiAgentsTable.login, key))
    .limit(1);
  let agent = rows[0];
  let passwordOk = Boolean(agent && verifyPassword(password, agent.passwordHash));
  if (!passwordOk) {
    const { verifyLocalAgentCredentials } = await import("../../routes/local-auth");
    const localAcc = verifyLocalAgentCredentials(key, password);
    if (localAcc) {
      passwordOk = true;
      if (!agent) {
        const [created] = await db
          .insert(kpiAgentsTable)
          .values({
            fullName: localAcc.name || key,
            login: key,
            passwordHash: hashPassword(password),
            status: "active",
            createdBy: "local-auth",
          })
          .onConflictDoNothing()
          .returning();
        agent = created;
      }
    }
  }
  if (!agent || agent.status !== "active" || !passwordOk) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(kpiAgentSessionsTable).values({ agentId: agent.id, token, expiresAt });
  return {
    token,
    agent: {
      id: agent.id,
      fullName: agent.fullName,
      login: agent.login,
      status: agent.status,
      territoryId: agent.territoryId,
    },
  };
}

export async function resolveAgentToken(token: string | undefined): Promise<KpiAgentActor | null> {
  if (!token) return null;
  const rows = await db
    .select({
      id: kpiAgentsTable.id,
      fullName: kpiAgentsTable.fullName,
      login: kpiAgentsTable.login,
      status: kpiAgentsTable.status,
      territoryId: kpiAgentsTable.territoryId,
      expiresAt: kpiAgentSessionsTable.expiresAt,
    })
    .from(kpiAgentSessionsTable)
    .innerJoin(kpiAgentsTable, eq(kpiAgentSessionsTable.agentId, kpiAgentsTable.id))
    .where(and(eq(kpiAgentSessionsTable.token, token), gt(kpiAgentSessionsTable.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    fullName: row.fullName,
    login: row.login,
    status: row.status,
    territoryId: row.territoryId,
  };
}

export async function logoutAgent(token: string) {
  await db.delete(kpiAgentSessionsTable).where(eq(kpiAgentSessionsTable.token, token));
}

function bearer(req: Request) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  const alt = req.headers["x-agent-token"];
  return typeof alt === "string" ? alt : undefined;
}

/** Staff admin for KPI — local session or Clerk app user. */
export function requireKpiAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const { localActor } = await import("../../routes/local-auth");
        const local = localActor(req);
        if (local && ADMIN_SET.has(local.role)) {
          res.locals.actor = {
            id: local.id,
            name: local.name,
            email: `${local.login}@local`,
            role: local.role as AppRole,
          };
          next();
          return;
        }
        const actor = await ensureAppUser(req);
        if (!ADMIN_SET.has(actor.role)) {
          res.status(403).json({ error: "KPI admin ruxsati yo‘q." });
          return;
        }
        res.locals.actor = actor;
        next();
      } catch {
        res.status(401).json({ error: "Avval tizimga kiring." });
      }
    })();
  };
}

export function requireKpiAgent() {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const token = bearer(req);
        const agent = await resolveAgentToken(token);
        if (agent) {
          res.locals.kpiAgent = agent;
          next();
          return;
        }
        // Also accept unified Bordo local-login token for role=agent (or admin preview)
        const { localActor } = await import("../../routes/local-auth");
        const local = localActor(req);
        if (local) {
          const loginKey = local.login.trim().toLowerCase();
          const nameKey = local.name.trim().toLowerCase();
          const all = await db.select().from(kpiAgentsTable);
          const match =
            all.find((a) => a.login.toLowerCase() === loginKey) ||
            all.find((a) => a.fullName.toLowerCase() === nameKey);
          if (match) {
            res.locals.kpiAgent = {
              id: match.id,
              fullName: match.fullName,
              login: match.login,
              status: match.status,
              territoryId: match.territoryId,
            };
            next();
            return;
          }
          const [created] = await db
            .insert(kpiAgentsTable)
            .values({
              fullName: local.name || local.login,
              login: loginKey,
              passwordHash: hashPassword("1234"),
              status: "active",
              createdBy: "local-auth",
            })
            .onConflictDoNothing()
            .returning();
          if (created) {
            res.locals.kpiAgent = {
              id: created.id,
              fullName: created.fullName,
              login: created.login,
              status: created.status,
              territoryId: created.territoryId,
            };
            next();
            return;
          }
        }
        res.status(401).json({ error: "Agent sessiyasi yo‘q yoki muddati tugagan." });
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** Agent session OR KPI admin — used by shared proxies like /kpi/route. */
export function requireKpiAgentOrAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        const token = bearer(req);
        const agent = await resolveAgentToken(token);
        if (agent) {
          res.locals.kpiAgent = agent;
          next();
          return;
        }
        const { localActor } = await import("../../routes/local-auth");
        const local = localActor(req);
        if (local && ADMIN_SET.has(local.role)) {
          res.locals.actor = {
            id: local.id,
            name: local.name,
            email: `${local.login}@local`,
            role: local.role as AppRole,
          };
          next();
          return;
        }
        if (local) {
          const loginKey = local.login.trim().toLowerCase();
          const nameKey = local.name.trim().toLowerCase();
          const all = await db.select().from(kpiAgentsTable);
          const match =
            all.find((a) => a.login.toLowerCase() === loginKey) ||
            all.find((a) => a.fullName.toLowerCase() === nameKey);
          if (match) {
            res.locals.kpiAgent = {
              id: match.id,
              fullName: match.fullName,
              login: match.login,
              status: match.status,
              territoryId: match.territoryId,
            };
            next();
            return;
          }
        }
        try {
          const actor = await ensureAppUser(req);
          if (ADMIN_SET.has(actor.role)) {
            res.locals.actor = actor;
            next();
            return;
          }
        } catch {
          /* not a Clerk session */
        }
        res.status(401).json({ error: "Marshrut uchun agent yoki admin sessiyasi kerak." });
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function getKpiAgent(res: Response): KpiAgentActor {
  const agent = res.locals.kpiAgent as KpiAgentActor | undefined;
  if (!agent) throw new Error("KPI agent missing");
  return agent;
}

export function getKpiActor(res: Response): AppActor {
  const actor = res.locals.actor as AppActor | undefined;
  if (!actor) throw new Error("KPI admin missing");
  return actor;
}
