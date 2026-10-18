import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_MODEL, SERVICE } from './config.js';
import { CUSTOMER } from './data/seed.js';
import { metaPayload, productsPayload, warehousesPayload } from './data/catalog.js';
import { describeRequestedTime } from './lib/time.js';
import { ApiError, normalizeOrderInput } from './lib/validation.js';
import { planOrder } from './services/allocation.js';
import { buildOrderId } from './services/order-store.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(moduleDir, '..', 'public');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"
  );
  next();
}

function requestLogger(logger) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
    });
    next();
  };
}

function orderSummary(record) {
  return {
    order_id: record.order_id,
    created_at: record.created_at,
    status: record.status,
    requested_at: record.requested_time?.iso ?? null,
    customer: record.customer ?? null,
    items_requested: record.request?.items ?? [],
    warehouses_used: record.decision?.warehouses_used ?? [],
    total_cost_idr: record.decision?.total_cost_idr ?? 0
  };
}

export function createApp({
  products,
  warehouses,
  etaModel,
  orderStore,
  logger = console
}) {
  const productMap = new Map(products.map((product) => [product.id, product]));
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(securityHeaders);
  app.use(requestLogger(logger));
  app.use(express.static(publicDir));

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: SERVICE.name,
      version: SERVICE.version,
      uptime_seconds: Math.round(process.uptime()),
      orders_recorded: orderStore.count()
    });
  });

  app.get('/api/meta', (req, res) => {
    res.json(metaPayload(etaModel));
  });

  app.get('/api/products', (req, res) => {
    const payload = productsPayload();
    res.json({ count: payload.length, products: payload });
  });

  app.get('/api/warehouses', (req, res) => {
    const payload = warehousesPayload();
    res.json({ count: payload.length, warehouses: payload });
  });

  app.get('/api/delivery-patterns', (req, res) => {
    res.json(etaModel.analytics());
  });

  app.post('/api/orders', (req, res) => {
    const { items, requestedAt } = normalizeOrderInput(req.body, productMap);
    const requestedTime = describeRequestedTime(requestedAt);
    const decision = planOrder({
      lines: items,
      products,
      warehouses,
      etaModel,
      requestedTime,
      costModel: COST_MODEL
    });

    const createdAt = new Date();
    const record = {
      order_id: buildOrderId(createdAt),
      created_at: createdAt.toISOString(),
      customer: { id: CUSTOMER.id, name: CUSTOMER.name, city: CUSTOMER.city },
      request: {
        items,
        requested_at: requestedAt.toISOString()
      },
      ...decision,
      engine: {
        service: SERVICE.name,
        version: SERVICE.version,
        cost_model: COST_MODEL
      }
    };

    orderStore.create(record);
    res.status(201).location(`/api/orders/${record.order_id}`).json(record);
  });

  app.get('/api/orders', (req, res) => {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const orders = orderStore.list(limit).map(orderSummary);
    res.json({ count: orders.length, total_recorded: orderStore.count(), orders });
  });

  app.get('/api/orders/:orderId', (req, res) => {
    const record = orderStore.get(req.params.orderId);
    if (!record) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order decision not found.');
    }
    res.json(record);
  });

  app.use('/api', (req, res, next) => {
    next(new ApiError(404, 'ENDPOINT_NOT_FOUND', 'API endpoint not found.'));
  });

  app.get('*', (req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    if (error instanceof ApiError) {
      return res.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON.'
        }
      });
    }
    logger.error(error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error.'
      }
    });
  });

  return app;
}
