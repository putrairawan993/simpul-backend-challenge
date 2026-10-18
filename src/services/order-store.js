import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Small append-only order log. It keeps the deployment dependency-free while
 * still preserving every decision for audit. A production system would use a
 * transactional database and stock reservations instead.
 */
export function createOrderStore(filePath) {
  const orders = new Map();

  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const record = JSON.parse(line);
          if (record && typeof record.order_id === 'string') {
            orders.set(record.order_id, record);
          }
        } catch {
          // Ignore a torn or hand-edited line instead of failing startup.
        }
      }
    }
  }

  return {
    create(record) {
      orders.set(record.order_id, record);
      if (filePath) {
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      }
      return record;
    },
    get(orderId) {
      return orders.get(orderId) ?? null;
    },
    list(limit = 20) {
      return [...orders.values()]
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .slice(0, limit);
    },
    count() {
      return orders.size;
    }
  };
}

export function buildOrderId(now = new Date(), uuid = randomUUID()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `ORD-${stamp}-${uuid.slice(0, 6).toUpperCase()}`;
}
