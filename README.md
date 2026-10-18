# Simpul Warehouse Allocator

Submitted by Putra Irawan
Date: 18 October 2026

## Links

- Full application (backend + UI): https://simpul.170.64.181.117.sslip.io
- Frontend on Vercel: https://simpul-backend-challenge.vercel.app
- Source code: https://github.com/putrairawan993/simpul-backend-challenge

The Vercel deployment serves the static frontend and proxies `/api/*` to the same backend on the VPS, so both URLs use one decision engine and one order log.

## What this does

The service receives an order containing one or more products and quantities, then returns a warehouse allocation plan with:

- the selected warehouse or warehouses,
- the quantity assigned to each warehouse,
- the estimated delivery cost and ETA,
- an explanation of why the plan was chosen,
- explicit shortages when the order cannot be fully covered.

The UI lets the user build an order, choose whether to use the current time or a specific WIB delivery slot, and inspect the decision, cost breakdown, alternative plans, warehouse stock, and the historical delivery insights used by the bonus feature.

## Stack and why

I used Node.js 22 with Express, plain JavaScript, and a static HTML/CSS/JS frontend.

- The decision problem is small (8 warehouses, 5 products), so a dependency-free exhaustive search is fast and easy to audit.
- Express is enough for the API surface. There is no need for a larger framework here.
- The frontend is a single page with no build step beyond copying static files. Vercel can host it directly, while the same files are served by Express on the VPS.
- Orders are appended to a JSONL file. This keeps the deployment self-contained. A production version would use a transactional database, as explained later.
- Docker makes the server deployment reproducible. The existing services on the server were left untouched.

## How the decision works

### 1. Eligibility

A warehouse can supply a product only when it has positive stock for that product.

Vaccines P002 and P004 are treated as cold-chain products. A warehouse must have both refrigerated storage and a refrigerated delivery van to be eligible. This matters in the sample data: W02 and W06 have refrigerated storage and vaccine stock, but their fleets are not refrigerated, so they are excluded from vaccine delivery. They can still supply ambient products.

### 2. Candidate plans

Each used warehouse adds a fixed dispatch cost and a split-handling cost. Because of those fixed costs, the cheapest plan is not always obtained by filling the nearest warehouse first.

The engine therefore enumerates every non-empty subset of warehouses that have relevant stock. With eight warehouses there are 255 subsets. For each subset:

1. Products are allocated nearest-first within the subset.
2. The subset is discarded if any requested quantity cannot be covered.
3. The total modeled cost is calculated.
4. Duplicate plans with the same set of used warehouses are removed.

The best plan is selected by total cost, then by fewer warehouses, then by lower maximum ETA, then by a deterministic warehouse signature. This keeps the result stable across runs.

### 3. Cost model

| Component | Value | Reason |
| --- | ---: | --- |
| Base fee | IDR 25,000 per shipment | Covers dispatch and loading |
| Distance cost | IDR 4,000 per km | Reflects fuel and driver time |
| Cold-chain surcharge | IDR 15,000 per shipment containing a vaccine | Covers refrigerated van handling |
| Extra warehouse penalty | IDR 15,000 per extra warehouse | Discourages unnecessary splits |
| ETA delay penalty | IDR 500 per minute above the distance baseline | Uses historical data only when it has a slot-specific signal |
| Distance baseline | 10 minutes + 1.4 minutes per km | A simple fallback when no history exists |

The values are illustrative. They live in `src/config.js` so they can be tuned without touching the planning logic.

### 4. Partial and unfulfillable orders

I chose to return a best-effort partial plan instead of rejecting the whole order.

For each product, the engine calculates the total eligible stock. It allocates as much as possible, then reports the shortage with a reason. The response status is `fulfilled`, `partial`, or `unfulfillable`. The HTTP response is still a normal order decision, with `201 Created`, because the decision itself was created successfully. This makes the shortage visible to the UI and to any downstream system instead of hiding it behind a generic error.

### 5. Worked examples

All examples use Monday, 19 October 2026 at 10:00 WIB.

| Order | Result | Reasoning |
| --- | --- | --- |
| P001 x 100 | W01, IDR 45,000 | W01 is 5 km away and has enough stock |
| P001 x 250 | W03, IDR 125,000 | One shipment from W03 is cheaper than splitting W01 and W03 |
| P002 x 30 | W04, IDR 160,000 | W02 and W06 are excluded because their fleets are not refrigerated |
| P002 x 65 | W04 + W08, IDR 815,000 | No single eligible cold-chain warehouse has enough stock |
| P002 x 120 | Partial, 108 allocated, 12 short | Total eligible vaccine stock is 108 units |
| P001 x 100 + P002 x 20 | W01 + W04, IDR 220,000 | Ambient stock comes from the nearest warehouse, vaccine stock from the cold-chain hub |

## Bonus: historical delivery data

The CSV is parsed at startup and turned into a small empirical ETA model.

