import { readFileSync } from 'node:fs';
import { COST_MODEL, ETA_MODEL } from '../config.js';
import { parseHistoricalRecords, TIME_BUCKETS } from '../lib/csv.js';

function median(values) {
  if (!values || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMinutes(value) {
  return Math.max(0, Math.round(value));
}

export function distanceBaselineMinutes(distanceKm) {
  return (
    COST_MODEL.distance_baseline_intercept_minutes +
    COST_MODEL.distance_baseline_minutes_per_km * Number(distanceKm || 0)
  );
}

function summarizeGroup(records) {
  const durations = records.map((record) => record.duration_minutes);
  return {
    sample_size: durations.length,
    median_minutes: roundMinutes(median(durations)),
    min_minutes: durations.length ? roundMinutes(Math.min(...durations)) : null,
    max_minutes: durations.length ? roundMinutes(Math.max(...durations)) : null
  };
}

/**
 * Builds a small empirical ETA model from the historical delivery records.
 *
 * The dataset is tiny (38 rows), so bucket estimates with only one sample are
 * shrunk halfway toward the warehouse median. This keeps a single noisy trip
 * from dominating a decision.
 */
export function buildEtaModel({ records, warehouses, sourceLabel = 'Customer 1 Historical Data.csv' }) {
  const warehouseStates = new Map();

  for (const warehouse of warehouses) {
    const warehouseRecords = records.filter((record) => record.warehouse_id === warehouse.id);
    const overall = summarizeGroup(warehouseRecords);
    const groups = new Map();

    for (const record of warehouseRecords) {
      const key = `${record.day_type}:${record.bucket}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(record);
    }

    const bucketStats = new Map();
    for (const [key, groupRecords] of groups.entries()) {
      const summary = summarizeGroup(groupRecords);
      bucketStats.set(key, {
        ...summary,
        day_type: key.split(':')[0],
        bucket: key.split(':')[1]
      });
    }

    warehouseStates.set(warehouse.id, {
      warehouse_id: warehouse.id,
      sample_size: overall.sample_size,
      median_minutes: overall.median_minutes,
      min_minutes: overall.min_minutes,
      max_minutes: overall.max_minutes,
      bucket_stats: bucketStats
    });
  }

  function predict(warehouse, requestedTime) {
    const state = warehouseStates.get(warehouse.id);
    const bucket = TIME_BUCKETS.find((item) => item.id === requestedTime.bucket) ?? TIME_BUCKETS[0];
    const key = `${requestedTime.day_type}:${requestedTime.bucket}`;
    const bucketStats = state?.bucket_stats.get(key);
    const baseline = distanceBaselineMinutes(warehouse.distance_km);
    const context = {
      day_type: requestedTime.day_type,
      bucket: requestedTime.bucket,
      bucket_label: bucket.label,
      baseline_minutes: roundMinutes(baseline)
    };

    if (bucketStats && bucketStats.sample_size >= ETA_MODEL.bucket_minimum_samples) {
      return {
        ...context,
        eta_minutes: roundMinutes(bucketStats.median_minutes),
        source: 'history_bucket',
        sample_size: bucketStats.sample_size
      };
    }

    if (bucketStats && bucketStats.sample_size === 1) {
      const warehouseMedian = state?.median_minutes ?? baseline;
      return {
        ...context,
        eta_minutes: roundMinutes((bucketStats.median_minutes + warehouseMedian) / 2),
        source: 'history_bucket_shrunk',
        sample_size: 1
      };
    }

    if (state && state.sample_size > 0 && state.median_minutes !== null) {
      return {
        ...context,
        eta_minutes: roundMinutes(state.median_minutes),
        source: 'history_warehouse',
        sample_size: state.sample_size
      };
    }

    return {
      ...context,
      eta_minutes: roundMinutes(baseline),
      source: 'distance_baseline',
      sample_size: 0
    };
  }

  function predictForWarehouses(list, requestedTime) {
    return new Map(list.map((warehouse) => [warehouse.id, predict(warehouse, requestedTime)]));
  }

  function analytics() {
    const warehouseRows = warehouses.map((warehouse) => {
      const state = warehouseStates.get(warehouse.id);
      const groups = [];
      for (const bucket of TIME_BUCKETS) {
        for (const dayType of ['weekday', 'weekend']) {
          const stats = state?.bucket_stats.get(`${dayType}:${bucket.id}`);
          if (stats) {
            groups.push({
              day_type: dayType,
              bucket: bucket.id,
              bucket_label: bucket.label,
              sample_size: stats.sample_size,
              median_minutes: stats.median_minutes,
              min_minutes: stats.min_minutes,
              max_minutes: stats.max_minutes
            });
          }
        }
      }
      return {
        warehouse_id: warehouse.id,
        city: warehouse.city,
        distance_km: warehouse.distance_km,
        sample_size: state?.sample_size ?? 0,
        median_minutes: state?.median_minutes ?? null,
        min_minutes: state?.min_minutes ?? null,
        max_minutes: state?.max_minutes ?? null,
        groups
      };
    });

    const insights = [];

    // Only compare buckets with at least two trips, and keep the comparison
    // within the same day type so weekday and weekend effects are not mixed.
    for (const row of warehouseRows) {
      for (const dayType of ['weekday', 'weekend']) {
        const comparable = row.groups.filter(
          (group) => group.day_type === dayType && group.sample_size >= 2
        );
        if (comparable.length < 2) {
          continue;
        }
        const fastest = comparable.reduce((best, group) =>
          group.median_minutes < best.median_minutes ? group : best
        );
        const slowest = comparable.reduce((worst, group) =>
          group.median_minutes > worst.median_minutes ? group : worst
        );
        if (slowest.median_minutes >= fastest.median_minutes * 1.5) {
          const ratio = (slowest.median_minutes / Math.max(1, fastest.median_minutes)).toFixed(1);
          insights.push(
            `${row.warehouse_id}: ${dayType} ${slowest.bucket_label.toLowerCase()} runs about ${ratio}x slower than ${fastest.bucket_label.toLowerCase()} (median ${slowest.median_minutes} vs ${fastest.median_minutes} min, ${slowest.sample_size} and ${fastest.sample_size} samples).`
          );
        }
      }
    }

    const weekendValues = records.filter((record) => record.day_type === 'weekend').map((record) => record.duration_minutes);
    const weekdayValues = records.filter((record) => record.day_type === 'weekday').map((record) => record.duration_minutes);
    const weekendMedian = median(weekendValues);
    const weekdayMedian = median(weekdayValues);
    if (
      weekendValues.length >= 2 &&
      weekdayValues.length >= 2 &&
      weekendMedian !== null &&
      weekdayMedian !== null &&
      weekendMedian >= weekdayMedian * 1.2
    ) {
      insights.push(
        `Weekend deliveries are slower overall: median ${roundMinutes(weekendMedian)} min versus ${roundMinutes(weekdayMedian)} min on weekdays (${weekendValues.length} weekend and ${weekdayValues.length} weekday trips).`
      );
    }

    const longRoutes = warehouseRows.filter((row) => row.distance_km >= 90 && row.sample_size > 0);
    if (longRoutes.length > 0) {
      const slowestLongRoute = longRoutes.reduce((worst, row) =>
        row.median_minutes > worst.median_minutes ? row : worst
      );
      insights.push(
        `Long-distance routes are the main ETA risk: ${slowestLongRoute.warehouse_id} (${slowestLongRoute.distance_km} km) has a median of ${slowestLongRoute.median_minutes} min in the sample.`
      );
    }

    const longRouteIds = new Set(
      warehouses.filter((warehouse) => warehouse.distance_km >= 90).map((warehouse) => warehouse.id)
    );
    const longRouteWeekend = records
      .filter((record) => longRouteIds.has(record.warehouse_id) && record.day_type === 'weekend')
      .map((record) => record.duration_minutes);
    const longRouteWeekday = records
      .filter((record) => longRouteIds.has(record.warehouse_id) && record.day_type === 'weekday')
      .map((record) => record.duration_minutes);
    const longRouteWeekendMedian = median(longRouteWeekend);
    const longRouteWeekdayMedian = median(longRouteWeekday);
    if (
      longRouteWeekend.length >= 2 &&
      longRouteWeekday.length >= 2 &&
      longRouteWeekendMedian !== null &&
      longRouteWeekdayMedian !== null &&
      longRouteWeekendMedian >= longRouteWeekdayMedian * 1.15
    ) {
      insights.push(
        `Long-distance routes (90 km or more) are slower on weekends: median ${roundMinutes(longRouteWeekendMedian)} min versus ${roundMinutes(longRouteWeekdayMedian)} min on weekdays.`
      );
    }

    const sparseWarehouses = warehouseRows.filter((row) =>
      row.groups.some((group) => group.sample_size === 1)
    ).length;
    if (sparseWarehouses > 0) {
      insights.push(
        `${sparseWarehouses} warehouses have at least one time bucket with a single trip. Those rows are displayed, but the planner shrinks them toward the warehouse median before using them.`
      );
    }

    return {
      source_label: sourceLabel,
      record_count: records.length,
      caveat:
        'Only 38 historical trips are provided. Treat these estimates as directional inputs, not a production ETA model.',
      buckets: TIME_BUCKETS,
      warehouses: warehouseRows,
      insights: insights.slice(0, 8)
    };
  }

  return {
    records,
    predict,
    predictForWarehouses,
    analytics,
    warehouseStates
  };
}

export function loadEtaModelFromFile(filePath, warehouses) {
  const csv = readFileSync(filePath, 'utf8');
  const records = parseHistoricalRecords(csv);
  return buildEtaModel({ records, warehouses });
}
