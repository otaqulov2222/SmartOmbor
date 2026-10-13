import { Router, type IRouter, type Request } from "express";
import {
  GetCurrentUserResponse,
  GetDashboardResponse,
  GetMoyskladStatusResponse,
  GetNonMovingProductsQueryParams,
  GetNonMovingProductsResponse,
  GetPurchaseRecommendationsQueryParams,
  GetPurchaseRecommendationsResponse,
  GetSalesAnalyticsQueryParams,
  GetSalesAnalyticsResponse,
  ListDocumentsQueryParams,
  ListDocumentsResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  ListStockQueryParams,
  ListStockResponse,
  ListWarehousesResponse,
  LookupBarcodeParams,
  LookupBarcodeResponse,
  SyncMoyskladResponse,
} from "@workspace/api-zod";
import { catalogLoadedAt, findProductsByBarcode, loadCatalog, resolveScan, type CatalogProduct } from "../lib/catalog";
import { moysklad, moyskladAll, moyskladBinary, moyskladConfigured, money, MoySkladError } from "../lib/moysklad";

const router: IRouter = Router();

function numericQuery(query: Request["query"], keys: string[]) {
  const next: Record<string, unknown> = { ...query };
  for (const key of keys) {
    const value = next[key];
    if (typeof value === "string" && value !== "") next[key] = Number(value);
  }
  return next;
}

function fail(error: unknown): { status: number; message: string } {
  if (error instanceof MoySkladError) return { status: error.status || 502, message: error.message };
  if (error instanceof Error) return { status: 500, message: error.message };
  return { status: 500, message: "Unexpected error" };
}

router.get("/me", (_req, res) => {
  res.json(
    GetCurrentUserResponse.parse({
      id: "local",
      name: "Administrator",
      email: "local@smart-ombor",
      role: "super_admin",
    }),
  );
});

router.get("/moysklad/status", async (_req, res) => {
  if (!moyskladConfigured()) {
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: false,
        connected: false,
        companyName: null,
        lastSync: catalogLoadedAt(),
        error: "MOYSKLAD_TOKEN topilmadi",
      }),
    );
    return;
  }

  try {
    const catalog = await loadCatalog();
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: true,
        connected: true,
        companyName: catalog.companyName,
        lastSync: catalog.loadedAt,
        error: catalog.error,
      }),
    );
  } catch (error) {
    const problem = fail(error);
    res.json(
      GetMoyskladStatusResponse.parse({
        configured: true,
        connected: false,
        companyName: null,
        lastSync: catalogLoadedAt(),
        error: problem.message,
      }),
    );
  }
});

router.post("/moysklad/sync", async (_req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const catalog = await loadCatalog(true);
    res.json(
      SyncMoyskladResponse.parse({
        id: crypto.randomUUID(),
        status: "completed",
        startedAt,
        finishedAt: catalog.loadedAt,
        productCount: catalog.productCount,
        warehouseCount: catalog.warehouses.length,
        error: null,
      }),
    );
  } catch (error) {
    const problem = fail(error);
    res.status(problem.status).json(
      SyncMoyskladResponse.parse({
        id: crypto.randomUUID(),
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        productCount: 0,
        warehouseCount: 0,
        error: problem.message,
      }),
    );
  }
});

router.get("/dashboard", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const products = catalog.products;
    res.json(
      GetDashboardResponse.parse({
        productCount: catalog.productCount,
        stockUnits: products.reduce((sum, product) => sum + product.stock, 0),
        stockValue: products.reduce((sum, product) => sum + (product.cost ?? 0) * product.stock, 0),
        lowStockCount: products.filter((product) => product.stockStatus === "low").length,
        nonMovingCount: products.filter((product) => product.stockStatus === "non_moving").length,
        expiringCount: 0,
        pendingTransfers: catalog.pendingTransfers,
        salesToday: catalog.salesToday,
        incomingToday: catalog.incomingToday,
        lastSync: catalog.loadedAt,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard/warehouses", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const totals = new Map<string, { id: string; name: string; units: number; products: number; inTransit: number; value: number }>();
    for (const warehouse of catalog.warehouses) {
      totals.set(warehouse.id, { id: warehouse.id, name: warehouse.name, units: 0, products: 0, inTransit: 0, value: 0 });
    }
    for (const row of catalog.stockRows) {
      const entry = totals.get(row.warehouse.id) ?? { id: row.warehouse.id, name: row.warehouse.name, units: 0, products: 0, inTransit: 0, value: 0 };
      entry.units += row.quantity;
      entry.inTransit += row.inTransit;
      entry.value += row.value ?? 0;
      if (row.quantity > 0) entry.products += 1;
      totals.set(entry.id, entry);
    }
    res.json([...totals.values()].sort((a, b) => b.units - a.units));
  } catch (error) {
    next(error);
  }
});

router.get("/warehouses", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    res.json(ListWarehousesResponse.parse(catalog.warehouses));
  } catch (error) {
    next(error);
  }
});