- Records are grouped by warehouse, weekday/weekend, and four time buckets: morning peak, midday, evening peak, and off-peak.
- The model uses the median duration for a warehouse and time bucket.
- A bucket with only one sample is shrunk halfway toward the warehouse median. This prevents a single trip from dominating a decision.
- If a bucket has no samples, the warehouse median is shown as an estimate but no congestion penalty is applied. A warehouse-wide median is too coarse to justify a cost penalty for a specific time slot.
- The analytics endpoint and UI show the medians, sample sizes, ranges, and generated insights.

The insights are deliberately conservative. Comparative claims only use buckets with at least two samples and only compare within the same day type. With 38 records, the data is directional, not a production ETA model.

Observed patterns include:

- W01 weekday evening peak runs about 3.4x slower than weekday midday (median 57 vs 17 minutes, two samples each).
- Long-distance routes of 90 km or more are slower on weekends: median 190 minutes versus 153 minutes on weekdays.
- Several warehouses have only one sample in at least one time bucket. The UI marks this through the sample count, and the planner shrinks those estimates.

The ETA has a small effect on ranking. It can break a close cost tie, but stock availability and distance remain the main drivers. That was intentional: the dataset is too small to let a noisy ETA estimate override the core requirement.

## API

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health and recorded order count |
| GET | `/api/meta` | Products, warehouses, customer, and cost model |
| GET | `/api/products` | Product catalog |
| GET | `/api/warehouses` | Warehouse stock and capabilities |
| GET | `/api/delivery-patterns` | Historical ETA model and insights |
| POST | `/api/orders` | Plan an order and persist the decision |
| GET | `/api/orders/:id` | Retrieve a stored decision |
| GET | `/api/orders?limit=20` | Recent decisions |

### Example request

```json
{
  "customer_id": "CUST-1",
  "items": [
    { "product_id": "P001", "quantity": 100 },
    { "product_id": "P002", "quantity": 20 }
  ],
  "requested_at": "2026-10-19T03:00:00.000Z"
}
```

`requested_at` is optional. If it is omitted, the server uses the current time. The value is interpreted as an ISO 8601 timestamp and converted to Asia/Jakarta for the ETA bucket.

### Example response, trimmed

```json
{
  "order_id": "ORD-20261018132131-A95774",
  "status": "fulfilled",
  "requested_time": {
    "wib": "Mon, 10:00 WIB",
    "day_type": "weekday",
    "bucket": "midday",
    "bucket_label": "Midday (09:30-14:59)"
  },
  "allocations": [
    {
      "warehouse_id": "W01",
      "city": "Surabaya",
      "distance_km": 5,
      "eta_minutes": 17,
      "cold_chain": false,
      "items": [
        { "product_id": "P001", "quantity": 100 }
      ]
    },
    {
      "warehouse_id": "W04",
      "city": "Gresik",
      "distance_km": 30,
      "eta_minutes": 48,
      "cold_chain": true,
      "items": [
        { "product_id": "P002", "quantity": 20 }
      ]
    }
  ],
  "unfulfilled": [],
  "decision": {
    "total_cost_idr": 220000,
    "warehouses_used": ["W01", "W04"],
    "explanation": {
      "summary": "No single warehouse can cover the order at a lower estimated cost, so it is split across 2 warehouses (W01, W04).",
      "factors": [],
      "alternatives": []
    }
  }
}
```

### Error format

```json
{
  "error": {
    "code": "UNKNOWN_PRODUCT",
    "message": "Unknown product_id: P999",
    "details": { "index": 0, "product_id": "P999" }
  }
}
```

Validation covers empty item lists, unknown products, non-positive or fractional quantities, duplicate product lines, oversized orders, invalid timestamps, and malformed JSON.

## Running locally

Requirements: Node.js 22 or newer.

```bash
npm install
npm start
```

The app runs at http://localhost:3000 by default.

Useful commands:

```bash
npm test
npm run analyze
npm run build:static
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./var` | Directory for the order log |
| `ORDERS_FILE` | `$DATA_DIR/orders.jsonl` | Exact order log path |
| `ETA_CSV_PATH` | `./data/customer1-historical.csv` | Historical delivery data |

Docker:

```bash
docker build -t simpul-api .
docker run --rm -p 3000:3000 simpul-api
```

On the VPS, the service uses `docker compose up -d --build`. Orders are stored in the `simpul-orders` volume, so restarting the container does not lose decisions.

## Tests

`npm test` runs 21 tests with Node's built-in test runner.

Coverage includes:

- CSV parsing, quoted fields, BOM handling, and time bucket boundaries.
- Jakarta time conversion independent of the host timezone.
- Bucket-specific ETA prediction and single-sample shrinkage.
- Insight generation without comparisons based on one sample.
- Nearest-warehouse selection, single-warehouse-over-split preference, cold-chain exclusion, multi-warehouse split, partial orders, unfulfillable orders, duplicate line merging, ETA delay cost, and cost reconciliation.
- API health, metadata, order creation, persistence, retrieval, validation errors, order history, and static UI serving.

