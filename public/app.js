const state = {
  products: [],
  warehouses: [],
  meta: null,
  patterns: null
};

const idrFormatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
});
const numberFormatter = new Intl.NumberFormat('id-ID');

const ETA_SOURCE_LABELS = {
  history_bucket: 'historical median for this time slot',
  history_bucket_shrunk: 'one historical sample, blended with the warehouse median',
  history_warehouse: 'warehouse median, no slot-specific sample',
  distance_baseline: 'distance baseline, no historical sample'
};

const STATUS_LABELS = {
  fulfilled: 'Fulfilled',
  partial: 'Partially fulfilled',
  unfulfillable: 'Cannot fulfill'
};

const $ = (selector) => document.querySelector(selector);

function formatIdr(value) {
  return idrFormatter.format(Number(value) || 0);
}

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function currentWibInputValue() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function productOptions(selectedId) {
  return state.products
    .map(
      (product) =>
        `<option value="${escapeHtml(product.id)}"${product.id === selectedId ? ' selected' : ''}>` +
        `${escapeHtml(product.id)} · ${escapeHtml(product.name)}${product.cold_chain ? ' · cold chain' : ''}` +
        '</option>'
    )
    .join('');
}

function createItemRow(productId = 'P001', quantity = 100) {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <select class="item-product" aria-label="Product">
      ${productOptions(productId)}
    </select>
    <input
      class="item-quantity"
      type="number"
      min="1"
      step="1"
      inputmode="numeric"
      value="${escapeHtml(quantity)}"
      aria-label="Quantity"
    />
    <button type="button" class="remove-item" aria-label="Remove item">×</button>
  `;
  return row;
}

function addItemRow(productId, quantity) {
  $('#item-rows').append(createItemRow(productId, quantity));
}

function clearItemRows() {
  $('#item-rows').replaceChildren();
}

function setLoading(isLoading) {
  const button = $('#submit-order');
  button.disabled = isLoading;
  button.classList.toggle('loading', isLoading);
  button.querySelector('.button-label').textContent = isLoading
    ? 'Finding the best plan'
    : 'Find best warehouses';
}

function showError(message) {
  const box = $('#form-error');
  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  const box = $('#form-error');
  box.textContent = '';
  box.hidden = true;
}

function readItems() {
  const rows = [...document.querySelectorAll('.item-row')];
  if (rows.length === 0) {
    throw new Error('Add at least one item to the order.');
  }

  const items = [];
  for (const row of rows) {
    const productId = row.querySelector('.item-product').value;
    const rawQuantity = row.querySelector('.item-quantity').value.trim();
    const quantity = Number(rawQuantity);
    if (!rawQuantity || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error('Every item needs a positive whole-number quantity.');
    }
    items.push({ product_id: productId, quantity });
  }
  return items;
}

function getRequestedAt() {
  const mode = document.querySelector('input[name="time-mode"]:checked').value;
  if (mode === 'now') {
    return undefined;
  }

  const value = $('#requested-at').value;
  if (!value) {
    throw new Error('Choose a delivery date and time, or switch back to Now.');
  }

  const hasSeconds = value.length > 16;
  const parsed = new Date(`${value}${hasSeconds ? '' : ':00'}+07:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('The selected delivery time is not valid.');
  }
  return parsed.toISOString();
}

