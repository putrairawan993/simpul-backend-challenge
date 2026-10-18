import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WAREHOUSES } from '../src/data/seed.js';
import { parseCsv, parseHistoricalRecords, timeBucketFor } from '../src/lib/csv.js';
import { describeRequestedTime } from '../src/lib/time.js';
import { buildEtaModel } from '../src/services/eta.js';

const csvPath = fileURLToPath(new URL('../data/customer1-historical.csv', import.meta.url));
const csv = readFileSync(csvPath, 'utf8');
const records = parseHistoricalRecords(csv);
const etaModel = buildEtaModel({ records, warehouses: WAREHOUSES });

test('CSV parser handles quoted fields, BOM, and the historical schema', () => {
  const rows = parseCsv('\uFEFFa,b,c\n1,"Mon, 08:00",3\n');
  assert.deepEqual(rows[1], ['1', 'Mon, 08:00', '3']);
  assert.equal(records.length, 38);
  assert.equal(records[0].warehouse_id, 'W01');
  assert.equal(records[0].duration_minutes, 50);
  assert.equal(records[0].day_type, 'weekday');
  assert.equal(records[0].bucket, 'morning_peak');
});

test('time buckets cover the documented boundaries', () => {
  assert.equal(timeBucketFor(7 * 60).id, 'morning_peak');
  assert.equal(timeBucketFor(9 * 60 + 29).id, 'morning_peak');
  assert.equal(timeBucketFor(9 * 60 + 30).id, 'midday');
  assert.equal(timeBucketFor(14 * 60 + 59).id, 'midday');
  assert.equal(timeBucketFor(15 * 60).id, 'evening_peak');
  assert.equal(timeBucketFor(18 * 60 + 29).id, 'evening_peak');
  assert.equal(timeBucketFor(18 * 60 + 30).id, 'off_peak');
  assert.equal(timeBucketFor(6 * 60 + 59).id, 'off_peak');
});

test('requested time is resolved in Jakarta time regardless of host timezone', () => {
  const mondayMorning = describeRequestedTime('2026-10-19T03:00:00.000Z');
  assert.equal(mondayMorning.day, 'Mon');
  assert.equal(mondayMorning.day_type, 'weekday');
  assert.equal(mondayMorning.hour, 10);
  assert.equal(mondayMorning.bucket, 'midday');
  assert.match(mondayMorning.wib, /Mon, 10:00 WIB/);

  const saturdayAfternoon = describeRequestedTime('2026-10-24T09:00:00.000Z');
  assert.equal(saturdayAfternoon.day, 'Sat');
  assert.equal(saturdayAfternoon.day_type, 'weekend');
  assert.equal(saturdayAfternoon.hour, 16);
  assert.equal(saturdayAfternoon.bucket, 'evening_peak');
});

test('ETA prediction uses the matching historical bucket', () => {
  const mondayMidday = describeRequestedTime('2026-10-19T03:00:00.000Z');
  const prediction = etaModel.predict(
    WAREHOUSES.find((warehouse) => warehouse.id === 'W01'),
    mondayMidday
  );
  assert.equal(prediction.eta_minutes, 17);
  assert.equal(prediction.source, 'history_bucket');
  assert.equal(prediction.sample_size, 2);

  const mondayMorning = describeRequestedTime('2026-10-19T01:00:00.000Z');
  const morningPrediction = etaModel.predict(
    WAREHOUSES.find((warehouse) => warehouse.id === 'W01'),
    mondayMorning
  );
  assert.equal(morningPrediction.eta_minutes, 53);
  assert.equal(morningPrediction.source, 'history_bucket');
});

test('single-sample buckets are shrunk toward the warehouse median', () => {
  const saturdayMidday = describeRequestedTime('2026-10-24T03:00:00.000Z');
  const prediction = etaModel.predict(
    WAREHOUSES.find((warehouse) => warehouse.id === 'W01'),
    saturdayMidday
  );
  assert.equal(prediction.source, 'history_bucket_shrunk');
  assert.equal(prediction.sample_size, 1);
  assert.ok(prediction.eta_minutes >= 12 && prediction.eta_minutes <= 33);
});

test('analytics reports patterns without using single-sample ratios', () => {
  const analytics = etaModel.analytics();
  assert.equal(analytics.record_count, 38);
  assert.ok(analytics.insights.length > 0);
  assert.ok(analytics.insights.some((insight) => insight.includes('W01')));
  assert.ok(
    analytics.insights.every(
      (insight) => !/median \d+ vs \d+ min\)/i.test(insight) || insight.includes('samples')
    )
  );
  assert.ok(analytics.insights.some((insight) => insight.includes('Long-distance routes')));
});
