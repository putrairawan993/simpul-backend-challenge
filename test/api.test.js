import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { PRODUCTS, WAREHOUSES } from '../src/data/seed.js';
import { parseHistoricalRecords } from '../src/lib/csv.js';
import { buildEtaModel } from '../src/services/eta.js';
import { createOrderStore } from '../src/services/order-store.js';
import { readFileSync } from 'node:fs';

const csvPath = fileURLToPath(new URL('../data/customer1-historical.csv', import.meta.url));
const etaModel = buildEtaModel({
  records: parseHistoricalRecords(readFileSync(csvPath, 'utf8')),
  warehouses: WAREHOUSES
});

const tempDir = mkdtempSync(join(tmpdir(), 'simpul-api-'));
const orderStore = createOrderStore(join(tempDir, 'orders.jsonl'));
const logger = { info() {}, error() {} };
const app = createApp({ products: PRODUCTS, warehouses: WAREHOUSES, etaModel, orderStore, logger });
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function postOrder(payload) {
  return fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test('health and reference endpoints respond', async () => {
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ok');

  const meta = await fetch(`${baseUrl}/api/meta`);
  const metaBody = await meta.json();
  assert.equal(metaBody.products.length, 5);
  assert.equal(metaBody.warehouses.length, 8);
  assert.equal(metaBody.customer.id, 'CUST-1');
  assert.equal(metaBody.cost_model.base_fee_idr, 25_000);

  const patterns = await fetch(`${baseUrl}/api/delivery-patterns`);
  const patternsBody = await patterns.json();
  assert.equal(patternsBody.record_count, 38);
  assert.ok(patternsBody.insights.length > 0);
});

test('POST /api/orders returns a decision and persists it', async () => {
  const response = await postOrder({
    items: [{ product_id: 'P001', quantity: 100 }],
    requested_at: '2026-10-19T03:00:00.000Z'
  });
  assert.equal(response.status, 201);
  assert.match(response.headers.get('location'), /^\/api\/orders\/ORD-/);

  const body = await response.json();
  assert.equal(body.status, 'fulfilled');
  assert.deepEqual(body.decision.warehouses_used, ['W01']);
  assert.equal(body.decision.total_cost_idr, 45_000);
  assert.match(body.order_id, /^ORD-/);

  const stored = await fetch(`${baseUrl}/api/orders/${body.order_id}`);
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.order_id, body.order_id);
  assert.equal(storedBody.request.items[0].quantity, 100);
});

test('duplicate lines are merged and reflected in the stored request', async () => {
  const response = await postOrder({
    items: [
      { product_id: 'P001', quantity: 50 },
      { product_id: 'P001', quantity: 50 }
    ],
    requested_at: '2026-10-19T03:00:00.000Z'
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.request.items.length, 1);
  assert.equal(body.request.items[0].quantity, 100);
});

test('invalid requests return structured 400 errors', async () => {
  const unknownProduct = await postOrder({ items: [{ product_id: 'P999', quantity: 1 }] });
  assert.equal(unknownProduct.status, 400);
  assert.equal((await unknownProduct.json()).error.code, 'UNKNOWN_PRODUCT');

  const emptyItems = await postOrder({ items: [] });
  assert.equal(emptyItems.status, 400);
  assert.equal((await emptyItems.json()).error.code, 'INVALID_ITEMS');

  const invalidQuantity = await postOrder({
    items: [{ product_id: 'P001', quantity: 0 }]
  });
  assert.equal(invalidQuantity.status, 400);
  assert.equal((await invalidQuantity.json()).error.code, 'INVALID_QUANTITY');

  const invalidTime = await postOrder({
    items: [{ product_id: 'P001', quantity: 1 }],
    requested_at: 'not-a-date'
  });
  assert.equal(invalidTime.status, 400);
  assert.equal((await invalidTime.json()).error.code, 'INVALID_REQUESTED_AT');
});

test('order history and unknown order handling work', async () => {
  const list = await fetch(`${baseUrl}/api/orders?limit=1`);
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.count, 1);
  assert.ok(listBody.total_recorded >= 2);

  const missing = await fetch(`${baseUrl}/api/orders/ORD-DOES-NOT-EXIST`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'ORDER_NOT_FOUND');
});

test('the static UI is served', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Warehouse allocator/);
});
