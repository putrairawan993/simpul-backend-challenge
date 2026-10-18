export const SERVICE = Object.freeze({
  name: 'Simpul Warehouse Allocator',
  version: '1.0.0',
  timezone: 'Asia/Jakarta'
});

/**
 * Cost model used to rank allocation plans.
 *
 * The numbers are deliberately explicit and configurable in one place so the
 * trade-offs are easy to inspect and adjust. They are estimates for a small
 * distribution operation, not accounting-grade figures.
 */
export const COST_MODEL = Object.freeze({
  base_fee_idr: 25_000,
  per_km_idr: 4_000,
  cold_chain_surcharge_idr: 15_000,
  extra_warehouse_penalty_idr: 15_000,
  delay_cost_per_minute_idr: 500,
  distance_baseline_intercept_minutes: 10,
  distance_baseline_minutes_per_km: 1.4
});

export const ALLOCATION_LIMITS = Object.freeze({
  max_items_per_order: 50,
  max_quantity_per_item: 100_000,
  max_total_quantity: 1_000_000,
  max_exhaustive_warehouses: 12
});

export const ETA_MODEL = Object.freeze({
  bucket_minimum_samples: 2,
  max_alternatives: 3
});
