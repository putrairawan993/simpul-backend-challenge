/**
 * Minimal RFC 4180 style CSV parser. It supports quoted fields, escaped
 * quotes, CRLF, and a UTF-8 BOM. That is enough for the historical data file
 * and avoids a dependency for one small input.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

const DAY_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
});

const TIME_BUCKETS = Object.freeze([
  { id: 'morning_peak', label: 'Morning peak (07:00-09:29)', start: 7 * 60, end: 9 * 60 + 30 },
  { id: 'midday', label: 'Midday (09:30-14:59)', start: 9 * 60 + 30, end: 15 * 60 },
  { id: 'evening_peak', label: 'Evening peak (15:00-18:29)', start: 15 * 60, end: 18 * 60 + 30 },
  { id: 'off_peak', label: 'Off-peak (18:30-06:59)', start: 18 * 60 + 30, end: 24 * 60 }
]);

export function timeBucketFor(minutesOfDay) {
  const minutes = ((minutesOfDay % 1440) + 1440) % 1440;
  for (const bucket of TIME_BUCKETS) {
    if (bucket.id === 'off_peak') {
      if (minutes >= bucket.start || minutes < 7 * 60) {
        return bucket;
      }
      continue;
    }
    if (minutes >= bucket.start && minutes < bucket.end) {
      return bucket;
    }
  }
  return TIME_BUCKETS[TIME_BUCKETS.length - 1];
}

export { DAY_INDEX, TIME_BUCKETS };

/**
 * Parses the historical delivery CSV into normalized records.
 */
export function parseHistoricalRecords(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return [];
  }

  const header = rows[0].map((cell) => cell.trim());
  const column = (name) => header.indexOf(name);
  const deliveryIndex = column('Delivery ID');
  const warehouseIndex = column('Warehouse');
  const timeIndex = column('Day/Time');
  const durationIndex = column('Actual Duration (minutes)');
  const notesIndex = column('Notes');

  if (warehouseIndex === -1 || timeIndex === -1 || durationIndex === -1) {
    throw new Error('Historical CSV is missing one of the required columns.');
  }

  const records = [];
  for (const cells of rows.slice(1)) {
    const warehouseId = (cells[warehouseIndex] ?? '').trim();
    const dayTime = (cells[timeIndex] ?? '').trim();
    const duration = Number.parseFloat(cells[durationIndex]);
    const match = /^([A-Za-z]{3}),\s*(\d{1,2}):(\d{2})$/.exec(dayTime);

    if (!warehouseId || !match || !Number.isFinite(duration)) {
      continue;
    }

    const day = match[1].slice(0, 1).toUpperCase() + match[1].slice(1).toLowerCase();
    const hours = Number.parseInt(match[2], 10);
    const minutes = Number.parseInt(match[3], 10);
    if (DAY_INDEX[day] === undefined || hours > 23 || minutes > 59) {
      continue;
    }

    const minutesOfDay = hours * 60 + minutes;
    const bucket = timeBucketFor(minutesOfDay);
    const weekday = DAY_INDEX[day];

    records.push({
      delivery_id: (cells[deliveryIndex] ?? '').trim(),
      warehouse_id: warehouseId,
      day,
      day_index: weekday,
      minutes_of_day: minutesOfDay,
      duration_minutes: duration,
      notes: notesIndex === -1 ? '' : (cells[notesIndex] ?? '').trim(),
      day_type: weekday === 0 || weekday === 6 ? 'weekend' : 'weekday',
      bucket: bucket.id,
      bucket_label: bucket.label
    });
  }

  return records;
}
