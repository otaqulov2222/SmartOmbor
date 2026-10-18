import app from "./app";
import { loadCatalog } from "./lib/catalog";
import { logger } from "./lib/logger";
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
  void loadCatalog().catch((error: unknown) => {
    logger.warn({ err: error }, "Catalog cache was not warmed");
  });
  startTelegramDigest();
});
}