function matchesSearch(product: CatalogProduct, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [product.name, product.code, product.article, product.category, product.factory, ...product.barcodes]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

router.get("/products", async (req, res, next) => {
  try {
    const query = ListProductsQueryParams.parse(numericQuery(req.query, ["idleDays", "page", "pageSize"]));
    const catalog = await loadCatalog();
    let items = catalog.products.filter((product) => matchesSearch(product, query.search ?? ""));
    if (query.factory) items = items.filter((product) => product.factory === query.factory);
    if (query.category) items = items.filter((product) => product.category === query.category);
    if (query.warehouseId) {
      const ids = new Set(
        catalog.stockRows.filter((row) => row.warehouse.id === query.warehouseId).map((row) => row.product.id),
      );
      items = items.filter((product) => ids.has(product.id));
    }
    if (query.stockStatus === "low") items = items.filter((product) => product.stockStatus === "low");
    if (query.stockStatus === "available") items = items.filter((product) => product.stock > 0);
    if (query.stockStatus === "out") items = items.filter((product) => product.stockStatus === "out");
    if (query.idleDays) {
      items = items.filter((product) => (product.daysCover ?? 0) >= query.idleDays!);
    }
    const start = (query.page - 1) * query.pageSize;
    res.json(
      ListProductsResponse.parse({
        items: items.slice(start, start + query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: items.length,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/products/:id/image", async (req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const href = catalog.imageHrefs.get(String(req.params.id));
    if (!href) {
      res.status(404).end();
      return;
    }
    const target = req.query.size === "mini"
      ? `${href}${href.includes("?") ? "&" : "?"}miniature=true`
      : href;
    const image = await moyskladBinary(target);
    res.setHeader("Content-Type", image.type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(image.body);
  } catch (error) {
    next(error);
  }
});

router.get("/products/resolve", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const text = typeof req.query.text === "string" ? req.query.text : "";
    const catalog = await loadCatalog();
    const resolved = resolveScan(catalog, code, text);
    const ids = new Set(resolved.products.map((product) => product.id));
    const locations = catalog.stockRows
      .filter((row) => ids.has(row.product.id))
      .map((row) => ({
        productId: row.product.id,
        warehouseName: row.warehouse.name,
        quantity: row.quantity,
        inTransit: row.inTransit,
      }))
      .sort((a, b) => b.quantity - a.quantity);
    res.json(LookupBarcodeResponse.parse({
      barcode: resolved.barcode,
      ambiguous: resolved.products.length > 1,
      products: resolved.products,
      locations,
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/products/barcode/:barcode", async (req, res, next) => {
  try {
    const { barcode } = LookupBarcodeParams.parse(req.params);
    const catalog = await loadCatalog();
    const products = findProductsByBarcode(catalog, barcode);
    const ids = new Set(products.map((product) => product.id));
    const locations = catalog.stockRows
      .filter((row) => ids.has(row.product.id))
      .map((row) => ({
        productId: row.product.id,
        warehouseName: row.warehouse.name,
        quantity: row.quantity,
        inTransit: row.inTransit,
      }))
      .sort((a, b) => b.quantity - a.quantity);
    res.json(LookupBarcodeResponse.parse({ barcode, ambiguous: products.length > 1, products, locations }));
  } catch (error) {
    next(error);
  }
});

router.get("/stock", async (req, res, next) => {
  try {
    const query = ListStockQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    let items = catalog.stockRows;
    if (query.warehouseId) items = items.filter((row) => row.warehouse.id === query.warehouseId);
    if (query.search) items = items.filter((row) => matchesSearch(row.product, query.search ?? ""));
    const start = (query.page - 1) * query.pageSize;
    res.json(
      ListStockResponse.parse({
        items: items.slice(start, start + query.pageSize),
        page: query.page,
        pageSize: query.pageSize,
        total: items.length,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/documents", async (req, res, next) => {
  try {
    const query = ListDocumentsQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    let items = catalog.documents;
    if (query.kind && query.kind !== "all") items = items.filter((item) => item.kind === query.kind);
    if (query.status) items = items.filter((item) => item.status === query.status);
    res.json(ListDocumentsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/non-moving", async (req, res, next) => {
  try {
    const query = GetNonMovingProductsQueryParams.parse(numericQuery(req.query, ["days"]));
    const catalog = await loadCatalog();
    const items = query.warehouseId
      ? [...new Map(
          catalog.stockRows
            .filter((row) => row.warehouse.id === query.warehouseId && row.quantity > 0 && (row.product.daysCover ?? 0) >= query.days)
            .map((row) => [row.product.id, row.product] as const),
        ).values()]
      : catalog.products.filter(
          (product) => product.stock > 0 && (product.daysCover ?? 0) >= query.days,
        );
    res.json(GetNonMovingProductsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

router.get("/catalog/factories", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    const grouped = new Map<string, { name: string; count: number; stock: number; products: Array<{ id: string; name: string; code: string | null; stock: number; imageUrl: string | null }> }>();
    for (const product of catalog.products) {
      const name = product.factory?.trim() || "";
      const current = grouped.get(name) ?? { name, count: 0, stock: 0, products: [] };
      current.count += 1;
      current.stock += product.stock;
      if (current.products.length < 8) {
        current.products.push({ id: product.id, name: product.name, code: product.code, stock: product.stock, imageUrl: product.imageUrl });
      }
      grouped.set(name, current);
    }
    res.json({ items: [...grouped.values()].sort((a, b) => b.stock - a.stock || b.count - a.count) });
  } catch (error) {
    next(error);
  }
});

router.get("/analytics/recommendations", async (req, res, next) => {
  try {
    const query = GetPurchaseRecommendationsQueryParams.parse(req.query);
    const catalog = await loadCatalog();
    const scoped = query.warehouseId
      ? catalog.stockRows
          .filter((row) => row.warehouse.id === query.warehouseId && row.quantity <= 3)
          .map((row) => ({ product: row.product, onHand: row.quantity, inTransit: row.inTransit, warehouseId: row.warehouse.id }))
      : catalog.products
          .filter((product) => product.stockStatus === "low" || product.stockStatus === "out")
          .map((product) => ({ product, onHand: product.stock, inTransit: product.inTransit, warehouseId: catalog.warehouses[0]?.id ?? "all" }));
    const items = scoped.slice(0, 50).map((row) => {
      const dailyAverage = Math.round((row.product.sales30 / 30) * 100) / 100;
      const target = Math.ceil(dailyAverage * 14);
      const suggested = Math.max(row.onHand <= 0 ? 1 : 0, target - row.onHand - row.inTransit);
      return {
        product: row.product,
        warehouseId: row.warehouseId,
        dailyAverage,
        leadTimeDays: 14,
        safetyStock: LOW_SUGGESTED,
        onHand: row.onHand,
        inTransit: row.inTransit,
        suggestedQuantity: suggested,
        reason: row.onHand <= 0 ? "out_of_stock" : "low_stock",
      };
    });
    res.json(GetPurchaseRecommendationsResponse.parse(items));
  } catch (error) {
    next(error);
  }
});

const LOW_SUGGESTED = 10;

router.get("/analytics/sales", async (req, res, next) => {
  try {
    const query = GetSalesAnalyticsQueryParams.parse(req.query);
    const days = query.period === "7d" ? 7 : query.period === "90d" ? 90 : query.period === "365d" ? 365 : 30;
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const momentFrom = `${from.toISOString().slice(0, 10)} 00:00:00`;
    const momentTo = `${new Date().toISOString().slice(0, 10)} 23:59:59`;
    const store = query.warehouseId
      ? `;store=https://api.moysklad.ru/api/remap/1.2/entity/store/${query.warehouseId}`
      : "";
    const filter = encodeURIComponent(`moment>=${momentFrom};moment<=${momentTo}${store}`);
    const profitFilter = store ? `&filter=${encodeURIComponent(store.slice(1))}` : "";
    const [demands, profit] = await Promise.all([
      moyskladAll<{ moment?: string; sum?: number; positions?: { meta?: { size?: number } } }>(
        `/entity/demand?order=moment,desc&filter=${filter}`,
      ),
      moyskladAll<{
        assortment?: { meta?: { href?: string }; name?: string; code?: string; article?: string };
        sellQuantity?: number;
        sellSum?: number;
      }>(
        `/report/profit/byproduct?momentFrom=${encodeURIComponent(momentFrom)}&momentTo=${encodeURIComponent(momentTo)}${profitFilter}`,
      ).catch(() => ({ rows: [], size: 0 })),
    ]);

    const byDay = new Map<string, { amount: number; quantity: number }>();
    for (let index = 0; index < days; index += 1) {
      const date = new Date(from);
      date.setDate(from.getDate() + index);
      byDay.set(date.toISOString().slice(0, 10), { amount: 0, quantity: 0 });
    }
    for (const row of demands.rows) {
      const date = (row.moment ?? "").slice(0, 10);
      const bucket = byDay.get(date);
      if (!bucket) continue;
      bucket.amount += money(row.sum) ?? 0;
      bucket.quantity += row.positions?.meta?.size ?? 0;
    }
    const trend = [...byDay.entries()].map(([date, value]) => ({ date, ...value }));
    const totalAmount = trend.reduce((sum, point) => sum + point.amount, 0);
    const ranked = [...profit.rows].sort((a, b) => (b.sellQuantity ?? 0) - (a.sellQuantity ?? 0));
    const totalQuantity = ranked.reduce((sum, row) => sum + (row.sellQuantity ?? 0), 0)
      || trend.reduce((sum, point) => sum + point.quantity, 0);
    const catalog = await loadCatalog();
    const topProducts = ranked.filter((row) => (row.sellQuantity ?? 0) > 0).slice(0, 8).map((row) => {
      const href = row.assortment?.meta?.href ?? "";
      const id = href.split("/").pop()?.split("?")[0] || row.assortment?.name || "product";
      const known = catalog?.products.find((product) => product.id === id);
      if (known) return { ...known, sales30: row.sellQuantity ?? known.sales30 };
      return {
        id,
        name: row.assortment?.name || "Mahsulot",
        code: row.assortment?.code || null,
        article: row.assortment?.article || null,
        barcodes: [],
        factory: null,
        category: null,
        unit: null,
        packType: null,
        packSize: 1,
        imageUrl: null,
        stock: 0,
        available: 0,
        cost: null,
        salePrice: money(row.sellSum),
        lastSale: null,
        lastReceipt: null,
        sales7: 0,
        sales30: row.sellQuantity ?? 0,
        sales60: 0,
        sales90: 0,
        daysCover: null,
        stockStatus: "healthy" as const,
      };
    });

    res.json(
      GetSalesAnalyticsResponse.parse({
        period: query.period,
        totalAmount,
        totalQuantity,
        averagePerDay: days ? totalAmount / days : 0,
        trend,
        topProducts,
      }),
    );
  } catch (error) {
    next(error);
  }
});

router.get("/export/catalog", async (_req, res, next) => {
  try {
    const catalog = await loadCatalog();
    res.json({
      companyName: catalog.companyName,
      loadedAt: catalog.loadedAt,
      productCount: catalog.productCount,
      salesToday: catalog.salesToday,
      incomingToday: catalog.incomingToday,
      pendingTransfers: catalog.pendingTransfers,
      products: catalog.products,
      warehouses: catalog.warehouses,
      documents: catalog.documents,
      stockRows: catalog.stockRows.map((row) => ({
        productId: row.product.id,
        warehouseId: row.warehouse.id,
        warehouseName: row.warehouse.name,
        warehouseCode: row.warehouse.code,
        quantity: row.quantity,
        inTransit: row.inTransit,
        value: row.value,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
