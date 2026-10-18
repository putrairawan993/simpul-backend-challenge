export const CUSTOMER = Object.freeze({
  id: 'CUST-1',
  name: 'Customer 1',
  city: 'Surabaya',
  note: 'Single customer location. Every warehouse distance is measured from here.'
});

export const PRODUCTS = Object.freeze([
  {
    id: 'P001',
    name: 'Surgical Gloves (Box of 100)',
    category: 'Medical Supplies',
    cold_chain: false
  },
  {
    id: 'P002',
    name: 'Vaccine - Hepatitis B (10-dose vial)',
    category: 'Pharmaceutical',
    cold_chain: true
  },
  {
    id: 'P003',
    name: 'Disposable Syringe (Box of 50)',
    category: 'Medical Supplies',
    cold_chain: false
  },
  {
    id: 'P004',
    name: 'Vaccine - Tetanus Toxoid (10-dose vial)',
    category: 'Pharmaceutical',
    cold_chain: true
  },
  {
    id: 'P005',
    name: 'Paracetamol Tablets (Box of 100)',
    category: 'Pharmaceutical',
    cold_chain: false
  }
]);

export const WAREHOUSES = Object.freeze([
  {
    id: 'W01',
    name: 'Surabaya General Warehouse',
    city: 'Surabaya',
    distance_km: 5,
    refrigerated_storage: false,
    refrigerated_fleet: false,
    stock: { P001: 200, P003: 500, P005: 300 }
  },
  {
    id: 'W02',
    name: 'Surabaya Cold Storage',
    city: 'Surabaya',
    distance_km: 12,
    refrigerated_storage: true,
    refrigerated_fleet: false,
    stock: { P001: 50, P002: 30, P004: 20 }
  },
  {
    id: 'W03',
    name: 'Sidoarjo General Warehouse',
    city: 'Sidoarjo',
    distance_km: 25,
    refrigerated_storage: false,
    refrigerated_fleet: false,
    stock: { P001: 300, P003: 200 }
  },
  {
    id: 'W04',
    name: 'Gresik Cold Chain Hub',
    city: 'Gresik',
    distance_km: 30,
    refrigerated_storage: true,
    refrigerated_fleet: true,
    stock: { P002: 40, P004: 25, P005: 100 }
  },
  {
    id: 'W05',
    name: 'Malang General Warehouse',
    city: 'Malang',
    distance_km: 90,
    refrigerated_storage: false,
    refrigerated_fleet: false,
    stock: { P001: 400, P003: 300, P005: 500 }
  },
  {
    id: 'W06',
    name: 'Malang Cold Storage',
    city: 'Malang',
    distance_km: 95,
    refrigerated_storage: true,
    refrigerated_fleet: false,
    stock: { P002: 20, P004: 30, P003: 100 }
  },
  {
    id: 'W07',
    name: 'Pasuruan Cold Chain Hub',
    city: 'Pasuruan',
    distance_km: 45,
    refrigerated_storage: true,
    refrigerated_fleet: true,
    stock: { P002: 8, P004: 10, P001: 150 }
  },
  {
    id: 'W08',
    name: 'Jember Cold Chain Hub',
    city: 'Jember',
    distance_km: 150,
    refrigerated_storage: true,
    refrigerated_fleet: true,
    stock: { P002: 60, P004: 50, P005: 200 }
  }
]);
