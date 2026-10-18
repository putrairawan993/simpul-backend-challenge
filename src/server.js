import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { SERVICE } from './config.js';
import { PRODUCTS, WAREHOUSES } from './data/seed.js';
import { loadEtaModelFromFile } from './services/eta.js';
import { createOrderStore } from './services/order-store.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(moduleDir, '..');
const csvPath = process.env.ETA_CSV_PATH || join(rootDir, 'data', 'customer1-historical.csv');
const dataDir = process.env.DATA_DIR || join(rootDir, 'var');
const ordersFile = process.env.ORDERS_FILE || join(dataDir, 'orders.jsonl');
const port = Number(process.env.PORT || 3000);

const etaModel = loadEtaModelFromFile(csvPath, WAREHOUSES);
const orderStore = createOrderStore(ordersFile);
const app = createApp({
  products: PRODUCTS,
  warehouses: WAREHOUSES,
  etaModel,
  orderStore
});

const server = app.listen(port, () => {
  console.log(`${SERVICE.name} v${SERVICE.version} listening on port ${port}`);
  console.log(`ETA source: ${csvPath}`);
  console.log(`Order log: ${ordersFile}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
