import { Router, type IRouter } from "express";
import { listLocalPeople, requireLocalUser, requireOfficeDirector } from "./local-auth";
import {
  addAdjustment,
  addAdvance,
  currentQrToken,
  deleteAdjustment,
  deleteAdvance,
  enrollFace,
  faceEnrolled,
  faceMatchDistance,
  fiksaOf,
  flushOfficeStore,
  insideOffice,
  officeDistance,
  officeSite,
  payrollForAccount,
  payrollMonth,
  pruneOrphanFaces,
  punch,
  punchesFor,
  rangeDays,
  setFineOverride,
  setOfficeSite,
  setPayrollSettings,
  setSalary,
  setTabelMark,
  setWorkSchedule,
  schedulesOf,
  hoursFor,
  tashkentParts,
  tabelDay,
  tabelRange,
  todayBoard,
  todayPunch,
  workedMs,
} from "../lib/office";

const router: IRouter = Router();

function directorOf(role: string) {
  // Faqat rahbar — ofis nuqtasi / admin matnlari.
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
  const site = officeSite();
  res.json({
    id: user.id,
    name: user.name,
    login: user.login,
    role: user.role,
    director: directorOf(user.role),
    office: site,
    hours: hoursFor(user.id),
    clock: now.clock,
    date: now.date,
    face: faceEnrolled(user.id),
    today: punchView(todayPunch(user.id)),
    fiksa: fiksaOf(user.id),
    monthlySalary: fiksaOf(user.id),
  });
});

router.post("/office/site", async (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    // Ofis GPS nuqtasini API orqali ko‘chirish taqiqlangan (davomat bypass).
    // Faqat ish soatlari / nom / radius sozlamalari.
    const site = setOfficeSite({
      radiusM: req.body?.radiusM != null ? Number(req.body.radiusM) : undefined,
      accuracyM: req.body?.accuracyM != null ? Number(req.body.accuracyM) : undefined,
      name: req.body?.name != null ? String(req.body.name) : undefined,
      start: req.body?.start != null ? String(req.body.start) : undefined,
      end: req.body?.end != null ? String(req.body.end) : undefined,
      offDays: Array.isArray(req.body?.offDays) ? req.body.offDays.map((n: unknown) => Number(n)) : undefined,
    });
    await flushOfficeStore();
    res.json({ office: site });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "site" });
  }
});

router.get("/office/schedules", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const site = officeSite();
  res.json({
    site: { start: site.start, end: site.end, offDays: site.offDays },
    schedules: schedulesOf(),
  });
});

router.put("/office/schedules/:accountId", async (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const accountId = String(req.params.accountId || "");
  const known = listLocalPeople().some((person) => person.id === accountId);
  if (!accountId || !known) {
    res.status(400).json({ error: "person" });
    return;
  }
  try {
    const clear = Boolean(req.body?.clear) || req.body?.start === "" || req.body?.end === "";
    const row = setWorkSchedule({
      accountId,
      start: String(req.body?.start ?? ""),
      end: String(req.body?.end ?? ""),
      offDays: Array.isArray(req.body?.offDays) ? req.body.offDays.map((n: unknown) => Number(n)) : req.body?.offDays === null ? null : undefined,
      note: req.body?.note != null ? String(req.body.note) : undefined,
      clear,
    });
    await flushOfficeStore();
    res.json({
      schedule: row,
      resolved: hoursFor(accountId),
      site: officeSite(),
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "schedule" });
  }
});

router.post("/office/face", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);
  const dist = officeDistance(lat, lng);
  if (!insideOffice(lat, lng, accuracy)) {
    const badGeo = !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) || accuracy <= 0;
    res.status(badGeo ? 400 : 403).json({
      error: badGeo ? "geo" : "radius",
      meters: Math.round(Number.isFinite(dist) ? dist : 0),
      accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    });
    return;
  }
  try {
    const hashes = Array.isArray(req.body?.hashes)
      ? req.body.hashes.map((item: unknown) => String(item ?? ""))
      : req.body?.hash != null
        ? [String(req.body.hash)]
        : [];
    const descriptors = Array.isArray(req.body?.descriptors) ? req.body.descriptors : [];
    const replace = Boolean(req.body?.replace);
    const activeAccountIds = listLocalPeople().map((person) => person.id);
    pruneOrphanFaces(activeAccountIds);
    enrollFace(user.id, { hashes, descriptors, replace, activeAccountIds });
    res.json({ ok: true, face: true, replaced: replace });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "face" });
  }
});

/** Live Face ID scan — tugmadan oldin yuzni tanib olish. */
router.post("/office/face/check", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  if (!faceEnrolled(user.id)) {
    res.status(409).json({ error: "enroll", match: false });
    return;
  }
  const descriptor = Array.isArray(req.body?.descriptor) ? req.body.descriptor : null;
  const distance = descriptor ? faceMatchDistance(user.id, descriptor) : null;
  if (distance == null) {
    res.json({ match: false, distance: null, needEnroll: true });
    return;
  }
  res.json({ match: distance <= 0.48, distance: Math.round(distance * 1000) / 1000 });
});

