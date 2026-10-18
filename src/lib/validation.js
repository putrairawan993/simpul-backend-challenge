import { ALLOCATION_LIMITS } from '../config.js';

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeOrderInput(body, productMap) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }

  if (body.customer_id !== undefined && body.customer_id !== 'CUST-1') {
    throw new ApiError(
      400,
      'UNKNOWN_CUSTOMER',
      'This challenge uses a single customer location. Use customer_id "CUST-1" or omit it.',
      { customer_id: body.customer_id }
    );
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError(400, 'INVALID_ITEMS', 'items must be a non-empty array.');
  }

  if (body.items.length > ALLOCATION_LIMITS.max_items_per_order) {
    throw new ApiError(
      400,
      'TOO_MANY_ITEMS',
      `An order may contain at most ${ALLOCATION_LIMITS.max_items_per_order} item lines.`
    );
  }

  const merged = new Map();

  body.items.forEach((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new ApiError(400, 'INVALID_ITEM', `items[${index}] must be an object.`, { index });
    }

    const productId =
      typeof rawItem.product_id === 'string' ? rawItem.product_id.trim() : '';
    if (!productId) {
      throw new ApiError(400, 'INVALID_PRODUCT_ID', `items[${index}].product_id is required.`, {
        index
      });
    }

    if (!productMap.has(productId)) {
      throw new ApiError(400, 'UNKNOWN_PRODUCT', `Unknown product_id: ${productId}`, {
        index,
        product_id: productId
      });
    }

    const quantity = rawItem.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ApiError(
        400,
        'INVALID_QUANTITY',
        `items[${index}].quantity must be a positive integer.`,
        { index, quantity }
      );
    }

    if (quantity > ALLOCATION_LIMITS.max_quantity_per_item) {
      throw new ApiError(
        400,
        'QUANTITY_TOO_LARGE',
        `items[${index}].quantity exceeds the ${ALLOCATION_LIMITS.max_quantity_per_item} unit limit.`,
        { index, quantity }
      );
    }

    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  });

  const totalQuantity = [...merged.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (totalQuantity > ALLOCATION_LIMITS.max_total_quantity) {
    throw new ApiError(
      400,
      'ORDER_TOO_LARGE',
      `The total order quantity exceeds the ${ALLOCATION_LIMITS.max_total_quantity} unit limit.`,
      { total_quantity: totalQuantity }
    );
  }

  let requestedAt = new Date();
  if (body.requested_at !== undefined && body.requested_at !== null && body.requested_at !== '') {
    if (typeof body.requested_at !== 'string') {
      throw new ApiError(400, 'INVALID_REQUESTED_AT', 'requested_at must be an ISO 8601 string.');
    }
    requestedAt = new Date(body.requested_at);
    if (Number.isNaN(requestedAt.getTime())) {
      throw new ApiError(400, 'INVALID_REQUESTED_AT', 'requested_at is not a valid date.', {
        requested_at: body.requested_at
      });
    }
  }

  return {
    items: [...merged.entries()].map(([product_id, quantity]) => ({ product_id, quantity })),
    requestedAt
  };
}
