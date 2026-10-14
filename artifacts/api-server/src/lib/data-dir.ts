import path from "node:path";

export function dataDir() {
  const custom = process.env.DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  return path.resolve(process.cwd(), "artifacts/api-server/data");
}

export function dataFile(name: string) {
  return path.join(dataDir(), name);
}