router.post("/office/punch", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  const kind = String(req.body?.kind ?? "") === "out" ? "out" : "in";
  const method = String(req.body?.method ?? "") === "qr" ? "qr" : "face";
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);
  try {
    const faceHashes = Array.isArray(req.body?.faceHashes)
      ? req.body.faceHashes.map((item: unknown) => String(item ?? ""))
      : undefined;
    const faceDescriptors = Array.isArray(req.body?.faceDescriptors) ? req.body.faceDescriptors : undefined;
    const row = punch({
      accountId: user.id,
      kind,
      method,
      lat,
      lng,
      accuracy,
      faceHash: String(req.body?.faceHash ?? ""),
      faceHashes,
      faceDescriptors,
      qrToken: String(req.body?.qrToken ?? ""),
    });
    res.json({ today: punchView(row) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "rejected";
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    const dist = officeDistance(lat, lng);
    res.status(status || 400).json({
      error: code,
      meters: Math.round(Number.isFinite(dist) ? dist : 0),
      accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    });
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
  const site = officeSite();
  res.json({
    office: { name: site.name, lat: site.lat, lng: site.lng, radiusM: site.radiusM },
    items: todayBoard().map((row) => ({
      ...row,
      workedMs: workedMs(row),
      name: byId.get(row.accountId)?.name || row.accountId,
      login: byId.get(row.accountId)?.login || "",
    })),
  });
});

router.get("/office/tabel", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  const people = listLocalPeople();
  const today = tashkentParts().date;
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    res.json(tabelRange(from > today ? today : from, to > today ? today : to, people));
    return;
  }
  const kind = String(req.query.range ?? "");
  if (kind === "week" || kind === "month") {
    const span = rangeDays(kind);
    res.json(tabelRange(span.from, span.to, people));
    return;
  }
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? "")) ? String(req.query.date) : today;
  res.json(tabelDay(requested > today ? today : requested, people));
});

router.patch("/office/tabel", (req, res) => {
  const user = requireOfficeDirector(req, res);
  if (!user) return;
  const accountId = String(req.body?.accountId ?? "");
  const known = listLocalPeople().some((person) => person.id === accountId);
  if (!accountId || !known) {
    res.status(400).json({ error: "person" });
    return;
  }
  try {
    const row = setTabelMark({
      accountId,
      date: String(req.body?.date ?? ""),
      excuse: req.body?.excuse != null ? String(req.body.excuse) : undefined,
      note: req.body?.note != null ? String(req.body.note) : undefined,
    });
    res.json({ ok: true, row });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "tabel" });
  }
});

router.get("/office/people", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  res.json({
    items: listLocalPeople(),
  });
});

function monthParam(raw: unknown) {
  const value = String(raw || "").trim();
  if (/^\d{4}-\d{2}$/.test(value)) return value;
  return tashkentParts().date.slice(0, 7);
}

router.get("/office/payroll", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    const month = monthParam(req.query.month);
    const people = listLocalPeople();
    res.json(payrollMonth(month, people));
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "payroll" });
  }
});

router.get("/office/payroll/me", (req, res) => {
  const user = requireLocalUser(req, res);
  if (!user) return;
  try {
    const month = monthParam(req.query.month);
    res.json(
      payrollForAccount(month, {
        id: user.id,
        name: user.name,
        login: user.login,
        role: user.role,
      }),
    );
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "payroll" });
  }
});

router.put("/office/payroll/settings", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    const settings = setPayrollSettings({ latePenaltyPct: Number(req.body?.latePenaltyPct) });
    res.json({ settings });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "settings" });
  }
});

router.put("/office/payroll/salary", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    const accountId = String(req.body?.accountId || "");
    const known = listLocalPeople().some((p) => p.id === accountId);
    if (!known) {
      res.status(404).json({ error: "person" });
      return;
    }
    const row = setSalary({
      accountId,
      monthly: Number(req.body?.monthly),
      note: req.body?.note != null ? String(req.body.note) : undefined,
    });
    res.json({ salary: row });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "salary" });
  }
});

router.post("/office/payroll/advances", (req, res) => {
  const director = requireOfficeDirector(req, res);
  if (!director) return;
  try {
    const accountId = String(req.body?.accountId || "");
    if (!listLocalPeople().some((p) => p.id === accountId)) {
      res.status(404).json({ error: "person" });
      return;
    }
    const row = addAdvance({
      accountId,
      amount: Number(req.body?.amount),
      date: String(req.body?.date || tashkentParts().date),
      note: req.body?.note != null ? String(req.body.note) : undefined,
      createdBy: director.login,
    });
    res.status(201).json({ advance: row });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "advance" });
  }
});

router.delete("/office/payroll/advances/:id", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    res.json(deleteAdvance(String(req.params.id)));
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "advance" });
  }
});

router.put("/office/payroll/fine-override", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    const kind = String(req.body?.kind || "") === "late" ? "late" : "absent";
    const amountRaw = req.body?.amount;
    const amount =
      amountRaw === null || amountRaw === undefined || amountRaw === ""
        ? null
        : Number(amountRaw);
    const row = setFineOverride({
      accountId: String(req.body?.accountId || ""),
      date: String(req.body?.date || ""),
      kind,
      amount,
      note: req.body?.note != null ? String(req.body.note) : undefined,
    });
    res.json({ override: row });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "override" });
  }
});

router.post("/office/payroll/adjustments", (req, res) => {
  const director = requireOfficeDirector(req, res);
  if (!director) return;
  try {
    const accountId = String(req.body?.accountId || "");
    if (!listLocalPeople().some((p) => p.id === accountId)) {
      res.status(404).json({ error: "person" });
      return;
    }
    const kindRaw = String(req.body?.kind || "");
    const kind =
      kindRaw === "bonus" || kindRaw === "deduct" || kindRaw === "other"
        ? kindRaw
        : undefined;
    const row = addAdjustment({
      accountId,
      month: String(req.body?.month || monthParam(undefined)),
      amount: Number(req.body?.amount),
      note: req.body?.note != null ? String(req.body.note) : undefined,
      kind,
      createdBy: director.login,
    });
    res.status(201).json({ adjustment: row });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "adjustment" });
  }
});

router.delete("/office/payroll/adjustments/:id", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    res.json(deleteAdjustment(String(req.params.id)));
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "adjustment" });
  }
});

export default router;
