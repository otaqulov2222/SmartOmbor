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
};

const empty = (): WatchdogState => ({
  lastDigestStamp: null,
  lastDigestSlot: null,
  lastFingerprint: null,
  lastAlertAt: 0,
  lastPassAt: 0,
  lastOkAt: 0,
  issueSeen: {},
});

export function readWatchdogState(): WatchdogState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<WatchdogState>;
    return {
      ...empty(),
      ...parsed,
      issueSeen: parsed.issueSeen && typeof parsed.issueSeen === "object" ? parsed.issueSeen : {},
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
