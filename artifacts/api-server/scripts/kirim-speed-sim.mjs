/**
 * Kirim tezligi simulyatsiyasi — MoySkladga haqiqiy so‘rov yubormaydi.
 * Eski vs yangi yo‘l: taxminiy API chaqiruvlari va latency.
 *
 * Taxmin: MoySklad bitta so‘rov ~250ms (o‘rtacha).
 */

const LINE_COUNT = 15; // ekrandagi tipik yuk xati
const NEW_PRODUCTS = 12; // katalogda yo‘q
const EXISTING = LINE_COUNT - NEW_PRODUCTS;
const MS_PER_CALL = 250;
const CREATE_POOL = 8;

function oldPathCalls() {
  // Har yangi qator: findExisting = productByName(filter+search*N) + code search ≈ 6 GET
  // + createProduct ichida yana productByName ≈ 6 GET + 1 POST
  // + write stamp 1 PUT
  // + agent search 4 + existing supply 1 + org 2
  const findPerNew = 6;
  const createLookup = 6;
  const createPost = 1;
  const stamp = 1;
  const agentSearch = 4;
  const existing = 1;
  const org = 2;
  const folders = 2;
  const supplyPost = 1;
  const align = 1;
  const ensureAgent = 2;

  const sequentialCreates = NEW_PRODUCTS * (findPerNew + createLookup + createPost + stamp);
  const fixed = agentSearch + existing + org + folders + supplyPost + align + ensureAgent;
  const existingFinds = EXISTING * 2; // catalog miss then remote
  const total = sequentialCreates + fixed + existingFinds;
  // eski: create ketma-ket
  const wallMs = (EXISTING * 2 + NEW_PRODUCTS * (findPerNew + createLookup + createPost + stamp) + fixed) * MS_PER_CALL;
  return { total, wallMs, note: "sequential create + double lookup + stamp await" };
}

function newPathCalls() {
  // find: catalog only (0 remote for new)
  // create: skipLookup → 1 POST each, pool=8
  // stamp: fire-and-forget (0 on critical path)
  // agent: id meta (0 GET if hint)
  // existing supply 1, org 2 (cached later 0), folders 1, supply 1
  const createPosts = NEW_PRODUCTS;
  const fixed = 1 + 2 + 1 + 1; // existing + org + folders + supply
  const total = createPosts + fixed;
  const createBatches = Math.ceil(NEW_PRODUCTS / CREATE_POOL);
  const wallMs = (createBatches * MS_PER_CALL) + fixed * MS_PER_CALL;
  return { total, wallMs, note: "catalog find, skipLookup create pool=8, deferred stamp, agent-from-id" };
}

const old = oldPathCalls();
const neu = newPathCalls();

const report = {
  scenario: { LINE_COUNT, NEW_PRODUCTS, EXISTING, MS_PER_CALL, CREATE_POOL },
  old,
  new: neu,
  speedup: `${(old.wallMs / neu.wallMs).toFixed(1)}x`,
  oldSec: (old.wallMs / 1000).toFixed(1),
  newSec: (neu.wallMs / 1000).toFixed(1),
  pass: neu.wallMs < 15_000 && neu.wallMs < old.wallMs / 3,
};

console.log(JSON.stringify(report, null, 2));
if (!report.pass) {
  console.error("FAIL: yangi yo‘l hali ham sekin");
  process.exit(1);
}
console.log("PASS: yangi yo‘l kritik path sezilarli tez");
