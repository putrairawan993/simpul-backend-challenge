import { ALLOCATION_LIMITS, COST_MODEL, ETA_MODEL } from '../config.js';
import { distanceBaselineMinutes } from './eta.js';
import { formatIdr, formatNumber } from '../lib/format.js';

export function isWarehouseEligible(warehouse, product) {
  const stock = Number(warehouse.stock?.[product.id] ?? 0);
  if (stock <= 0) {
    return false;
  }
  if (!product.cold_chain) {
    return true;
  }
  return Boolean(warehouse.refrigerated_storage && warehouse.refrigerated_fleet);
}

function allNonEmptySubsets(items) {
  const subsets = [];
  const total = 1 << items.length;
  for (let mask = 1; mask < total; mask += 1) {
    const subset = [];
    for (let index = 0; index < items.length; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        subset.push(items[index]);
      }
    }
    subsets.push(subset);
  }
  return subsets;
}

function allocateSubset(subset, demands, etaByWarehouse) {
  const allocations = new Map();

  for (const demand of demands) {
    let remaining = demand.quantity;
    const eligible = subset
      .filter((warehouse) => isWarehouseEligible(warehouse, demand.product))
      .sort((left, right) => {
        const distanceDelta = left.distance_km - right.distance_km;
        if (distanceDelta !== 0) {
          return distanceDelta;
        }
        const leftEta = etaByWarehouse.get(left.id)?.eta_minutes ?? 0;
        const rightEta = etaByWarehouse.get(right.id)?.eta_minutes ?? 0;
        if (leftEta !== rightEta) {
          return leftEta - rightEta;
        }
        return left.id.localeCompare(right.id);
      });

    for (const warehouse of eligible) {
      if (remaining <= 0) {
        break;
      }
      const available = Number(warehouse.stock?.[demand.product.id] ?? 0);
      const take = Math.min(available, remaining);
      if (take <= 0) {
        continue;
      }
      if (!allocations.has(warehouse.id)) {
        allocations.set(warehouse.id, []);
      }
      allocations.get(warehouse.id).push({
        product: demand.product,
        quantity: take
      });
      remaining -= take;
    }

    if (remaining > 0) {
      return null;
    }
  }

  return allocations;
}

function computeCost(usedWarehouseIds, allocations, warehouseMap, etaByWarehouse, costModel) {
  const shipments = usedWarehouseIds.map((warehouseId) => {
    const warehouse = warehouseMap.get(warehouseId);
    const lines = allocations.get(warehouseId);
    const quantityTotal = lines.reduce((sum, line) => sum + line.quantity, 0);
    const coldChain = lines.some((line) => line.product.cold_chain);
    const eta = etaByWarehouse.get(warehouseId);
    const predictedEta = eta?.eta_minutes ?? distanceBaselineMinutes(warehouse.distance_km);
    const baseline = distanceBaselineMinutes(warehouse.distance_km);
    // Only apply a congestion penalty when the historical data has a signal
    // for this specific day-type and time bucket. A warehouse-wide median is
    // still useful for display, but it is too coarse to justify a penalty.
    const hasSlotSignal =
      eta?.source === 'history_bucket' || eta?.source === 'history_bucket_shrunk';
    const delay = hasSlotSignal ? Math.max(0, predictedEta - baseline) : 0;
    const baseFee = costModel.base_fee_idr;
    const distanceCost = Math.round(warehouse.distance_km * costModel.per_km_idr);
    const coldChainSurcharge = coldChain ? costModel.cold_chain_surcharge_idr : 0;
    const delayCost = Math.round(delay * costModel.delay_cost_per_minute_idr);
    const subtotal = baseFee + distanceCost + coldChainSurcharge + delayCost;

    return {
      warehouse_id: warehouseId,
      warehouse_name: warehouse.name,
      city: warehouse.city,
      distance_km: warehouse.distance_km,
      quantity_total: quantityTotal,
      cold_chain: coldChain,
      eta_minutes: predictedEta,
      baseline_minutes: Math.round(baseline),
      delay_minutes: Math.round(delay),
      delay_applied: hasSlotSignal,
      base_fee_idr: baseFee,
      distance_cost_idr: distanceCost,
      cold_chain_surcharge_idr: coldChainSurcharge,
      delay_cost_idr: delayCost,
      subtotal_idr: subtotal
    };
  });

  const splitPenalty = costModel.extra_warehouse_penalty_idr * Math.max(0, shipments.length - 1);
  const shipmentsTotal = shipments.reduce((sum, shipment) => sum + shipment.subtotal_idr, 0);

  return {
    shipments,
    split_penalty_idr: splitPenalty,
    total_idr: shipmentsTotal + splitPenalty,
    model: { ...costModel }
  };
}

