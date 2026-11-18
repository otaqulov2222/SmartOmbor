import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSalesSummaryReply,
  formatKpiAgentsReply,
  formatStaffListReply,
  isKpiAgentsIntent,
  isSalesSummaryIntent,
  isStaffListIntent,
  kpiFollowupReply,
  localizeUzbekReply,
  parseDaysWindow,
  portalLinksReply,
  resolveSalesDays,
  roleLabelUz,
  sanitizeAssistantReply,
  looksLikeFakeKpiDownload,
  stripFakeDownloadLinks,
  wantsDailyAverage,
  wantsPortalLink,
  wantsVagueGive,
} from "../src/lib/assistant-ux.ts";

describe("roleLabelUz", () => {
  it("inglizcha rollarni o‘zbekchaga o‘giradi", () => {
    assert.equal(roleLabelUz("warehouse_staff"), "Ombor xodimi");
    assert.equal(roleLabelUz("agent"), "Savdo agenti");
    assert.equal(roleLabelUz("worker"), "Ofis xodimi");
    assert.equal(roleLabelUz("accountant"), "Bugalter");
    assert.equal(roleLabelUz("marketolog"), "Marketolog");
    assert.equal(roleLabelUz("kassir"), "Kassir");
  });

  it("bo‘sh rollarni Xodim qiladi", () => {
    assert.equal(roleLabelUz(""), "Xodim");
    assert.equal(roleLabelUz(null), "Xodim");
  });
});

describe("parseDaysWindow / resolveSalesDays", () => {
  it("bir oylik → 30 kun (oylik so‘zini ushlaydi)", () => {
    assert.equal(parseDaysWindow("bir oylik kunlik ortacha savdo"), 30);
    assert.equal(resolveSalesDays("bir oylik kunlik ortacha savdo qancha"), 30);
  });

  it("hafta → 7", () => {
    assert.equal(resolveSalesDays("shu hafta savdo"), 7);
  });

  it("bugun → 1", () => {
    assert.equal(resolveSalesDays("bugungi savdo qancha"), 1);
  });

  it("o‘rtacha so‘ralganda default 30 (7 emas)", () => {
    assert.equal(resolveSalesDays("kunlik ortacha savdo qancha"), 30);
  });
});

