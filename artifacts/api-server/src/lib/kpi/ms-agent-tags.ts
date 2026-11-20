/**
 * Agent ↔ MoySklad teg nomlari.
 * Seed agentlar uchun PRIMARY/ALIAS; yangi agentlar: msTag → login → ism.
 */

/** Login → asosiy MS teg (probe qilmasdan). */
export const PRIMARY_TAG: Record<string, string> = {
  shaxzod: "шахзод",
  oysha: "oisha",
  farzona: "farzona",
  elyor: "elyor",
  abbos: "abbos",
  baxodir: "боходир",
  muzaffar: "музаффар",
  avliyo: "avliyo",
  gulzoda: "gulzoda",
  nafisa: "nafisa",
  nozim: "nozim",
  abdugani: "abdugani",
  farxodaka: "farxodaka",
  sevinch: "sevinch",
};

export const AGENT_TAG_ALIASES: Record<string, string[]> = {
  shaxzod: ["шахзод", "shaxzod"],
  oysha: ["oisha", "oysha", "ойша"],
  farzona: ["farzona"],
  elyor: ["elyor"],
  abbos: ["abbos"],
  baxodir: ["боходир", "baxodir", "баходир"],
  muzaffar: ["музаффар", "muzaffar"],
  avliyo: ["avliyo"],
  gulzoda: ["gulzoda"],
  nafisa: ["nafisa"],
  nozim: ["nozim"],
  abdugani: ["abdugani", "abdug'ani"],
  farxodaka: ["farxodaka", "farxod aka"],
  sevinch: ["sevinch"],
};

export function foldTagName(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeMsTag(raw: unknown): string {
  return foldTagName(String(raw || "")).slice(0, 64);
}

/** Probe tartibi: aniq msTag → PRIMARY → aliaslar → login/ism variantlari. */
export function tagCandidatesForAgent(input: {
  login: string;
  fullName?: string;
  msTag?: string;
}): string[] {
  const login = foldTagName(input.login);
  const fullName = foldTagName(input.fullName || "");
  const compactName = fullName.replace(/[^a-z0-9а-яё]+/gi, "");
  const msTag = normalizeMsTag(input.msTag);
  const primary = PRIMARY_TAG[login];
  const fromMap = AGENT_TAG_ALIASES[login] || [];
  return [
    ...new Set(
      [msTag, primary, ...fromMap, login, fullName, compactName]
        .map(foldTagName)
        .filter(Boolean),
    ),
  ];
}