function statusBadge(status) {
  const label = STATUS_LABELS[status] ?? status;
  return `<span class="status-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function allocationCard(allocation) {
  const itemRows = allocation.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.product_id)}</td>
          <td>${escapeHtml(item.product_name)}</td>
          <td>${formatNumber(item.quantity)}</td>
        </tr>
      `
    )
    .join('');

  const etaSource = ETA_SOURCE_LABELS[allocation.eta_source] ?? allocation.eta_source;
  const peakAdjustment =
    allocation.eta_delay_minutes > 0
      ? ` · +${allocation.eta_delay_minutes} min peak adjustment`
      : '';
  const coldBadge = allocation.cold_chain
    ? '<span class="cold-badge">Cold chain</span>'
    : '';

  return `
    <article class="allocation-card">
      <header>
        <div>
          <h3>${escapeHtml(allocation.warehouse_id)} · ${escapeHtml(allocation.warehouse_name)}</h3>
          <p class="allocation-meta">
            ${escapeHtml(allocation.city)} · ${allocation.distance_km} km ·
            ETA ${allocation.eta_minutes} min (${escapeHtml(etaSource)})${peakAdjustment}
          </p>
        </div>
        ${coldBadge}
      </header>
      <table class="allocation-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Product</th>
            <th>Qty</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
      <div class="allocation-cost">
        <span>${formatNumber(allocation.quantity_total)} units · delivery ${formatIdr(allocation.cost.subtotal_idr)}</span>
        <strong>${formatIdr(allocation.cost.subtotal_idr)}</strong>
      </div>
    </article>
  `;
}

function shortageAlert(order) {
  if (!order.unfulfilled || order.unfulfilled.length === 0) {
    return '';
  }

  const items = order.unfulfilled
    .map(
      (line) =>
        `<li><strong>${escapeHtml(line.product_name)}</strong> — requested ${formatNumber(
          line.requested_quantity
        )}, allocated ${formatNumber(line.allocated_quantity)}, short ${formatNumber(
          line.shortage_quantity
        )}. ${escapeHtml(line.reason)}</li>`
    )
    .join('');

  return `
    <div class="alert">
      <strong>Stock shortfall</strong>
      <ul>${items}</ul>
    </div>
  `;
}

