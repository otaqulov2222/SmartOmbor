/**
 * Bordo identity regression: zavod / guruh / tovar / razmer / artikul.
 * Run: node scripts/bordo-identity-check.mjs
 */
import * as esbuild from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dir = mkdtempSync(path.join(tmpdir(), "bordo-id-"));
const stub = path.join(dir, "logger-stub.js");
writeFileSync(stub, "module.exports = { logger: { info(){}, warn(){}, error(){}, debug(){} } };\n");
const outfile = path.join(dir, "catalog.cjs");
await esbuild.build({
  entryPoints: [path.join(root, "src/lib/catalog.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  plugins: [{ name: "stub-logger", setup(b) { b.onResolve({ filter: /[/\\]logger(\.ts)?$/ }, () => ({ path: stub })); } }],
});
const mod = require(outfile);
const {
  parseBordoName,
  bordoParentName,
  sanitizeMoySkladArticle,
  bordoIdentityArticle,
  matchWaybillProduct,
  sameBordoCard,
} = mod;

let failed = 0;
const check = (n, ok) => {
  if (!ok) {
    failed += 1;
    console.log("FAIL", n);
  } else console.log("OK  ", n);
};

const p = parseBordoName("Bordo 0044 1020 289 36-40");
check("zavod", p?.factoryCode === "0044");
check("guruh", p?.groupCode === "1020");
check("tovar", p?.productCode === "289");
check("razmer", p?.size === "36-40");
check("artikul empty", !p?.article);

const old = parseBordoName("Bordo 0007 1020 2522 24-29 43937");
check("43937 artikul alohida", old?.article === "43937" && old?.productCode === "2522");

check("sanitize drop tovar", !sanitizeMoySkladArticle("289", { productCode: "289", groupCode: "1020", factoryCode: "0044", size: "36-40" }));
check("sanitize drop guruh", !sanitizeMoySkladArticle("1020", { productCode: "289", groupCode: "1020", factoryCode: "0044", size: "36-40" }));
check("sanitize keep 43937", sanitizeMoySkladArticle("43937", { productCode: "2522", groupCode: "1020", factoryCode: "0007", size: "24-29" }) === "43937");
check("parent name", bordoParentName({ factoryCode: "0044", groupCode: "1020", productCode: "289", size: "36-40", article: "289" }) === "Bordo 0044 1020 289 36-40");
check("identity ignores article=tovar", !bordoIdentityArticle("Bordo 0044 1020 289 36-40", "289", "289"));
check("sameCard with poisoned ms article", sameBordoCard("Bordo 0044 1020 289 36-40", {
  factoryCode: "0044", productCode: "289", size: "36-40", groupCode: "1020", article: "",
}, { article: "289" }));
check("sameCard ignores barcode-like ms article", sameBordoCard("Bordo 0035 1020 B 708 36-40", {
  factoryCode: "0035", productCode: "B 708", size: "36-40", groupCode: "1020", article: "",
}, { article: "036960390307" }));
check("identity article only from name", !bordoIdentityArticle("Bordo 0035 1020 B 708 36-40", "036960390307", "B 708"));
check("sameCard rejects real trailing article", !sameBordoCard("Bordo 0044 1020 289 36-40 43937", {
  factoryCode: "0044", productCode: "289", size: "36-40", groupCode: "1020", article: "",
}, { article: "43937" }));

const catalog = {
  products: [
    { id: "dup", name: "Bordo 0044 1020 289 36-40", article: "289", barcodes: [], factory: "Sandos. 0044", category: null, unit: null, packType: null, packSize: 1, imageUrl: null, stock: 6, available: 6, cost: 30000, salePrice: 33000, lastSale: null, lastReceipt: null, sales7: 0, sales30: 0, sales60: 0, sales90: 0, daysCover: null, stockStatus: "healthy", inTransit: 0, code: "1284365968" },
    { id: "good", name: "Bordo 0044 1020 289 36-40", article: null, barcodes: [], factory: "Sandos. 0044", category: null, unit: null, packType: null, packSize: 1, imageUrl: null, stock: 120, available: 120, cost: 30000, salePrice: 33000, lastSale: null, lastReceipt: null, sales7: 0, sales30: 0, sales60: 0, sales90: 0, daysCover: null, stockStatus: "healthy", inTransit: 0, code: "936489557872" },
    { id: "a43937", name: "Bordo 0007 1020 2522 24-29 43937", article: "43937", barcodes: [], factory: "Arfa 0007", category: null, unit: null, packType: null, packSize: 1, imageUrl: null, stock: 10, available: 10, cost: 1, salePrice: null, lastSale: null, lastReceipt: null, sales7: 0, sales30: 0, sales60: 0, sales90: 0, daysCover: null, stockStatus: "healthy", inTransit: 0, code: "027371" },
    { id: "plain", name: "Bordo 0007 1020 2522 24-29", article: null, barcodes: [], factory: "Arfa 0007", category: null, unit: null, packType: null, packSize: 1, imageUrl: null, stock: 0, available: 0, cost: null, salePrice: null, lastSale: null, lastReceipt: null, sales7: 0, sales30: 0, sales60: 0, sales90: 0, daysCover: null, stockStatus: "out", inTransit: 0, code: "1284365516" },
  ],
  stockRows: [], warehouses: [], imageHrefs: new Map(), productCount: 4, loadedAt: new Date().toISOString(), pendingTransfers: 0, salesToday: 0, incomingToday: 0,
};

check("289 → good twin", matchWaybillProduct(catalog, { factoryCode: "0044", factoryName: "Sandos. 0044", productCode: "289", size: "36-40", groupCode: "1020" })?.id === "good");
check("2522 → plain not 43937", matchWaybillProduct(catalog, { factoryCode: "0007", factoryName: "Arfa 0007", productCode: "2522", size: "24-29", groupCode: "1020" })?.id === "plain");
check("2522+43937 → old", matchWaybillProduct(catalog, { factoryCode: "0007", factoryName: "Arfa 0007", productCode: "2522", size: "24-29", groupCode: "1020", article: "43937" })?.id === "a43937");

rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log(`\nFAILED ${failed}`);
  process.exit(1);
}
console.log("\nALL OK");