describe("wantsDailyAverage + sales reply", () => {
  it("ortacha so‘rovini aniqlaydi", () => {
    assert.equal(wantsDailyAverage("bir oylik kunlik ortacha savdo qancha"), true);
    assert.equal(wantsDailyAverage("o‘rtacha savdo"), true);
    assert.equal(isSalesSummaryIntent("bir oylik kunlik ortacha savdo qancha"), true);
  });

  it("o‘rtacha javobida jami emas, kunlik o‘rtacha chiqadi", () => {
    const reply = buildSalesSummaryReply({
      lower: "bir oylik kunlik ortacha savdo qancha",
      days: 30,
      from: "2026-10-19",
      to: "2026-11-18",
      salesAmount: 1_249_855_342,
      salesQty: 36157,
    });
    assert.match(reply, /Kunlik o['‘`]?rtacha/i);
    assert.match(reply, /so‘m\/kun|so'm\/kun/);
    assert.match(reply, /Jami summa/);
    assert.doesNotMatch(reply, /^Oxirgi 7 kun/);
    assert.ok(!reply.startsWith("Oxirgi 7 kun"));
  });

  it("oddiy savdo so‘rovida ham kunlik o‘rtacha qo‘shimcha chiqadi", () => {
    const reply = buildSalesSummaryReply({
      lower: "oxirgi 30 kun savdo",
      days: 30,
      from: "a",
      to: "b",
      salesAmount: 300_000,
      salesQty: 30,
    });
    assert.match(reply, /Summa:/);
    assert.match(reply, /Kunlik o['‘`]?rtacha/);
  });
});

describe("portal links", () => {
  it("xodimlar qaysi link — portal intent", () => {
    assert.equal(wantsPortalLink("xodimlar qaysi link orqali kiradi"), true);
    assert.equal(wantsPortalLink("qayerdan kirish mumkin"), true);
    assert.equal(isStaffListIntent("xodimlar qaysi link orqali kiradi"), false);
  });

  it("to‘liq havolalar beradi", () => {
    const reply = portalLinksReply({ PUBLIC_APP_URL: "https://smartombor.uz" });
    assert.match(reply, /https:\/\/smartombor\.uz\//);
    assert.match(reply, /https:\/\/smartombor\.uz\/agent/);
    assert.match(reply, /https:\/\/smartombor\.uz\/zavod/);
    assert.ok(reply.includes("Asosiy tizim"));
    assert.ok(!/Xodimlar SmartOmbor portaliga quyidagi\s*$/.test(reply));
  });
});

describe("staff list formatting", () => {
  it("inglizcha role chiqarmaydi", () => {
    const reply = formatStaffListReply([
      { name: "Gayrat", login: "gayrat0748", role: "warehouse_staff" },
      { name: "Muzaffar", login: "muzaffar", role: "agent" },
    ]);
    assert.match(reply, /Ombor xodimi/);
    assert.match(reply, /Savdo agenti/);
    assert.doesNotMatch(reply, /warehouse_staff/);
    assert.match(reply, /\/agent/);
  });
});

describe("localize + sanitize", () => {
  it("warehouse_staff ni o‘zbekchaga aylantiradi", () => {
    assert.match(localizeUzbekReply("Gayrat (warehouse_staff)"), /Ombor xodimi/);
  });

  it("Javohir — agent ni Savdo agentiga aylantiradi", () => {
    assert.match(localizeUzbekReply("• Javohir — agent"), /Savdo agenti/);
  });

  it("/agent URL ni buzmaydi", () => {
    const out = sanitizeAssistantReply("Kirish: /agent va https://demo.uz/agent");
    assert.match(out, /\/agent/);
    assert.match(out, /https:\/\/demo\.uz\/agent/);
  });

  it("portal jadvalini o‘chirmaydi", () => {
    const table = [
      "| Portal | Havola |",
      "| --- | --- |",
      "| Agent | /agent |",
      "| Login | https://x.uz/ |",
      "| Zavod | /zavod |",
      "| Extra | note |",
    ].join("\n");
    const out = sanitizeAssistantReply(table);
    assert.match(out, /\/agent/);
    assert.match(out, /https:\/\/x\.uz\//);
  });

  it("soxta KPI yuklab olish havolasini olib tashlaydi", () => {
    const fake = "KPI ma'lumotlarini PDF shaklida yuklab olish uchun quyidagi havolani bosing: [KPI hisobotini yuklab olish]";
    const out = sanitizeAssistantReply(fake);
    assert.doesNotMatch(out, /\[KPI hisobotini yuklab olish\]/);
    assert.doesNotMatch(out, /\*{2,}/);
    assert.match(out, /Dashboard → KPI/);
  });

  it("**** qolgan soxta PDF javobini to‘liq almashtiradi", () => {
    const fake = "KPI ma’lumotlarini PDF shaklida yuklab olish uchun ****\nAgar boshqa format (Excel/CSV) kerak bo‘lsa, xabar bering.";
    assert.equal(looksLikeFakeKpiDownload(fake), true);
    const out = sanitizeAssistantReply(fake);
    assert.equal(out, kpiFollowupReply());
    assert.doesNotMatch(out, /\*{2,}|PDF shaklida/);
  });
});

describe("KPI follow-ups", () => {
  it("kere ber ni vague give deb biladi", () => {
    assert.equal(wantsVagueGive("kere ber"), true);
    assert.equal(wantsVagueGive("yuklab ber"), true);
  });

  it("KPI agentlar intent", () => {
    assert.equal(isKpiAgentsIntent("bugungi kunga kpi yozilgan agentlar"), true);
  });

  it("KPI agentlar javobida inglizcha agent yo‘q", () => {
    const reply = formatKpiAgentsReply(
      [{ name: "Javohir", login: "javohir", role: "agent" }],
      "2026-11-18",
    );
    assert.match(reply, /Savdo agenti/);
    assert.doesNotMatch(reply, /— agent$/m);
    assert.match(reply, /Dashboard → KPI/);
  });

  it("kpiFollowupReply soxta havola bermaydi", () => {
    const reply = kpiFollowupReply();
    assert.doesNotMatch(reply, /\[.*yuklab/);
    assert.match(reply, /Dashboard → KPI/);
  });

  it("stripFakeDownloadLinks ishlaydi", () => {
    const out = stripFakeDownloadLinks("Bosing: [yuklab olish](http://fake)");
    assert.doesNotMatch(out, /\[yuklab olish\]/);
  });
});