function factorsDetail(explanation) {
  const factors = (explanation.factors ?? [])
    .map((factor) => `<li>${escapeHtml(factor)}</li>`)
    .join('');
  const exclusions = explanation.cold_chain_exclusions ?? [];
  const exclusionBox =
    exclusions.length > 0
      ? `
        <div class="exclusion-box">
          <strong>Cold-chain exclusions:</strong>
          ${exclusions
            .map((item) => `${escapeHtml(item.warehouse_id)} — ${escapeHtml(item.reason)}`)
            .join(' ')}
        </div>
      `
      : '';
  const assumptions = (explanation.assumptions ?? [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');

  return `
    <details open>
      <summary>Why this decision</summary>
      <div>
        <ul class="factor-list">${factors}</ul>
        ${exclusionBox}
        <p class="hint" style="margin-top:0.8rem">Assumptions</p>
        <ul class="assumption-list">${assumptions}</ul>
      </div>
    </details>
  `;
}

function costDetail(breakdown) {
  if (!breakdown || !breakdown.shipments || breakdown.shipments.length === 0) {
    return '';
  }

  const rows = breakdown.shipments
    .map(
      (shipment) => `
        <tr>
          <td>${escapeHtml(shipment.warehouse_id)}</td>
          <td>${formatIdr(shipment.base_fee_idr)}</td>
          <td>${formatIdr(shipment.distance_cost_idr)}</td>
          <td>${formatIdr(shipment.cold_chain_surcharge_idr)}</td>
          <td>${formatIdr(shipment.delay_cost_idr)}</td>
          <td>${formatIdr(shipment.subtotal_idr)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <details>
      <summary>Cost breakdown</summary>
      <div class="table-scroll">
        <table class="cost-table">
          <thead>
            <tr>
              <th>Warehouse</th>
              <th>Base</th>
              <th>Distance</th>
              <th>Cold chain</th>
              <th>ETA delay</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
            ${
              breakdown.split_penalty_idr > 0
                ? `<tr><td colspan="5">Split handling penalty</td><td>${formatIdr(
                    breakdown.split_penalty_idr
                  )}</td></tr>`
                : ''
            }
            <tr>
              <td colspan="5"><strong>Total estimated cost</strong></td>
              <td><strong>${formatIdr(breakdown.total_idr)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  `;
}

function alternativesDetail(explanation) {
  const alternatives = explanation.alternatives ?? [];
  if (alternatives.length === 0) {
    return '';
  }

  const rows = alternatives
    .map(
      (plan) => `
        <tr>
          <td>#${plan.rank}</td>
          <td>${plan.warehouses.map((id) => escapeHtml(id)).join(' + ')}</td>
          <td>${formatIdr(plan.total_cost_idr)}</td>
          <td>${escapeHtml(plan.extra_cost_label)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <details>
      <summary>Other plans considered</summary>
      <div class="table-scroll">
        <table class="alt-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Warehouses</th>
              <th>Estimated cost</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint">${
          explanation.search
            ? `${escapeHtml(explanation.search.method)} · ${formatNumber(
                explanation.search.plans_evaluated
              )} distinct plans evaluated across ${formatNumber(
                explanation.search.warehouses_considered
              )} warehouses.`
            : ''
        }</p>
      </div>
    </details>
  `;
}

function renderResult(order) {
  $('#result-empty').hidden = true;
  const content = $('#result-content');
  content.hidden = false;
  $('#result-order-id').textContent = order.order_id ?? '';

  const allocations = order.allocations ?? [];
  const allocationCards = allocations.map(allocationCard).join('');
  const totals =
    allocations.length > 0
      ? `
        <div class="totals">
          <span>${formatNumber(allocations.reduce((sum, item) => sum + item.quantity_total, 0))} units across ${allocations.length} warehouse${allocations.length === 1 ? '' : 's'}</span>
          <strong>${formatIdr(order.decision.total_cost_idr)}</strong>
        </div>
      `
      : '';

  content.innerHTML = `
    <div class="result-top">
      ${statusBadge(order.status)}
      <span class="result-time">Requested: ${escapeHtml(order.requested_time.wib)} · ${escapeHtml(
        order.requested_time.bucket_label
      )}</span>
    </div>
    <p class="summary">${escapeHtml(order.decision.explanation.summary)}</p>
    ${shortageAlert(order)}
    ${allocationCards ? `<div class="allocation-list">${allocationCards}</div>` : ''}
    ${totals}
    ${factorsDetail(order.decision.explanation)}
    ${costDetail(order.decision.cost_breakdown)}
    ${alternativesDetail(order.decision.explanation)}
  `;
}

function renderProducts(products) {
  $('#product-count').textContent = `${products.length} products`;
  const body = $('#products-table tbody');
  body.innerHTML = products
    .map(
      (product) => `
        <tr>
          <td class="mono">${escapeHtml(product.id)}</td>
          <td>${escapeHtml(product.name)}</td>
          <td>${escapeHtml(product.category)}</td>
          <td>${
            product.cold_chain
              ? '<span class="tag cold">Cold chain</span>'
              : '<span class="tag">Ambient</span>'
          }</td>
        </tr>
      `
    )
    .join('');
}

function renderWarehouses(warehouses) {
  $('#warehouse-count').textContent = `${warehouses.length} warehouses`;
  const body = $('#warehouses-table tbody');
  body.innerHTML = warehouses
    .map((warehouse) => {
      const stock = Object.entries(warehouse.stock ?? {})
        .map(([productId, quantity]) => `${productId} ${formatNumber(quantity)}`)
        .join(' · ');
      return `
        <tr>
          <td class="mono">${escapeHtml(warehouse.id)}</td>
          <td>${escapeHtml(warehouse.city)}<br /><span class="hint">${escapeHtml(
            warehouse.name
          )}</span></td>
          <td>${warehouse.distance_km} km</td>
          <td>
            <span class="tag ${warehouse.refrigerated_storage ? 'yes' : 'no'}">Storage ${
              warehouse.refrigerated_storage ? 'cold' : 'ambient'
            }</span>
            <span class="tag ${warehouse.refrigerated_fleet ? 'yes' : 'no'}">Fleet ${
              warehouse.refrigerated_fleet ? 'refrigerated' : 'standard'
            }</span>
          </td>
          <td>${escapeHtml(stock)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderInsights(patterns) {
  $('#eta-caveat').textContent = patterns.caveat ?? '';
  const insights = patterns.insights ?? [];
  $('#insights-list').innerHTML = insights
    .map((insight) => `<div class="insight-card">${escapeHtml(insight)}</div>`)
    .join('');

  const rows = [];
  for (const warehouse of patterns.warehouses ?? []) {
    if (!warehouse.groups || warehouse.groups.length === 0) {
      rows.push(`
        <tr>
          <td class="mono">${escapeHtml(warehouse.warehouse_id)}</td>
          <td colspan="5">No historical samples</td>
        </tr>
      `);
      continue;
    }
    for (const group of warehouse.groups) {
      rows.push(`
        <tr>
          <td class="mono">${escapeHtml(warehouse.warehouse_id)} · ${escapeHtml(
            warehouse.city
          )}</td>
          <td>${escapeHtml(group.day_type)}</td>
          <td>${escapeHtml(group.bucket_label)}</td>
          <td>${formatNumber(group.sample_size)}</td>
          <td>${formatNumber(group.median_minutes)} min</td>
          <td>${formatNumber(group.min_minutes)}–${formatNumber(group.max_minutes)} min</td>
        </tr>
      `);
    }
  }
  $('#patterns-table tbody').innerHTML = rows.join('');
}

async function checkHealth() {
  const chip = $('#api-status');
  const label = $('#api-status-text');
  try {
    const response = await fetch('/api/health');
    if (!response.ok) {
      throw new Error('Health check failed.');
    }
    chip.classList.add('online');
    chip.classList.remove('offline');
    label.textContent = 'API online';
  } catch {
    chip.classList.add('offline');
    chip.classList.remove('online');
    label.textContent = 'API offline';
  }
}

async function loadData() {
  const [metaResponse, patternsResponse] = await Promise.all([
    fetch('/api/meta'),
    fetch('/api/delivery-patterns')
  ]);

  if (!metaResponse.ok || !patternsResponse.ok) {
    throw new Error('Could not load the warehouse data from the API.');
  }

  state.meta = await metaResponse.json();
  state.patterns = await patternsResponse.json();
  state.products = state.meta.products ?? [];
  state.warehouses = state.meta.warehouses ?? [];

  renderProducts(state.products);
  renderWarehouses(state.warehouses);
  renderInsights(state.patterns);

  clearItemRows();
  addItemRow('P001', 100);
}

function bindEvents() {
  $('#add-item').addEventListener('click', () => {
    addItemRow('P001', 100);
  });

  $('#sample-order').addEventListener('click', () => {
    clearItemRows();
    addItemRow('P001', 100);
    addItemRow('P002', 20);
    clearError();
  });

  document.querySelectorAll('input[name="time-mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      const custom = document.querySelector('input[name="time-mode"]:checked').value === 'custom';
      const field = $('#requested-at');
      field.disabled = !custom;
      if (custom) {
        if (!field.value) {
          field.value = currentWibInputValue();
        }
      } else {
        field.value = '';
      }
      $('#time-hint').textContent = custom
        ? 'The selected Jakarta (WIB) time is used for the ETA bucket.'
        : 'The current Jakarta time is used for the ETA bucket.';
    });
  });

  $('#item-rows').addEventListener('click', (event) => {
    const button = event.target.closest('.remove-item');
    if (!button) {
      return;
    }
    button.closest('.item-row').remove();
  });

  $('#order-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    try {
      const items = readItems();
      const payload = { customer_id: 'CUST-1', items };
      const requestedAt = getRequestedAt();
      if (requestedAt) {
        payload.requested_at = requestedAt;
      }

      setLoading(true);
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error?.message ?? `Request failed with status ${response.status}.`);
      }

      renderResult(data);
      if (window.matchMedia('(max-width: 980px)').matches) {
        document.querySelector('.result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (error) {
      showError(error.message || 'Something went wrong while planning the order.');
    } finally {
      setLoading(false);
    }
  });
}

async function init() {
  bindEvents();
  checkHealth();
  try {
    await loadData();
  } catch (error) {
    showError(error.message);
  }
}

init();