function maxEta(allocations, etaByWarehouse) {
  let maximum = 0;
  for (const warehouseId of allocations.keys()) {
    maximum = Math.max(maximum, etaByWarehouse.get(warehouseId)?.eta_minutes ?? 0);
  }
  return maximum;
}

function comparePlans(left, right, etaByWarehouse) {
  if (left.cost.total_idr !== right.cost.total_idr) {
    return left.cost.total_idr - right.cost.total_idr;
  }
  if (left.allocations.size !== right.allocations.size) {
    return left.allocations.size - right.allocations.size;
  }
  const etaDelta = maxEta(left.allocations, etaByWarehouse) - maxEta(right.allocations, etaByWarehouse);
  if (etaDelta !== 0) {
    return etaDelta;
  }
  return left.signature.localeCompare(right.signature);
}

function findBestPlan({ demands, warehouses, etaByWarehouse, costModel }) {
  const relevant = warehouses.filter((warehouse) =>
    demands.some((demand) => isWarehouseEligible(warehouse, demand.product))
  );

  let subsets;
  let method;
  if (relevant.length <= ALLOCATION_LIMITS.max_exhaustive_warehouses) {
    subsets = allNonEmptySubsets(relevant);
    method = 'exhaustive_warehouse_subsets';
  } else {
    subsets = [...relevant.map((warehouse) => [warehouse]), relevant];
    method = 'greedy_full_set';
  }

  const candidates = new Map();
  for (const subset of subsets) {
    const allocations = allocateSubset(subset, demands, etaByWarehouse);
    if (!allocations) {
      continue;
    }
    const used = [...allocations.keys()].sort();
    const signature = used.join('+');
    if (candidates.has(signature)) {
      continue;
    }
    candidates.set(signature, {
      allocations,
      signature,
      cost: computeCost(used, allocations, new Map(warehouses.map((w) => [w.id, w])), etaByWarehouse, costModel)
    });
  }

  const sorted = [...candidates.values()].sort((left, right) =>
    comparePlans(left, right, etaByWarehouse)
  );

  if (sorted.length === 0) {
    throw new Error('No feasible allocation plan was found.');
  }

  const best = sorted[0];
  const alternatives = sorted.slice(1, 1 + ETA_MODEL.max_alternatives).map((plan, index) => ({
    rank: index + 2,
    warehouses: [...plan.allocations.keys()].sort(),
    total_cost_idr: plan.cost.total_idr,
    difference_idr: plan.cost.total_idr - best.cost.total_idr,
    extra_cost_label:
      plan.cost.total_idr === best.cost.total_idr
        ? 'Same estimated cost'
        : `${formatIdr(plan.cost.total_idr - best.cost.total_idr)} more`
  }));

  return {
    ...best,
    alternatives,
    search: {
      method,
      warehouses_considered: relevant.length,
      plans_evaluated: candidates.size
    }
  };
}

function shortageReason(line, eligibleWarehouses) {
  if (eligibleWarehouses.length === 0) {
    if (line.product.cold_chain) {
      return `No cold-chain-capable warehouse (refrigerated storage plus refrigerated van) stocks ${line.product.name}.`;
    }
    return `No warehouse currently stocks ${line.product.name}.`;
  }
  return `Only ${formatNumber(line.available)} of ${formatNumber(line.quantity)} units are available from eligible warehouses.`;
}

