import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WAREHOUSES } from '../src/data/seed.js';
import { parseHistoricalRecords } from '../src/lib/csv.js';
import { buildEtaModel } from '../src/services/eta.js';

const csvPath = fileURLToPath(new URL('../data/customer1-historical.csv', import.meta.url));
const records = parseHistoricalRecords(readFileSync(csvPath, 'utf8'));
const model = buildEtaModel({ records, warehouses: WAREHOUSES });
const analytics = model.analytics();

console.log(`Historical delivery records: ${analytics.record_count}`);
console.log(analytics.caveat);
console.log('');

console.log('Warehouse summary');
console.table(
  analytics.warehouses.map((warehouse) => ({
    warehouse: warehouse.warehouse_id,
    city: warehouse.city,
    distance_km: warehouse.distance_km,
    samples: warehouse.sample_size,
    median_minutes: warehouse.median_minutes,
    min_minutes: warehouse.min_minutes,
    max_minutes: warehouse.max_minutes
  }))
);

console.log('Median minutes by day type and time bucket');
console.table(
  analytics.warehouses.flatMap((warehouse) =>
    warehouse.groups.map((group) => ({
      warehouse: warehouse.warehouse_id,
      day_type: group.day_type,
      bucket: group.bucket_label,
      samples: group.sample_size,
      median_minutes: group.median_minutes
    }))
  )
);

console.log('Insights');
analytics.insights.forEach((insight, index) => {
  console.log(`${index + 1}. ${insight}`);
});
