import { SERVICE } from '../config.js';
import { DAY_INDEX, timeBucketFor } from './csv.js';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SERVICE.timezone,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/**
 * Returns the Jakarta (WIB) weekday and wall-clock time for a Date.
 * Intl is used instead of manual offset math so the result stays correct if
 * the deployment host runs in UTC.
 */
export function describeRequestedTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid requested time.');
  }

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  let hour = Number.parseInt(parts.hour, 10);
  if (hour === 24) {
    hour = 0;
  }
  const minute = Number.parseInt(parts.minute, 10);
  const day = parts.weekday;
  const dayIndex = DAY_INDEX[day];
  const weekend = dayIndex === 0 || dayIndex === 6;
  const minutesOfDay = hour * 60 + minute;
  const bucket = timeBucketFor(minutesOfDay);
  const paddedHour = String(hour).padStart(2, '0');
  const paddedMinute = String(minute).padStart(2, '0');

  return {
    iso: date.toISOString(),
    wib: `${day}, ${paddedHour}:${paddedMinute} WIB`,
    day,
    day_index: dayIndex,
    day_type: weekend ? 'weekend' : 'weekday',
    hour,
    minute,
    minutes_of_day: minutesOfDay,
    bucket: bucket.id,
    bucket_label: bucket.label
  };
}

export function minutesToHuman(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours === 0) {
    return `${rest} min`;
  }
  if (rest === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${rest} min`;
}
