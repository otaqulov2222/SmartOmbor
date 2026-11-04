import app from "./app";
import { ensureCatalogBootstrapped, startCatalogKeepalive } from "./lib/catalog";
import { logger } from "./lib/logger";
import { hydrateOffice } from "./lib/office";
import { hydratePartners } from "./lib/partners";
import { hydrateLocalAccounts } from "./routes/local-auth";
import { resumePendingSupplies } from "./routes/partners";
import { sendIdlePreview, sendPreview, startTelegramDigest } from "./lib/telegram";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

if (process.argv.includes("--telegram-preview")) {
  sendPreview()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
} else if (process.argv.includes("--telegram-idle")) {
  sendIdlePreview()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
} else {
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // Listen dan keyin: disk katalog + partners parallel — UI bo‘sh qolmasin.
  void Promise.all([
    ensureCatalogBootstrapped(),
    hydrateLocalAccounts(),
    hydrateOffice(),
    hydratePartners()
      .then(() => {
        resumePendingSupplies();
      })
      .catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : "partner-store" }, "Partner database was not loaded");
      }),
  ]).finally(() => {
    startCatalogKeepalive();
  });
  startTelegramDigest();
});
}
