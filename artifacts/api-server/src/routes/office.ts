import { Router, type IRouter } from "express";
import { listLocalPeople, requireLocalUser, requireOfficeDirector } from "./local-auth";
import {
  currentQrToken,
  enrollFace,
  faceEnrolled,
  fiksaOf,
  insideOffice,
  officeDistance,
  officeSite,
  punch,
  punchesFor,
  rangeDays,
  setOfficeSite,
  setTabelMark,
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
    clock: now.clock,
    date: now.date,
    face: faceEnrolled(user.id),
    today: punchView(todayPunch(user.id)),
    fiksa: fiksaOf(user.id),
  });
});

router.post("/office/site", (req, res) => {
  if (!requireOfficeDirector(req, res)) return;
  try {
    const site = setOfficeSite({
      lat: Number(req.body?.lat),
      lng: Number(req.body?.lng),
      radiusM: req.body?.radiusM != null ? Number(req.body.radiusM) : undefined,
      accuracyM: req.body?.accuracyM != null ? Number(req.body.accuracyM) : undefined,
      name: req.body?.name != null ? String(req.body.name) : undefined,
      start: req.body?.start != null ? String(req.body.start) : undefined,
      end: req.body?.end != null ? String(req.body.end) : undefined,
    });
    res.json({ office: site });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: number }).status) : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : "site" });
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
      : [String(req.body?.hash ?? "")];
    enrollFace(user.id, hashes);
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
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = Number(req.body?.accuracy);
  try {
    const faceHashes = Array.isArray(req.body?.faceHashes)
      ? req.body.faceHashes.map((item: unknown) => String(item ?? ""))
      : undefined;
    const row = punch({
      accountId: user.id,
      kind,
      method,
      lat,
      lng,
      accuracy,
      faceHash: String(req.body?.faceHash ?? ""),
      faceHashes,
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

export default router;
