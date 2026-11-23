import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataFile } from "./data-dir";

const STATE_FILE = dataFile("supply-watchdog.json");

export type WatchdogState = {
  lastDigestStamp: string | null;
  lastDigestSlot: string | null;
  lastFingerprint: string | null;
  lastAlertAt: number;
  lastPassAt: number;
  lastOkAt: number;
  issueSeen: Record<string, number>;
  /** Telegramga yuborilgan oxirgi kirim-nazorati matni (HTML emas) */
  lastReportPlain: string | null;
  lastReportAt: number;
  lastReportWhen: string | null;
  lastScanned: number;
  lastFindingCount: number;
};

const empty = (): WatchdogState => ({
  lastDigestStamp: null,
  lastDigestSlot: null,
  lastFingerprint: null,
  lastAlertAt: 0,
  lastPassAt: 0,
  lastOkAt: 0,
  issueSeen: {},
  lastReportPlain: null,
  lastReportAt: 0,
  lastReportWhen: null,
  lastScanned: 0,
  lastFindingCount: 0,
});

export function readWatchdogState(): WatchdogState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<WatchdogState>;
    return {
      ...empty(),
      ...parsed,
      issueSeen: parsed.issueSeen && typeof parsed.issueSeen === "object" ? parsed.issueSeen : {},
      lastReportPlain: typeof parsed.lastReportPlain === "string" ? parsed.lastReportPlain : null,
      lastReportAt: Number(parsed.lastReportAt) || 0,
      lastReportWhen: typeof parsed.lastReportWhen === "string" ? parsed.lastReportWhen : null,
      lastScanned: Number(parsed.lastScanned) || 0,
      lastFindingCount: Number(parsed.lastFindingCount) || 0,
    };
  } catch {
    return empty();
  }
}

export function writeWatchdogState(state: WatchdogState) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

/** Yordamchi / Telegram: oxirgi kirim nazorati hisoboti. */
export function peekLastWatchdogReport(): {
  when: string | null;
  plain: string | null;
  at: number;
  scanned: number;
  findings: number;
} | null {
  const state = readWatchdogState();
  if (!state.lastReportPlain && !state.lastPassAt) return null;
  return {
    when: state.lastReportWhen,
    plain: state.lastReportPlain,
    at: state.lastReportAt || state.lastPassAt || 0,
    scanned: state.lastScanned,
    findings: state.lastFindingCount,
  };
}
