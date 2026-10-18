import { CUSTOMER, PRODUCTS, WAREHOUSES } from './seed.js';
import { COST_MODEL, SERVICE } from '../config.js';

export function productsPayload() {
  return PRODUCTS.map((product) => ({ ...product }));
}

export function warehousesPayload() {
  return WAREHOUSES.map((warehouse) => ({
    ...warehouse,
    stock: { ...warehouse.stock }
  }));
}

export function metaPayload(etaModel) {
  const analytics = etaModel.analytics();
  return {
    service: SERVICE.name,
    version: SERVICE.version,
    customer: { ...CUSTOMER },
    cost_model: { ...COST_MODEL },
    products: productsPayload(),
    warehouses: warehousesPayload(),
    eta: {
      source_label: analytics.source_label,
      caveat: analytics.caveat
    }
  };
}
