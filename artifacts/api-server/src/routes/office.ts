import { Router, type IRouter } from "express";
import { listLocalPeople, requireLocalUser, requireOfficeDirector } from "./local-auth";
import {
  OFFICE_ACCURACY_M,
  OFFICE_LAT,
  OFFICE_LNG,
  OFFICE_RADIUS_M,
  createOfficeTask,
  currentQrToken,
  enrollFace,
  faceEnrolled,
  fiksaOf,
  listOfficeTasks,
  officeDistance,
  punch,
  punchesFor,
  rangeDays,
  tashkentParts,
  todayBoard,
  todayPunch,
  updateOfficeTask,
  workedMs,
} from "../lib/office";

const router: IRouter = Router();

function directorOf(role: string) {
  return role === "super_admin" || role === "manager";
}

function punchView(row: ReturnType<typeof todayPunch>) {
  if (!row) return null;
  return {
    ...row,
    workedMs: workedMs(row),
  };
}

router.get("/office/me", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const now = tashkentParts();
  res.json({
    id: user.id,
    name: user.name,
    login: user.login,
    role: user.role,
    director: directorOf(user.role),
    office: { name: "Asosiy ofis", lat: OFFICE_LAT, lng: OFFICE_LNG, radiusM: OFFICE_RADIUS_M, accuracyM: OFFICE_ACCURACY_M, start: "09:00", end: "18:00" },
    clock: now.clock,
    date: now.date,
    face: faceEnrolled(user.id),
    today: punchView(todayPunch(user.id)),
    fiksa: fiksaOf(user.id),
  });
});

router.post("/office/face", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);
  const dist = officeDistance(lat, lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || dist > OFFICE_RADIUS_M || (Number.isFinite(accuracy) && accuracy > OFFICE_ACCURACY_M)) {
    res.status(403).json({ error: "radius", meters: Math.round(dist) });
    return;
  }
  try {
    enrollFace(user.id, String(req.body?.hash ?? ""));
    res.json({ ok: true, face: true });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "face" });
  }
});

router.post("/office/punch", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const kind = String(req.body?.kind ?? "") === "out" ? "out" : "in";
  const method = String(req.body?.method ?? "") === "qr" ? "qr" : "face";
  try {
    const row = punch({
      accountId: user.id,
      kind,
      method,
      lat: Number(req.body?.lat),
      lng: Number(req.body?.lng),
      accuracy: Number(req.body?.accuracy),
      faceHash: String(req.body?.faceHash ?? ""),
      qrToken: String(req.body?.qrToken ?? ""),
    });
    res.json({ today: punchView(row) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "rejected";
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    const dist = officeDistance(Number(req.body?.lat), Number(req.body?.lng));
    res.status(status || 400).json({ error: code, meters: Math.round(Number.isFinite(dist) ? dist : 0) });
  }
});

router.get("/office/history", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const kind = String(req.query.range ?? "week");
  const range = rangeDays(kind === "day" || kind === "month" ? kind : "week");
  const rows = punchesFor(user.id, range.from, range.to).map((row) => ({ ...row, workedMs: workedMs(row) }));
  res.json({ ...range, items: rows, fiksa: fiksaOf(user.id) });
});

router.get("/office/qr", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  res.json(currentQrToken());
});

router.get("/office/board", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const people = listLocalPeople();
  const byId = new Map(people.map((row) => [row.id, row]));
  res.json({
    office: { name: "Asosiy ofis", lat: OFFICE_LAT, lng: OFFICE_LNG, radiusM: OFFICE_RADIUS_M },
    items: todayBoard().map((row) => ({
      ...row,
      workedMs: workedMs(row),
      name: byId.get(row.accountId)?.name || row.accountId,
      login: byId.get(row.accountId)?.login || "",
    })),
  });
});

router.get("/office/people", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  res.json({
    items: listLocalPeople().filter((row) => row.role === "office" || row.role === "worker" || row.role === "accountant" || row.role === "manager" || row.role === "super_admin"),
  });
});

router.get("/office/tasks", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const director = directorOf(user.role);
  const people = listLocalPeople();
  const names = new Map(people.map((row) => [row.id, row.name]));
  res.json({
    items: listOfficeTasks(user.id, director).map((task) => ({
      ...task,
      assignees: task.assignedTo.map((id) => ({ id, name: names.get(id) || id })),
      late: task.status !== "done" && `${task.dueDate} ${task.dueTime}` < `${tashkentParts().date} ${tashkentParts().hm}`,
    })),
  });
});

router.post("/office/tasks", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  try {
    const known = new Set(listLocalPeople().map((row) => row.id));
    const assigned = (Array.isArray(req.body?.assignedTo) ? req.body.assignedTo.map((id: unknown) => String(id)) : [String(req.body?.assignedTo ?? "")]).filter((id: string) => known.has(id));
    const task = createOfficeTask({
      title: String(req.body?.title ?? ""),
      description: String(req.body?.description ?? ""),
      assignedTo: assigned,
      dueDate: String(req.body?.dueDate ?? ""),
      dueTime: String(req.body?.dueTime ?? "18:00"),
      priority: String(req.body?.priority ?? "normal") as "low" | "normal" | "high" | "urgent",
      remind: Boolean(req.body?.remind),
      createdBy: user.id,
    });
    res.status(201).json(task);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "task" });
  }
});

router.patch("/office/tasks/:id", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  try {
    const task = updateOfficeTask(String(req.params.id), user.id, directorOf(user.role), {
      status: req.body?.status,
      note: req.body?.note,
    });
    res.json(task);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "task" });
  }
});

export default router;
