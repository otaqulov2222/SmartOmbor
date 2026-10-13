import { getAuth } from "@clerk/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { and, count, eq } from "drizzle-orm";
import { db, appUsersTable } from "@workspace/db";

export const appRoles = [
  "super_admin",
  "manager",
  "warehouse_manager",
  "warehouse_staff",
  "branch_manager",
  "analyst",
] as const;

export type AppRole = (typeof appRoles)[number];

export interface AppActor {
  id: string;
  name: string;
  email: string;
  role: AppRole;
}

function stringClaim(
  claims: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Avval tizimga kiring." });
    return;
  }
  res.locals.clerkUserId = userId;
  next();
}

export async function ensureAppUser(req: Request): Promise<AppActor> {
  const auth = getAuth(req);
  const userId = auth.userId;
  if (!userId) throw new Error("Authentication required");

  const existing = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId))
    .limit(1);
  if (existing[0]) {
    return {
      id: existing[0].id,
      name: existing[0].name || existing[0].email || existing[0].id,
      email: existing[0].email,
      role: existing[0].role as AppRole,
    };
  }

  const claims = (auth.sessionClaims ?? {}) as unknown as Record<
    string,
    unknown
  >;
  const email =
    stringClaim(claims, ["email", "email_address"]) ??
    `user-${userId.slice(-8)}@account.local`;
  const name =
    stringClaim(claims, ["name", "full_name"]) ??
    email.split("@")[0] ??
    `Xodim ${userId.slice(-6)}`;
  const existingCount = await db.select({ value: count() }).from(appUsersTable);
  const initialRole: AppRole =
    Number(existingCount[0]?.value ?? 0) === 0 ? "super_admin" : "warehouse_staff";
  const inserted = await db
    .insert(appUsersTable)
    .values({ id: userId, name, email, role: initialRole })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) {
    return {
      id: inserted[0].id,
      name: inserted[0].name,
      email: inserted[0].email,
      role: inserted[0].role as AppRole,
    };
  }

  const current = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId))
    .limit(1);
  if (current[0]) {
    return {
      id: current[0].id,
      name: current[0].name || current[0].email || current[0].id,
      email: current[0].email,
      role: current[0].role as AppRole,
    };
  }

  const staff = await db
    .insert(appUsersTable)
    .values({ id: userId, name, email, role: "warehouse_staff" })
    .onConflictDoNothing()
    .returning();
  if (!staff[0]) throw new Error("Unable to initialize the staff account");
  return {
    id: staff[0].id,
    name: staff[0].name,
    email: staff[0].email,
    role: staff[0].role as AppRole,
  };
}

export function requireRoles(...roles: AppRole[]): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        const actor = await ensureAppUser(req);
        if (!roles.includes(actor.role)) {
          res.status(403).json({ error: "Bu amal uchun ruxsat yo‘q." });
          return;
        }
        res.locals.actor = actor;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function getActor(res: Response): AppActor {
  const actor = res.locals.actor as AppActor | undefined;
  if (!actor) throw new Error("Authorized app user is not available");
  return actor;
}

export async function getActorById(id: string): Promise<AppActor | undefined> {
  const rows = await db
    .select()
    .from(appUsersTable)
    .where(and(eq(appUsersTable.id, id)))
    .limit(1);
  const user = rows[0];
  if (!user) return undefined;
  return {
    id: user.id,
    name: user.name || user.email || user.id,
    email: user.email,
    role: user.role as AppRole,
  };
}