## Deployment

The VPS already hosted two services. I did not modify their containers, compose project, or data.

- New application directory: `~/simpul-backend`
- New container: `simpul-api`, attached to the existing `istudentplus-api_default` Docker network, port 3000 internal only
- New Caddy site block: `simpul.170.64.181.117.sslip.io`, reverse proxied to `simpul-api:3000`
- The existing Caddyfile was backed up before the change and validated with `caddy validate`
- Caddy was reloaded gracefully, not restarted
- Existing checks before and after: `api.istudentplus.com` returned 404 and the onecrm site returned 401, unchanged

The Vercel project deploys only the static frontend from `dist/`. `vercel.json` rewrites `/api/*` to the VPS backend. This avoids CORS and keeps the frontend and backend independently deployable.

## Repository layout

```text
src/                    Express app, validation, allocation engine, ETA model
public/                 Static UI
data/                   Historical delivery CSV
scripts/                Analysis and static build helpers
test/                   Node test suite
Dockerfile              Production image
docker-compose.yml      VPS deployment on the existing Docker network
vercel.json             Static frontend deployment and API rewrite
```

The README is intentionally not committed to the repository, as requested in the brief.

## Assumptions and trade-offs

- There is one customer location in Surabaya. Distances are fixed inputs from the brief.
- Stock is a read-only snapshot. Planning an order does not reserve or decrement inventory. This keeps the demo repeatable and makes the decision logic easy to inspect. It also means two orders can be planned against the same stock.
- Vaccines require cold-chain storage and a refrigerated van end to end. A warehouse with only one of the two capabilities is not eligible.
- Cost parameters are illustrative. I chose a fixed dispatch fee plus distance because it reflects the real shape of delivery cost better than a pure per-unit score, and because it prevents unnecessary warehouse splits.
- Partial orders are preferred over total rejection. The shortage is explicit and machine-readable.
- The order log is append-only JSONL. It is sufficient for a single-instance demo but not for concurrent multi-instance writes.
- No authentication is implemented, as required by the brief.

## AI-assisted work

I used GitHub Copilot as a coding assistant. It helped with scaffolding, drafting the Express routes, generating the first version of the UI, and writing test cases. I treated its output as a draft and changed several things after reviewing the behavior:

- Cold chain was the main domain decision. I required both refrigerated storage and a refrigerated van for vaccines, rather than treating storage alone as sufficient. That stricter rule excludes W02 and W06 from vaccine delivery, so I added tests around it.
- I debated whether ETA should be a primary ranking factor. I kept it as a small penalty that only applies when the historical data has a sample for the requested day type and time bucket. A warehouse-wide median is still displayed but does not add cost.
- The generated insight code initially compared a single-sample bucket with another bucket and produced misleading ratios. I restricted comparative insights to buckets with at least two samples and kept comparisons within the same day type.
- I considered a per-unit-only cost model and replaced it with a fixed shipment fee, distance cost, cold-chain surcharge, and an explicit split penalty. Tests cover the case where one farther warehouse beats a two-warehouse split.
- I added Jakarta timezone handling explicitly. The server runs in UTC, so relying on local time would have produced wrong ETA buckets.
- I found and fixed a mobile horizontal overflow caused by tables forcing the grid wider than the viewport.
- I tested the container and the reverse proxy on the real server, backed up the existing Caddyfile, validated it before reloading, and checked that the two existing services still responded the same way.

The final decisions, trade-offs, and wording are mine. The test suite is the part I trust most, because it exercises the behavior rather than just the shape of the code.

## What I would do next

1. Replace the JSONL log with a database and add stock reservations, transactions, and idempotency keys. This is the biggest gap between the demo and a real distribution system.
2. Add real distance and routing data, including road networks, delivery windows, and vehicle capacity. Fixed distances are fine for the brief but not for operations.
3. Improve the ETA model with more history, route-level features, time-of-day interactions, and confidence intervals. The current model is intentionally conservative because 38 records are not enough for more.
4. Add authentication, rate limiting, and an audit trail. The brief says no auth, but a public planning endpoint would need protection in production.
5. Add an admin interface for products, warehouses, stock, and cost parameters, with change history.
6. Add observability: structured logs, request IDs, metrics for plan latency and shortage rate, and alerts for failed orders.
7. Add CI for tests and container builds, plus a safer deployment pipeline instead of manual `docker compose up`.
8. Add load tests and concurrency tests, especially around stock reservation once inventory becomes mutable.

## Known limitations

- Stock is static, so repeated demo orders can plan against the same inventory.
- The cost model is illustrative and not calibrated against real freight invoices.
- The ETA sample is small (38 trips), so the bonus output is directional.
- The JSONL order log is not safe for multiple application instances writing at the same time.
- The Vercel frontend depends on the VPS backend being available.
- There is no authentication, as specified by the brief.
