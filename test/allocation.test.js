import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COST_MODEL } from '../src/config.js';
import { PRODUCTS, WAREHOUSES } from '../src/data/seed.js';
import { parseHistoricalRecords } from '../src/lib/csv.js';
import { describeRequestedTime } from '../src/lib/time.js';
import { planOrder } from '../src/services/allocation.js';
import { buildEtaModel } from '../src/services/eta.js';

const csvPath = fileURLToPath(new URL('../data/customer1-historical.csv', import.meta.url));
const etaModel = buildEtaModel({
  records: parseHistoricalRecords(readFileSync(csvPath, 'utf8')),
  warehouses: WAREHOUSES
});

function plan(items, iso = '2026-10-19T03:00:00.000Z', warehouses = WAREHOUSES) {
  return planOrder({
    lines: items,
    products: PRODUCTS,
    warehouses,
    etaModel,
    requestedTime: describeRequestedTime(iso),
    costModel: COST_MODEL
  });
}

test('nearest warehouse with enough stock wins a simple order', () => {
  const result = plan([{ product_id: 'P001', quantity: 100 }]);
  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.decision.warehouses_used, ['W01']);
  assert.equal(result.decision.total_cost_idr, 45_000);
  assert.equal(result.allocations[0].items[0].quantity, 100);
  assert.equal(result.decision.explanation.search.method, 'exhaustive_warehouse_subsets');
  assert.ok(result.decision.explanation.alternatives.length > 0);
});

test('a single farther warehouse can beat a two-warehouse split', () => {
  const result = plan([{ product_id: 'P001', quantity: 250 }]);
  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.decision.warehouses_used, ['W03']);
  assert.equal(result.decision.total_cost_idr, 125_000);
});

test('cold-chain products exclude warehouses without a refrigerated van', () => {
  const result = plan([{ product_id: 'P002', quantity: 30 }]);
  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.decision.warehouses_used, ['W04']);
  assert.equal(result.decision.total_cost_idr, 160_000);
  assert.equal(result.allocations[0].cold_chain, true);
  assert.ok(
    result.decision.explanation.cold_chain_exclusions.some(
      (exclusion) => exclusion.warehouse_id === 'W02'
    )
  );
  assert.ok(
    result.decision.explanation.cold_chain_exclusions.some(
      (exclusion) => exclusion.warehouse_id === 'W06'
    )
  );
});

test('orders that exceed one warehouse stock are split', () => {
  const result = plan([{ product_id: 'P002', quantity: 65 }]);
  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.decision.warehouses_used, ['W04', 'W08']);
  assert.equal(result.decision.total_cost_idr, 815_000);
  assert.equal(result.decision.cost_breakdown.split_penalty_idr, 15_000);
  assert.equal(
    result.allocations.reduce((sum, allocation) => sum + allocation.quantity_total, 0),
    65
  );
});

test('partial orders allocate whatever is available and report the shortage', () => {
  const result = plan([{ product_id: 'P002', quantity: 120 }]);
  assert.equal(result.status, 'partial');
  assert.equal(result.unfulfilled.length, 1);
  assert.equal(result.unfulfilled[0].shortage_quantity, 12);
  assert.equal(result.unfulfilled[0].allocated_quantity, 108);
  assert.equal(result.decision.total_cost_idr, 1_050_000);
});

test('orders with no eligible stock are reported as unfulfillable', () => {
  const warehousesWithoutColdStock = WAREHOUSES.map((warehouse) => ({
    ...warehouse,
    stock: { ...warehouse.stock, P002: 0, P004: 0 }
  }));
  const result = plan([{ product_id: 'P002', quantity: 10 }], undefined, warehousesWithoutColdStock);
  assert.equal(result.status, 'unfulfillable');
  assert.equal(result.decision.total_cost_idr, 0);
  assert.equal(result.allocations.length, 0);
  assert.equal(result.unfulfilled[0].shortage_quantity, 10);
  assert.match(result.unfulfilled[0].reason, /cold-chain-capable/i);
});

test('duplicate order lines are merged before planning', () => {
  const result = plan([
    { product_id: 'P001', quantity: 50 },
    { product_id: 'P001', quantity: 50 }
  ]);
  assert.equal(result.status, 'fulfilled');
  assert.deepEqual(result.decision.warehouses_used, ['W01']);
  assert.equal(result.decision.total_cost_idr, 45_000);
});

test('the historical ETA adds a small congestion cost during a peak slot', () => {
  const morning = plan([{ product_id: 'P001', quantity: 100 }], '2026-10-19T01:00:00.000Z');
  const midday = plan([{ product_id: 'P001', quantity: 100 }], '2026-10-19T03:00:00.000Z');

  assert.deepEqual(morning.decision.warehouses_used, ['W01']);
  assert.equal(morning.decision.total_cost_idr, 63_000);
  assert.equal(midday.decision.total_cost_idr, 45_000);
  assert.ok(
    morning.decision.cost_breakdown.shipments[0].delay_cost_idr >
      midday.decision.cost_breakdown.shipments[0].delay_cost_idr
  );
});

test('cost breakdown totals reconcile with the decision total', () => {
  const result = plan([{ product_id: 'P001', quantity: 100 }, { product_id: 'P002', quantity: 20 }]);
  const shipmentsTotal = result.decision.cost_breakdown.shipments.reduce(
    (sum, shipment) => sum + shipment.subtotal_idr,
    0
  );
  assert.equal(
    shipmentsTotal + result.decision.cost_breakdown.split_penalty_idr,
    result.decision.total_cost_idr
  );
  assert.deepEqual(result.decision.warehouses_used, ['W01', 'W04']);
});