function buildExplanation({
  status,
  lines,
  availability,
  allocations,
  plan,
  requestedTime,
  warehouses,
  products,
  totalRequested,
  totalFulfillable
}) {
  const used = allocations;
  const usedIds = used.map((allocation) => allocation.warehouse_id);
  const warehouseMap = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const factors = [];

  let summary;
  if (status === 'unfulfillable') {
    summary = `No eligible warehouse stock can cover this order. ${formatNumber(totalRequested)} units were requested and none can be allocated under the current stock and cold-chain rules.`;
  } else if (status === 'partial') {
    const coveredWarehouses = usedIds.join(', ');
    summary = `${formatNumber(totalFulfillable)} of ${formatNumber(totalRequested)} units can be covered from ${coveredWarehouses}. The remaining ${formatNumber(totalRequested - totalFulfillable)} units are short because the eligible stock is not enough. Estimated cost for the covered part is ${formatIdr(plan.cost.total_idr)}.`;
  } else if (used.length === 1) {
    const allocation = used[0];
    summary = `${allocation.warehouse_id} (${allocation.city}, ${allocation.distance_km} km) is the lowest-cost single warehouse that can cover the whole order. Estimated shipment cost is ${formatIdr(plan.cost.total_idr)}, with a predicted delivery time of ${allocation.eta_minutes} minutes for ${requestedTime.wib}.`;
  } else {
    summary = `No single warehouse can cover the order at a lower estimated cost, so it is split across ${used.length} warehouses (${usedIds.join(', ')}). Combined estimated cost is ${formatIdr(plan.cost.total_idr)}, including a ${formatIdr(plan.cost.split_penalty_idr)} split-handling penalty.`;
  }

  factors.push(
    `Stock coverage: ${formatNumber(totalFulfillable)} of ${formatNumber(totalRequested)} requested units are available from eligible warehouses.`
  );

  const coldProducts = products.filter((product) =>
    lines.some((line) => line.product.id === product.id && line.product.cold_chain)
  );
  if (coldProducts.length > 0) {
    const names = coldProducts.map((product) => product.name).join(', ');
    factors.push(
      `Cold chain: ${names} require both refrigerated storage and a refrigerated delivery van. Warehouses without both capabilities were excluded even when they held stock.`
    );
  }

  factors.push(
    `Distance and cost: each shipment costs ${formatIdr(plan.cost.model.base_fee_idr)} plus ${formatIdr(plan.cost.model.per_km_idr)} per km. Distance is measured from the single customer location.`
  );

  if (used.length > 1) {
    factors.push(
      `Split handling: every extra warehouse adds ${formatIdr(plan.cost.model.extra_warehouse_penalty_idr)} in coordination cost, so the model prefers one warehouse whenever it is cheaper.`
    );
  }

  const etaShipments = plan.cost.shipments.filter((shipment) => shipment.delay_minutes > 0);
  if (etaShipments.length > 0) {
    const details = etaShipments
      .map(
        (shipment) =>
          `${shipment.warehouse_id} +${shipment.delay_minutes} min versus the distance baseline`
      )
      .join('; ');
    factors.push(
      `Historical ETA: the requested slot (${requestedTime.wib}) maps to the ${requestedTime.bucket_label.toLowerCase()} bucket. The model adds a small delay cost for ${details}.`
    );
  } else {
    factors.push(
      `Historical ETA: the requested slot (${requestedTime.wib}) does not add a congestion penalty for the selected warehouses, so distance and stock drive the decision.`
    );
  }

  if (status === 'partial' || status === 'unfulfillable') {
    factors.push(
      'Partial orders are returned instead of failing outright: the API allocates whatever eligible stock exists and reports each shortage explicitly.'
    );
  }

  const coldExcluded = warehouses
    .filter((warehouse) => !(warehouse.refrigerated_storage && warehouse.refrigerated_fleet))
    .filter((warehouse) =>
      coldProducts.some((product) => Number(warehouse.stock?.[product.id] ?? 0) > 0)
    )
    .map((warehouse) => ({
      warehouse_id: warehouse.id,
      city: warehouse.city,
      reason: 'Holds cold-chain stock but cannot provide both refrigerated storage and a refrigerated van.'
    }));

  const shortageLines = availability
    .filter((line) => line.shortage > 0)
    .map((line) => ({
      product_id: line.product.id,
      product_name: line.product.name,
      requested_quantity: line.quantity,
      allocated_quantity: line.fulfillableQty,
      shortage_quantity: line.shortage,
      reason: shortageReason(line, line.eligibleWarehouses)
    }));

  return {
    summary,
    factors,
    cold_chain_exclusions: coldExcluded,
    shortage_explanations: shortageLines,
    assumptions: [
      'Distances are provided estimates from the single customer location; no routing or geocoding is applied.',
      'Stock is a read-only snapshot. This service decides allocation and does not reserve or decrement inventory.',
      'Cost parameters are illustrative IDR figures kept in one configuration file so they can be tuned.',
      'The historical ETA dataset has only 38 trips. It informs a small delay penalty, not the core stock-and-distance ranking.'
    ],
    search: plan.search,
    alternatives: plan.alternatives
  };
}

/**
 * Plans an order against the seeded product and warehouse snapshot.
 *
 * The warehouse subset is enumerated because each used warehouse adds a fixed
 * shipment and split cost. For each subset, products are filled nearest-first.
 * With eight warehouses this is 255 subsets, which is comfortably fast.
 */
export function planOrder({
  lines,
  products,
  warehouses,
  etaModel,
  requestedTime,
  costModel = COST_MODEL
}) {
  const productMap = new Map(products.map((product) => [product.id, product]));
  const warehouseMap = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const etaByWarehouse = etaModel.predictForWarehouses(warehouses, requestedTime);

  const merged = new Map();
  for (const line of lines) {
    const product = productMap.get(line.product_id);
    if (!product) {
      throw new Error(`Unknown product: ${line.product_id}`);
    }
    merged.set(product.id, (merged.get(product.id) ?? 0) + line.quantity);
  }

  const availability = [...merged.entries()].map(([productId, quantity]) => {
    const product = productMap.get(productId);
    const eligibleWarehouses = warehouses.filter((warehouse) =>
      isWarehouseEligible(warehouse, product)
    );
    const available = eligibleWarehouses.reduce(
      (sum, warehouse) => sum + Number(warehouse.stock?.[product.id] ?? 0),
      0
    );
    const fulfillableQty = Math.min(quantity, available);
    return {
      product,
      quantity,
      available,
      fulfillableQty,
      shortage: quantity - fulfillableQty,
      eligibleWarehouses
    };
  });

  const totalRequested = availability.reduce((sum, line) => sum + line.quantity, 0);
  const totalFulfillable = availability.reduce((sum, line) => sum + line.fulfillableQty, 0);

  if (totalFulfillable === 0) {
    const plan = {
      allocations: new Map(),
      cost: {
        shipments: [],
        split_penalty_idr: 0,
        total_idr: 0,
        model: { ...costModel }
      },
      search: {
        method: 'none',
        warehouses_considered: 0,
        plans_evaluated: 0
      },
      alternatives: []
    };

    const explanation = buildExplanation({
      status: 'unfulfillable',
      lines: availability,
      availability,
      allocations: [],
      plan,
      requestedTime,
      warehouses,
      products,
      totalRequested,
      totalFulfillable
    });

    return {
      status: 'unfulfillable',
      requested_time: requestedTime,
      allocations: [],
      unfulfilled: explanation.shortage_explanations,
      decision: {
        total_cost_idr: 0,
        cost_breakdown: plan.cost,
        warehouses_used: [],
        explanation,
        search: plan.search
      }
    };
  }

  const demands = availability
    .filter((line) => line.fulfillableQty > 0)
    .map((line) => ({ product: line.product, quantity: line.fulfillableQty }));

  const plan = findBestPlan({ demands, warehouses, etaByWarehouse, costModel });

  const allocations = [...plan.allocations.entries()]
    .map(([warehouseId, allocatedLines]) => {
      const warehouse = warehouseMap.get(warehouseId);
      const eta = etaByWarehouse.get(warehouseId);
      const shipment = plan.cost.shipments.find((item) => item.warehouse_id === warehouseId);
      const items = allocatedLines.map((line) => ({
        product_id: line.product.id,
        product_name: line.product.name,
        category: line.product.category,
        cold_chain: line.product.cold_chain,
        quantity: line.quantity
      }));
      return {
        warehouse_id: warehouseId,
        warehouse_name: warehouse.name,
        city: warehouse.city,
        distance_km: warehouse.distance_km,
        refrigerated_storage: warehouse.refrigerated_storage,
        refrigerated_fleet: warehouse.refrigerated_fleet,
        cold_chain: items.some((item) => item.cold_chain),
        eta_minutes: eta.eta_minutes,
        eta_source: eta.source,
        eta_sample_size: eta.sample_size,
        eta_baseline_minutes: eta.baseline_minutes,
        eta_delay_minutes: shipment.delay_minutes,
        eta_delay_applied: shipment.delay_applied,
        eta_day_type: eta.day_type,
        eta_bucket: eta.bucket,
        eta_bucket_label: eta.bucket_label,
        quantity_total: shipment.quantity_total,
        items,
        cost: {
          base_fee_idr: shipment.base_fee_idr,
          distance_cost_idr: shipment.distance_cost_idr,
          cold_chain_surcharge_idr: shipment.cold_chain_surcharge_idr,
          delay_cost_idr: shipment.delay_cost_idr,
          subtotal_idr: shipment.subtotal_idr
        }
      };
    })
    .sort((left, right) => left.distance_km - right.distance_km || left.warehouse_id.localeCompare(right.warehouse_id));

  const allocatedByProduct = new Map();
  for (const allocation of allocations) {
    for (const item of allocation.items) {
      allocatedByProduct.set(
        item.product_id,
        (allocatedByProduct.get(item.product_id) ?? 0) + item.quantity
      );
    }
  }

  const unfulfilled = availability
    .filter((line) => line.shortage > 0)
    .map((line) => ({
      product_id: line.product.id,
      product_name: line.product.name,
      requested_quantity: line.quantity,
      allocated_quantity: allocatedByProduct.get(line.product.id) ?? 0,
      shortage_quantity: line.shortage,
      reason: shortageReason(line, line.eligibleWarehouses)
    }));

  const status = totalFulfillable === totalRequested ? 'fulfilled' : 'partial';

  const explanation = buildExplanation({
    status,
    lines: availability,
    availability,
    allocations,
    plan,
    requestedTime,
    warehouses,
    products,
    totalRequested,
    totalFulfillable
  });

  return {
    status,
    requested_time: requestedTime,
    allocations,
    unfulfilled,
    decision: {
      total_cost_idr: plan.cost.total_idr,
      cost_breakdown: plan.cost,
      warehouses_used: allocations.map((allocation) => allocation.warehouse_id),
      explanation,
      search: plan.search
    }
  };
}
