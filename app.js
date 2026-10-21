import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// =====================================================================
// Helpers
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (v == null || v === '' ? '' : Number(v).toFixed(d));
const localDate = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isError ? 6000 : 2500);
}

// Run a Supabase request; show the error and stop if it fails.
async function q(request) {
  const { data, error } = await request;
  if (error) { toast(error.message, true); throw error; }
  return data;
}

// =====================================================================
// Reference data used across screens
// =====================================================================
const refs = { riders: [], turnouts: [], fields: [], leases: [], crops: [] };

async function loadRefs() {
  const [riders, turnouts, fields, leases, crops] = await Promise.all([
    q(sb.from('ditch_riders').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('turnouts').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('fields').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('leases').select('*')),
    q(sb.from('crops').select('*').order('name')),
  ]);
  Object.assign(refs, { riders, turnouts, fields, leases, crops });
}

// Deeded unless a lease or partnership is in effect today.
// A split half with no agreement of its own follows its parent.
function currentAgreement(fieldId) {
  const today = localDate();
  return refs.leases
    .filter((l) => l.field_id === fieldId && l.start_date <= today && (!l.end_date || l.end_date >= today))
    .sort((a, b) => b.start_date.localeCompare(a.start_date))[0] ?? null;
}
function tenureOf(f) {
  const a = currentAgreement(f.field_id) ?? (f.parent_field_id ? currentAgreement(f.parent_field_id) : null);
  if (!a) return 'Deeded';
  const label = { partnership: 'Partnership', leased_out: 'Leased out' }[a.agreement_type] ?? 'Leased';
  return `${label} (${a.lessor})`;
}

// The agreement leasing this field OUT to someone else at any point in a season, if any.
function leasedOutIn(fieldId, season) {
  const f = fieldById(fieldId);
  const ids = [fieldId, f?.parent_field_id].filter(Boolean);
  return refs.leases.find((l) => ids.includes(l.field_id) && l.agreement_type === 'leased_out'
    && l.start_date <= `${season}-12-31` && (!l.end_date || l.end_date >= `${season}-01-01`)) ?? null;
}
const fieldById = (id) => refs.fields.find((f) => f.field_id === Number(id));
const fieldName = (id) => fieldById(id)?.name ?? '';

// =====================================================================
// Generic list + edit screens (fields and setup tables)
// =====================================================================
const CRUD = {
  fields: {
    table: 'fields', pk: 'field_id', title: 'Fields', singular: 'field', order: ['sort_order', 'name'],
    search: true, refreshRefs: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'farm_unit', label: 'Farm unit', type: 'text', list: true },
      { key: 'block', label: 'Block', type: 'text' },
      { key: 'acres', label: 'Acres', type: 'number', step: '0.01', list: true },
      { key: 'tenure', label: 'Ground', list: true, form: false, compute: tenureOf },
      { key: 'turnout_id', label: 'Turnout', type: 'select', num: true, list: true,
        options: () => refs.turnouts.map((t) => [t.turnout_id, t.name]) },
      { key: 'flow_rate_cfs', label: 'Flow rate (CFS)', type: 'number', step: '0.01', list: true },
      { key: 'parent_field_id', label: 'Parent field (only for split halves)', type: 'select', num: true, list: true,
        options: (row) => refs.fields
          .filter((f) => !f.parent_field_id && f.field_id !== row?.field_id)
          .map((f) => [f.field_id, f.name]) },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    // Split halves share the parent's turnout, so they can't have their own.
    afterRender(form) {
      const parent = form.elements.parent_field_id;
      const turnout = form.elements.turnout_id;
      const sync = () => {
        const isHalf = !!parent.value;
        turnout.disabled = isHalf;
        if (isHalf) turnout.value = '';
      };
      parent.addEventListener('change', sync);
      sync();
    },
    beforeSave(d) { if (d.parent_field_id) d.turnout_id = null; },
  },
  riders: {
    table: 'ditch_riders', pk: 'rider_id', title: 'Ditch riders', singular: 'ditch rider', order: ['sort_order', 'name'],
    refreshRefs: true, allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'phone', label: 'Phone', type: 'text', list: true },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
  },
  turnouts: {
    table: 'turnouts', pk: 'turnout_id', title: 'Turnouts', singular: 'turnout', order: ['sort_order', 'name'],
    refreshRefs: true, allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'rider_id', label: 'Ditch rider', type: 'select', num: true, required: true, list: true,
        options: () => refs.riders.map((r) => [r.rider_id, r.name]) },
      { key: 'notes', label: 'Notes', type: 'textarea', list: true },
    ],
  },
  operators: {
    table: 'operators', pk: 'operator_id', title: 'Operators', singular: 'operator', order: 'name',
    allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'type', label: 'Type', type: 'select', required: true, list: true,
        options: () => [['partner', 'Partner'], ['employee', 'Employee'], ['contractor', 'Contractor']] },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
  },
  chemicals: {
    table: 'chemicals', pk: 'chemical_id', title: 'Chemicals', singular: 'chemical', order: 'name',
    allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'active_ingredient', label: 'Active ingredient', type: 'text', list: true },
      { key: 'type', label: 'Type', type: 'select', required: true, list: true,
        options: () => ['fertilizer', 'herbicide', 'insecticide', 'fungicide', 'adjuvant', 'other']
          .map((t) => [t, t[0].toUpperCase() + t.slice(1)]) },
      { key: 'unit', label: 'Unit (gal, lb, oz, ton)', type: 'text', required: true, list: true },
      { key: 'epa_reg_no', label: 'EPA reg. no.', type: 'text', list: true },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
  },
  equipment: {
    table: 'equipment', pk: 'equipment_id', title: 'Equipment', singular: 'equipment', order: 'name',
    allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'type', label: 'Type', type: 'text', list: true },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  crops: {
    table: 'crops', pk: 'crop_id', title: 'Crops', singular: 'crop', order: 'name',
    refreshRefs: true, allowDelete: true,
    columns: [
      { key: 'name', label: 'Crop', type: 'text', required: true, list: true },
      { key: 'yield_unit', label: 'Usual yield unit', type: 'select', list: true,
        options: () => [['bu', 'Bushels (bu)'], ['ton', 'Tons'], ['cwt', 'Hundredweight (cwt)'], ['lb', 'Pounds (lb)']] },
      { key: 'multi_year', label: 'Usually a multi-year stand', type: 'checkbox', default: false, list: true },
      { key: 'color', label: 'Map color', type: 'color', list: true,
        fallback: (row) => (row ? PALETTE[row.crop_id % PALETTE.length] : '#2563a8') },
      { key: 'active', label: 'Active (shows in the crop list)', type: 'checkbox', default: true, list: true },
    ],
  },
  leases: {
    table: 'leases', pk: 'lease_id', title: 'Leases & partnerships', singular: 'lease or partnership',
    order: 'start_date', allowDelete: true, refreshRefs: true,
    columns: [
      { key: 'field_id', label: 'Field', type: 'select', num: true, required: true, list: true,
        options: () => refs.fields.map((f) => [f.field_id, f.name]) },
      { key: 'agreement_type', label: 'Type', type: 'select', required: true, list: true, default: 'lease',
        options: () => [['lease', 'Lease (we rent it)'], ['partnership', 'Partnership'], ['leased_out', 'Leased out (we rent it to them)']] },
      { key: 'lessor', label: 'Other party (landowner, partner grower, or tenant)', type: 'text', required: true, list: true },
      { key: 'start_date', label: 'Start date', type: 'date', required: true, list: true },
      { key: 'end_date', label: 'End date', type: 'date', list: true },
      { key: 'rate', label: 'Rate (leave blank for partnerships)', type: 'number', step: '0.01', list: true },
      { key: 'rate_basis', label: 'Rate basis (per acre, flat, crop share)', type: 'text', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
};

function display(c, r) {
  if (c.compute) return c.compute(r);
  const v = r[c.key];
  if (c.type === 'checkbox') return v ? 'Yes' : 'No';
  if (c.type === 'select') return c.options(null).find(([val]) => String(val) === String(v))?.[1] ?? '';
  return v ?? '';
}

async function renderCrud(cfg, el) {
  let req = sb.from(cfg.table).select('*');
  for (const col of [].concat(cfg.order)) req = req.order(col, { nullsFirst: false });
  const rows = await q(req);
  const cols = cfg.columns.filter((c) => c.list);
  el.innerHTML = `
    <div class="section-head"><h2>${esc(cfg.title)}</h2>
      <button class="primary" data-act="add">Add ${esc(cfg.singular)}</button></div>
    ${cfg.search ? `<input type="search" class="search" placeholder="Search ${esc(cfg.title.toLowerCase())}…">` : ''}
    <div class="card table-wrap"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.length ? rows.map((r) => `<tr>
          ${cols.map((c) => c.type === 'color'
            ? `<td><span class="swatch" style="background:${esc(r[c.key] || c.fallback(r))}"></span></td>`
            : `<td>${esc(display(c, r))}</td>`).join('')}
          <td><button class="small" data-edit="${r[cfg.pk]}">Edit</button></td></tr>`).join('')
        : `<tr><td colspan="${cols.length + 1}" class="muted">Nothing here yet.</td></tr>`}
      </tbody></table></div>`;

  const reload = () => renderCrud(cfg, el);
  $('[data-act=add]', el).onclick = () => openForm(cfg, null, reload);
  $$('[data-edit]', el).forEach((b) => (b.onclick = () =>
    openForm(cfg, rows.find((r) => String(r[cfg.pk]) === b.dataset.edit), reload)));

  const search = $('.search', el);
  if (search) search.oninput = () => {
    const term = search.value.toLowerCase();
    $$('tbody tr', el).forEach((tr) => (tr.hidden = !tr.textContent.toLowerCase().includes(term)));
  };
}

function fieldHtml(c, row) {
  if (c.form === false) return '';
  const v = (row ? row[c.key] : c.default) ?? c.fallback?.(row);
  const req = c.required ? 'required' : '';
  const lbl = esc(c.label) + (c.required ? ' *' : '');
  switch (c.type) {
    case 'checkbox':
      return `<label class="check"><input type="checkbox" name="${c.key}" ${v ? 'checked' : ''}> ${esc(c.label)}</label>`;
    case 'textarea':
      return `<label>${lbl}<textarea name="${c.key}" rows="3">${esc(v)}</textarea></label>`;
    case 'select':
      return `<label>${lbl}<select name="${c.key}" ${req}><option value="">—</option>${
        c.options(row).map(([val, text]) =>
          `<option value="${esc(val)}" ${String(val) === String(v ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('')
      }</select></label>`;
    default:
      return `<label>${lbl}<input type="${c.type}" name="${c.key}" value="${esc(v)}" ${c.step ? `step="${c.step}"` : ''} ${req}></label>`;
  }
}

function readForm(cfg, form) {
  const data = {};
  for (const c of cfg.columns) {
    if (c.form === false) continue;
    const input = form.elements[c.key];
    if (c.type === 'checkbox') { data[c.key] = input.checked; continue; }
    const v = input.value.trim();
    data[c.key] = v === '' ? null : (c.type === 'number' || c.num) ? Number(v) : v;
  }
  return data;
}

function openForm(cfg, row, onDone) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form class="form">
      <h3>${row ? 'Edit' : 'Add'} ${esc(cfg.singular)}</h3>
      ${cfg.columns.map((c) => fieldHtml(c, row)).join('')}
      <div class="actions">
        ${row && cfg.allowDelete ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div></form>`;
  const form = $('form', dlg);
  cfg.afterRender?.(form);

  const finish = async (msg) => {
    dlg.close();
    if (cfg.refreshRefs) await loadRefs();
    toast(msg);
    onDone();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = readForm(cfg, form);
    cfg.beforeSave?.(data);
    try {
      if (row) await q(sb.from(cfg.table).update(data).eq(cfg.pk, row[cfg.pk]));
      else await q(sb.from(cfg.table).insert(data));
      await finish('Saved');
    } catch { /* error already shown */ }
  };
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete this ${cfg.singular}? This can't be undone.`)) return;
    try {
      await q(sb.from(cfg.table).delete().eq(cfg.pk, row[cfg.pk]));
      await finish('Deleted');
    } catch { /* usually "still referenced" — message already shown */ }
  };
  dlg.showModal();
}

// =====================================================================
// Water order
// Each order is the full picture for its day. A new day starts as a copy
// of the most recent submitted order, so "no change" is one click.
// =====================================================================
const orderState = {
  date: null, orderId: null, status: null, submittedAt: null,
  lines: new Map(),   // parent field_id -> { is_on, cfs }
  subs: new Map(),    // sub-unit field_id -> watered
  prev: new Map(),    // previous submitted order's lines, for change notes
  prevDate: null,
  dirty: false,       // edited since last save
  water: new Map(),   // field_id -> { running_now, running_since, last_watered }
};

// Optional extra: if this can't load, the order screen still works without the notes.
async function loadWaterStatus() {
  const { data, error } = await sb.from('field_water_status').select('*');
  orderState.water = error ? new Map() : new Map(data.map((r) => [r.field_id, r]));
}

function waterNote(fieldId) {
  const w = orderState.water.get(fieldId);
  if (!w) return '';
  const daysAgo = (iso) => Math.round((new Date(localDate() + 'T12:00:00') - new Date(iso + 'T12:00:00')) / 864e5);
  const fmt = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (w.running_now && w.running_since) {
    const d = daysAgo(w.running_since);
    return `On since ${fmt(w.running_since)}${d > 0 ? ` · ${d} day${d === 1 ? '' : 's'}` : ''}`;
  }
  if (w.last_watered) {
    const d = daysAgo(w.last_watered);
    return `Last water ${fmt(w.last_watered)} · ${d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`}`;
  }
  return 'No water on record';
}

const orderParents = () => refs.fields.filter((f) => f.active && !f.parent_field_id && f.turnout_id);
const subunitsOf = (id) => refs.fields.filter((f) => f.active && f.parent_field_id === id);

function lineFor(f) {
  if (!orderState.lines.has(f.field_id)) {
    orderState.lines.set(f.field_id, { is_on: false, cfs: Number(f.flow_rate_cfs ?? 0) });
  }
  return orderState.lines.get(f.field_id);
}

function turnoutCfs(turnoutId, lineMap) {
  return orderParents()
    .filter((f) => f.turnout_id === turnoutId)
    .reduce((sum, f) => { const l = lineMap.get(f.field_id); return l?.is_on ? sum + Number(l.cfs || 0) : sum; }, 0);
}

async function linesFor(orderId) {
  const [lines, subs] = await Promise.all([
    q(sb.from('water_order_lines').select('*').eq('order_id', orderId)),
    q(sb.from('water_order_subunits').select('*').eq('order_id', orderId)),
  ]);
  return {
    lines: new Map(lines.map((l) => [l.field_id, { is_on: l.is_on, cfs: Number(l.cfs) }])),
    subs: new Map(subs.map((s) => [s.subunit_field_id, s.watered])),
  };
}

async function loadOrder(date) {
  const s = orderState;
  const [existing, prevRows] = await Promise.all([
    q(sb.from('water_orders').select('*').eq('order_date', date).maybeSingle()),
    q(sb.from('water_orders').select('order_id, order_date').lt('order_date', date)
      .neq('status', 'draft').order('order_date', { ascending: false }).limit(1)),
  ]);
  const prevOrder = prevRows[0] ?? null;
  const prev = prevOrder ? await linesFor(prevOrder.order_id) : { lines: new Map(), subs: new Map() };
  s.prev = prev.lines;
  s.prevDate = prevOrder?.order_date ?? null;
  s.dirty = false;

  if (existing) {
    const cur = await linesFor(existing.order_id);
    Object.assign(s, { orderId: existing.order_id, status: existing.status,
      submittedAt: existing.submitted_at, lines: cur.lines, subs: cur.subs });
  } else {
    Object.assign(s, { orderId: null, status: null, submittedAt: null,
      lines: new Map([...prev.lines].map(([k, v]) => [k, { ...v }])), subs: new Map(prev.subs) });
  }
}

function okToLeaveOrder() {
  return !orderState.dirty || confirm('This water order has changes that haven\'t been sent or saved. Leave anyway?');
}

async function renderOrder(el) {
  if (!orderState.date) orderState.date = addDays(localDate(), 1);
  el.innerHTML = `
    <div class="section-head"><h2>Water order</h2>
      <div class="row">
        <button data-shift="-1" aria-label="Previous day">‹</button>
        <input type="date" id="order-date" value="${orderState.date}">
        <button data-shift="1" aria-label="Next day">›</button>
      </div></div>
    <div id="order-body"><p class="muted">Loading…</p></div>`;
  $('#order-date', el).onchange = (e) => { if (!okToLeaveOrder()) { e.target.value = orderState.date; return; } if (e.target.value) { orderState.date = e.target.value; renderOrder(el); } };
  $$('[data-shift]', el).forEach((b) => (b.onclick = () => {
    if (!okToLeaveOrder()) return;
    orderState.date = addDays(orderState.date, Number(b.dataset.shift));
    renderOrder(el);
  }));
  await Promise.all([loadOrder(orderState.date), loadWaterStatus()]);
  drawOrder($('#order-body', el));
}

// A parent with split halves is on whenever any half is on. Bring older
// saved orders into line with that (no "unsaved" flag — nothing changed).
function syncHalves() {
  const s = orderState;
  for (const f of orderParents()) {
    const subs = subunitsOf(f.field_id);
    if (!subs.length) continue;
    const l = lineFor(f);
    const anyOn = subs.some((sf) => s.subs.get(sf.field_id));
    if (l.is_on && !anyOn) subs.forEach((sf) => s.subs.set(sf.field_id, true));
    if (!l.is_on && anyOn) subs.forEach((sf) => s.subs.set(sf.field_id, false));
  }
}

const moveBtns = (kind, id) => `<span class="move">
  <button class="icon" data-move="${kind}:${id}:-1" aria-label="Move up">↑</button>
  <button class="icon" data-move="${kind}:${id}:1" aria-label="Move down">↓</button></span>`;

function drawOrder(body) {
  const s = orderState;
  const parents = orderParents();
  if (!parents.length) {
    body.innerHTML = `<div class="empty">To build an order you need a ditch rider, a turnout assigned to that rider,
      and at least one field assigned to that turnout. Add them under <b>Setup</b> and <b>Fields</b>.</div>`;
    return;
  }
  syncHalves();
  const arrange = !!s.arrange;
  const noTurnout = refs.fields.filter((f) => f.active && !f.parent_field_id && !f.turnout_id).length;

  let html = `<div class="order-bar">
      <p id="order-status"></p>
      <button class="${arrange ? 'primary' : ''} small" data-act="arrange">${arrange ? 'Done arranging' : 'Arrange'}</button>
    </div>
    ${arrange ? '<p class="muted small">Use the arrows to set the order of riders, turnouts and fields. Changes save as you go.</p>' : ''}
    ${noTurnout ? `<p class="muted small">${noTurnout} field(s) have no turnout and aren't shown.</p>` : ''}
    <div class="order-grid${arrange ? ' arranging' : ''}"><div class="order-fields">`;

  for (const r of refs.riders) {
    const tos = refs.turnouts.filter((t) => t.rider_id === r.rider_id && parents.some((f) => f.turnout_id === t.turnout_id));
    if (!tos.length) continue;
    html += `<section class="card rider-card"><div class="rider-head"><h3>${esc(r.name)}</h3>
      ${arrange ? moveBtns('riders', r.rider_id) : ''}</div>`;
    for (const t of tos) {
      html += `<div class="turnout"><div class="turnout-head">
        <span class="turnout-name">Turnout ${esc(t.name)}</span>
        ${arrange ? moveBtns('turnouts', t.turnout_id) : `<span class="pill" data-total="${t.turnout_id}"></span>`}</div>`;
      for (const f of parents.filter((p) => p.turnout_id === t.turnout_id)) {
        const l = lineFor(f);
        const subs = subunitsOf(f.field_id);
        const cfsInput = `<span class="cfs"><input type="number" min="0" step="0.05" inputmode="decimal"
            data-cfs="${f.field_id}" value="${num(l.cfs)}" aria-label="${esc(f.name)} CFS"><span>CFS</span></span>`;
        if (arrange) {
          html += `<div class="field-row"><span class="field-name">${esc(f.name)}</span>${moveBtns('fields', f.field_id)}</div>`;
        } else if (subs.length) {
          html += `<div class="field-row parent ${l.is_on ? 'on' : ''}" data-row="${f.field_id}">
              <span class="field-name">${esc(f.name)}<small>${waterNote(f.field_id)}</small></span>${cfsInput}<span class="toggle-spacer"></span></div>
            ${subs.map((sf) => `<label class="field-row sub ${s.subs.get(sf.field_id) ? 'on' : ''}" data-subrow="${sf.field_id}">
              <span class="field-name">${esc(sf.name)}<small>${waterNote(sf.field_id)}</small></span>
              <input type="checkbox" data-sub="${sf.field_id}" data-parent="${f.field_id}" ${s.subs.get(sf.field_id) ? 'checked' : ''}>
            </label>`).join('')}`;
        } else {
          html += `<div class="field-row ${l.is_on ? 'on' : ''}" data-row="${f.field_id}">
            <label class="field-name" for="on-${f.field_id}">${esc(f.name)}<small>${waterNote(f.field_id)}</small></label>${cfsInput}
            <input type="checkbox" id="on-${f.field_id}" data-on="${f.field_id}" ${l.is_on ? 'checked' : ''}></div>`;
        }
      }
      html += `</div>`;
    }
    html += `</section>`;
  }

  html += `</div>
    <aside class="card order-output">
      <h3>Text for ditch riders</h3>
      <div id="order-text"></div>
      <div class="actions">
        <span class="spacer"></span>
        <button data-save="draft">Save draft</button>
        <button data-save="submitted">Mark as sent</button>
      </div>
    </aside></div>`;
  body.innerHTML = html;

  const changed = () => { s.dirty = true; updateOrderOutput(body); };
  $('[data-act=arrange]', body).onclick = () => { s.arrange = !s.arrange; drawOrder(body); };
  $$('[data-move]', body).forEach((b) => (b.onclick = async () => {
    const [kind, id, dir] = b.dataset.move.split(':');
    await moveItem(kind, Number(id), Number(dir));
    drawOrder(body);
  }));
  $$('[data-on]', body).forEach((cb) => (cb.onchange = () => {
    lineFor(fieldById(cb.dataset.on)).is_on = cb.checked;
    cb.closest('.field-row').classList.toggle('on', cb.checked);
    changed();
  }));
  $$('[data-sub]', body).forEach((cb) => (cb.onchange = () => {
    s.subs.set(Number(cb.dataset.sub), cb.checked);
    cb.closest('.field-row').classList.toggle('on', cb.checked);
    const parent = fieldById(cb.dataset.parent);
    const anyOn = subunitsOf(parent.field_id).some((sf) => s.subs.get(sf.field_id));
    lineFor(parent).is_on = anyOn;
    $(`[data-row="${parent.field_id}"]`, body)?.classList.toggle('on', anyOn);
    changed();
  }));
  $$('[data-cfs]', body).forEach((inp) => (inp.oninput = () => {
    lineFor(fieldById(inp.dataset.cfs)).cfs = Number(inp.value) || 0;
    changed();
  }));
  $$('[data-save]', body).forEach((b) => (b.onclick = () => saveOrder(b.dataset.save, body)));
  updateOrderOutput(body);
}

// Swap an item with its neighbour, renumber the group, save.
async function moveItem(kind, id, dir) {
  const spec = {
    riders: { table: 'ditch_riders', pk: 'rider_id', group: () => refs.riders },
    turnouts: { table: 'turnouts', pk: 'turnout_id', group: (x) => refs.turnouts.filter((t) => t.rider_id === x.rider_id) },
    fields: { table: 'fields', pk: 'field_id', group: (x) => orderParents().filter((f) => f.turnout_id === x.turnout_id) },
  }[kind];
  const item = refs[kind].find((x) => x[spec.pk] === id);
  const list = [...spec.group(item)];
  const i = list.indexOf(item);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const updates = list
    .map((x, n) => ({ id: x[spec.pk], order: (n + 1) * 10, old: x.sort_order }))
    .filter((u) => u.order !== u.old);
  try {
    await Promise.all(updates.map((u) => q(sb.from(spec.table).update({ sort_order: u.order }).eq(spec.pk, u.id))));
    await loadRefs();
  } catch { /* error shown */ }
}

function riderTexts() {
  const s = orderState;
  const out = [];
  for (const r of refs.riders) {
    const rows = [];
    for (const t of refs.turnouts.filter((x) => x.rider_id === r.rider_id)) {
      const now = turnoutCfs(t.turnout_id, s.lines);
      const was = turnoutCfs(t.turnout_id, s.prev);
      if (Math.abs(now - was) < 0.001) continue;          // unchanged: not in the text
      const amount = String(Number(now.toFixed(2)));       // 1.50 -> 1.5, 2.00 -> 2
      if (was === 0) rows.push(`${t.name} on ${amount}`);
      else if (now === 0) rows.push(`${t.name} off to stock`);
      else rows.push(`${t.name} change to ${amount}`);
    }
    if (rows.length) out.push({ rider: r.name, phone: r.phone, text: `Water order for ${fmtDay(s.date)}\n${rows.join('\n')}` });
  }
  return out;
}

function orderStatusHtml() {
  const s = orderState;
  if (s.dirty && s.status === 'submitted') {
    return `<span class="notice">Changed since it was sent. Send the updated text to the ditch riders.</span>`;
  }
  if (s.dirty) return `<span class="notice">Unsaved changes. Send or save before leaving this screen.</span>`;
  if (s.status === 'submitted') {
    return `<span class="badge new">Sent</span> <span class="muted">${s.submittedAt ? esc(fmtTime(s.submittedAt)) : ''}</span>`;
  }
  if (s.status === 'draft') return `<span class="badge down">Draft</span> <span class="muted">not sent yet</span>`;
  return `<span class="badge off">Not sent</span> <span class="muted">${
    s.prevDate ? `pre-filled from ${esc(fmtDay(s.prevDate))}` : ''}</span>`;
}

const smsLink = (phone, text) => `sms:${String(phone).replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(text)}`;

function updateOrderOutput(body) {
  $('#order-status', body).innerHTML = orderStatusHtml();
  $$('[data-total]', body).forEach((el) => {
    const total = turnoutCfs(Number(el.dataset.total), orderState.lines);
    el.textContent = total > 0 ? `${num(total)} CFS` : 'Off';
    el.classList.toggle('on', total > 0);
  });
  const texts = riderTexts();
  $('#order-text', body).innerHTML = texts.length
    ? texts.map((t, i) => `<div class="rider-text">
        <div class="rider-text-head"><b>${esc(t.rider)}</b>
          <span class="row">
            ${t.phone ? `<button class="small primary" data-text="${i}">Text</button>` : ''}
            <button class="small" data-copy="${i}">Copy</button>
          </span></div>
        <pre>${esc(t.text)}</pre>
        ${t.phone ? '' : '<p class="muted small">Add a phone number for this rider under Setup to text from here.</p>'}
      </div>`).join('') +
      '<p class="muted small">Text and Copy also save the order as sent.</p>'
    : '<p class="muted">No changes from the last order, so there\'s nothing to text. Use Mark as sent to record it.</p>';

  // Copy, then save as sent (clipboard must be written before any waiting).
  $$('[data-copy]', body).forEach((b) => (b.onclick = async () => {
    const t = texts[b.dataset.copy];
    let copied = true;
    try { await navigator.clipboard.writeText(t.text); } catch { copied = false; }
    await saveOrder('submitted', body, copied
      ? `Copied ${t.rider}'s text · order saved as sent`
      : 'Order saved as sent, but copy failed. Select the text and copy it by hand.');
  }));

  // Save as sent, then open the phone's messaging app with the text filled in.
  $$('[data-text]', body).forEach((b) => (b.onclick = async () => {
    const t = texts[b.dataset.text];
    const ok = await saveOrder('submitted', body, `Order saved as sent · opening Messages for ${t.rider}`);
    if (ok) window.location.href = smsLink(t.phone, t.text);
  }));
}

async function saveOrder(status, body, message) {
  const s = orderState;
  $$('[data-save]', body).forEach((b) => (b.disabled = true));
  try {
    const order = await q(sb.from('water_orders')
      .upsert({ order_date: s.date, status, submitted_at: status === 'submitted' ? new Date().toISOString() : null },
        { onConflict: 'order_date' })
      .select().single());

    // Replace this order's lines with what's on screen.
    await q(sb.from('water_order_lines').delete().eq('order_id', order.order_id));
    const parents = orderParents();
    const lines = parents.map((f) => {
      const l = lineFor(f);
      return { order_id: order.order_id, field_id: f.field_id, turnout_id: f.turnout_id, is_on: l.is_on, cfs: l.cfs };
    });
    if (lines.length) await q(sb.from('water_order_lines').insert(lines));

    const subs = parents.flatMap((f) => subunitsOf(f.field_id).map((sf) => ({
      order_id: order.order_id, field_id: f.field_id, subunit_field_id: sf.field_id, watered: !!s.subs.get(sf.field_id),
    })));
    if (subs.length) await q(sb.from('water_order_subunits').insert(subs));

    Object.assign(s, { orderId: order.order_id, status: order.status, submittedAt: order.submitted_at, dirty: false });
    await loadWaterStatus();
    toast(message ?? (status === 'submitted' ? 'Order marked as sent' : 'Draft saved'));
    drawOrder(body);
    return true;
  } catch {
    $$('[data-save]', body).forEach((b) => (b.disabled = false));
    return false;
  }
}

// =====================================================================
// Home dashboard
// "Today" = the most recent submitted order dated today or earlier.
// If that order is dated today, its differences from the order before
// it are today's water changes.
// =====================================================================
const fmtLong = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function turnoutTotals(lineMap) {
  const totals = new Map();
  for (const f of orderParents()) {
    const l = lineMap.get(f.field_id);
    if (l?.is_on) totals.set(f.turnout_id, (totals.get(f.turnout_id) || 0) + Number(l.cfs || 0));
  }
  return totals;
}

// Group a list of { turnout, ... } by ditch rider, in rider order.
function byRider(items) {
  return refs.riders
    .map((r) => ({ rider: r, items: items.filter((i) => i.turnout.rider_id === r.rider_id) }))
    .filter((g) => g.items.length);
}

async function renderHome(el) {
  const today = localDate();
  const tomorrow = addDays(today, 1);
  const season = new Date().getFullYear();

  const [recent, todayRows, tomorrowRows, balance] = await Promise.all([
    q(sb.from('water_orders').select('order_id, order_date, status').lte('order_date', today)
      .neq('status', 'draft').order('order_date', { ascending: false }).limit(2)),
    q(sb.from('water_orders').select('order_id, status').eq('order_date', today)),
    q(sb.from('water_orders').select('order_id, status, submitted_at').eq('order_date', tomorrow)),
    q(sb.from('water_balance_by_season').select('af_ordered').eq('season', season)),
  ]);

  const [current, previous] = recent;
  const changedToday = current?.order_date === today;
  const none = { lines: new Map() };
  const cur = current ? await linesFor(current.order_id) : none;
  const prev = changedToday && previous ? await linesFor(previous.order_id) : none;

  const now = turnoutTotals(cur.lines);
  const was = turnoutTotals(prev.lines);

  const changes = changedToday
    ? refs.turnouts
        .map((t) => ({ turnout: t, a: was.get(t.turnout_id) || 0, b: now.get(t.turnout_id) || 0 }))
        .filter((c) => Math.abs(c.a - c.b) >= 0.001)
    : [];
  const running = refs.turnouts
    .filter((t) => now.has(t.turnout_id))
    .map((t) => ({ turnout: t, cfs: now.get(t.turnout_id) }));

  const totalCfs = running.reduce((s, r) => s + r.cfs, 0);
  const fieldsOn = orderParents().filter((f) => cur.lines.get(f.field_id)?.is_on).length;
  const seasonAf = balance.reduce((s, b) => s + Number(b.af_ordered || 0), 0);

  // ---- Water changes card
  const changeLine = ({ turnout, a, b }) => {
    let value, badge;
    if (b === 0) { value = 'Off'; badge = '<span class="badge off">Off</span>'; }
    else if (a === 0) { value = `${num(b)} CFS`; badge = '<span class="badge new">New</span>'; }
    else { value = `${num(a)} → ${num(b)} CFS`; badge = b > a ? '<span class="badge up">Up</span>' : '<span class="badge down">Down</span>'; }
    return `<li><span class="li-name">${esc(turnout.name)}</span><span class="li-value">${value} ${badge}</span></li>`;
  };

  let changesHtml;
  if (changedToday) {
    changesHtml = changes.length
      ? byRider(changes).map((g) => `<div class="group"><h4>${esc(g.rider.name)}</h4>
          <ul class="list">${g.items.map(changeLine).join('')}</ul></div>`).join('')
      : `<p class="muted">Today's order is the same as the previous one. No changes.</p>`;
  } else if (todayRows[0]) {
    changesHtml = `<p class="notice">Today's order was saved as a draft but never sent, so it isn't counted.
      Water is running as ordered for ${esc(fmtDay(current?.order_date ?? today))}.</p>`;
  } else if (current) {
    changesHtml = `<p class="muted">No changes today. Water is running as ordered for ${esc(fmtDay(current.order_date))}.</p>`;
  } else {
    changesHtml = `<p class="muted">No water orders yet. Start one from the Water order tab.</p>`;
  }

  // ---- Tomorrow card
  const tmr = tomorrowRows[0];
  const tmrStatus = !tmr ? '<span class="badge off">Not started</span>'
    : tmr.status === 'draft' ? '<span class="badge down">Draft, not sent</span>'
    : `<span class="badge new">Sent</span> <span class="muted">${tmr.submitted_at ? esc(fmtTime(tmr.submitted_at)) : ''}</span>`;

  // ---- Running card
  const runningHtml = running.length
    ? byRider(running).map((g) => `<div class="group"><h4>${esc(g.rider.name)}</h4>
        <ul class="list">${g.items.map((r) => `<li><span class="li-name">${esc(r.turnout.name)}</span>
          <span class="li-value">${num(r.cfs)} CFS</span></li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">Nothing is running.</p>';

  const needsOrder = (!tmr || tmr.status === 'draft') && new Date().getHours() * 60 + new Date().getMinutes() >= 14 * 60 + 30;

  el.innerHTML = `
    <div class="home-head">
      <p class="eyebrow">${esc(fmtLong(today))}</p>
      <h2>Today on the farm</h2>
    </div>
    ${needsOrder ? `<div class="alert">
      <span><b>Tomorrow's water order hasn't been sent.</b> It's due to the ditch riders around 2:30 PM.</span>
      <button class="primary small" data-act="tomorrow">Open order</button></div>` : ''}

    <div class="stats">
      <div class="stat"><span class="stat-label">Water running</span><span class="stat-value">${num(totalCfs)}<small> CFS</small></span></div>
      <div class="stat"><span class="stat-label">Turnouts on</span><span class="stat-value">${running.length}</span></div>
      <div class="stat"><span class="stat-label">Fields watering</span><span class="stat-value">${fieldsOn}</span></div>
      <div class="stat"><span class="stat-label">Ordered in ${season}</span><span class="stat-value">${num(seasonAf, 0)}<small> ac-ft</small></span></div>
    </div>

    <div class="dash-grid">
      <div>
        <section class="card"><h3>Water changes today</h3>${changesHtml}</section>
        <section class="card"><h3>Running now</h3>${runningHtml}</section>
      </div>
      <div>
        <section class="card">
          <h3>Tomorrow's order</h3>
          <p class="status-line">${tmrStatus}</p>
          <p class="muted small">${esc(fmtDay(tomorrow))} · due to the ditch riders around 2:30 PM today</p>
          <div class="actions"><button class="primary" data-act="tomorrow">Open tomorrow's order</button></div>
        </section>
        <section class="card soon">
          <h3>Work schedule</h3>
          <p class="muted">Scheduled work and a calendar will show here.</p>
        </section>
      </div>
    </div>`;

  $$('[data-act=tomorrow]', el).forEach((b) => (b.onclick = () => { orderState.date = tomorrow; show('order'); }));
}

// =====================================================================
// Crops: what was grown where, by season, with full field histories.
// One crop year = one crop + variety on one field in one season.
// =====================================================================
let cropSeason = new Date().getFullYear();
const cropName = (id) => refs.crops.find((c) => c.crop_id === id)?.name ?? '';
const fmtDate = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const SEQ = { 1: '1st crop', 2: '2nd crop', 3: '3rd crop' };

// Fields in the same order as the water order screen, split halves under their parent.
function fieldsInOrder() {
  const out = [];
  const seen = new Set();
  const add = (f) => {
    if (seen.has(f.field_id)) return;
    seen.add(f.field_id);
    out.push(f);
    refs.fields.filter((h) => h.parent_field_id === f.field_id).forEach(add);
  };
  for (const r of refs.riders) {
    for (const t of refs.turnouts.filter((x) => x.rider_id === r.rider_id)) {
      refs.fields.filter((f) => f.turnout_id === t.turnout_id && !f.parent_field_id).forEach(add);
    }
  }
  refs.fields.filter((f) => !f.parent_field_id).forEach(add);
  refs.fields.forEach(add);
  return out;
}

// "Year 2 of stand" for a multi-year crop in a later season.
function standNote(r, season) {
  if (!r.multi_year) return '';
  const year = season - r.season + 1;
  const end = r.end_season != null ? (r.end_season === season ? ' · last year' : '') : '';
  return `<span class="stand-note">${year === 1 ? 'New stand' : `Year ${year} of stand`}${end}</span>`;
}
function plantedCell(r, season) {
  if (r.status === 'planned') return `<span class="muted small">Planned${r.acres != null ? ` · ${num(r.acres, 0)} ac` : ''}</span>`;
  if (r.grown_by) return `<span class="badge off">Grown by ${esc(r.grown_by)}</span>`;
  if (r.season !== season) return `<span class="muted small">Planted ${r.season}</span>`;
  return esc(fmtDate(r.planting_date)) + (r.acres != null ? ` <span class="muted small">· ${num(r.acres, 0)} ac</span>` : '');
}
const planTag = (r) => (r.status === 'planned' ? ' <span class="badge down">Plan</span>' : '');
function isoText(ft) {
  if (ft == null) return '';
  const n = Number(ft);
  return n >= 5280 ? `${Number((n / 5280).toFixed(2))} mi` : `${Number(n.toFixed(0)).toLocaleString()} ft`;
}
const isoTag = (r) => (r.isolation_ft != null ? ` <span class="iso-tag" title="Isolation required">↔ ${isoText(r.isolation_ft)}</span>` : '');
const seasonSpan = (r) => !r.multi_year ? String(r.season)
  : r.end_season == null ? `${r.season}–` : r.end_season === r.season ? String(r.season) : `${r.season}–${r.end_season}`;

function yieldText(r) {
  return r.total_yield != null ? `${Number(r.total_yield).toLocaleString()} ${esc(r.yield_unit ?? '')}` : '<span class="muted">—</span>';
}

async function renderCrops(el) {
  // This season's crops, plus multi-year stands planted earlier that are still in.
  const rows = (await q(sb.from('crop_year_summary').select('*').lte('season', cropSeason)
    .or(`season.eq.${cropSeason},multi_year.eq.true`)
    .order('season').order('sequence').order('crop_year_id')))
    .filter((r) => r.season === cropSeason || (r.multi_year && (r.end_season == null || r.end_season >= cropSeason)));
  const byField = new Map();
  rows.forEach((r) => byField.set(r.field_id, [...(byField.get(r.field_id) ?? []), r]));
  const fields = fieldsInOrder().filter((f) => f.active || byField.has(f.field_id));
  const planted = fields.filter((f) => byField.has(f.field_id)).length;

  let body = '';
  for (const f of fields) {
    const list = byField.get(f.field_id) ?? [];
    const half = f.parent_field_id ? ' half' : '';
    const nameCell = (span) => `<td rowspan="${span}" class="field-cell${half}">
      <button class="link" data-history="${f.field_id}">${esc(f.name)}</button>
      <span class="muted small">${f.acres != null ? num(f.acres, 0) + ' ac' : ''}</span></td>`;
    if (!list.length) {
      body += `<tr class="unplanted">${nameCell(1)}<td class="muted">Nothing entered</td><td class="c-variety"></td><td class="c-planted"></td><td class="c-yield"></td>
        <td class="r"><button class="small" data-add="${f.field_id}">Add</button></td></tr>`;
      continue;
    }
    list.forEach((r, i) => {
      body += `<tr>${i === 0 ? nameCell(list.length) : ''}
        <td><span class="crop-tag">${esc(cropName(r.crop_id))}</span>${planTag(r)}${r.sequence > 1 ? ` <span class="muted small">${SEQ[r.sequence] ?? ''}</span>` : ''}
          ${standNote(r, cropSeason)}${isoTag(r)}
          ${r.variety ? `<span class="v-inline">${esc(r.variety)}</span>` : ''}</td>
        <td class="c-variety">${esc(r.variety ?? '')}</td>
        <td class="c-planted">${plantedCell(r, cropSeason)}</td>
        <td class="r c-yield">${r.grown_by || r.multi_year ? '<span class="muted">—</span>' : yieldText(r)}</td>
        <td class="r"><button class="small" data-edit-cy="${r.crop_year_id}">Edit</button>
          ${i === list.length - 1 ? `<button class="small ghost" data-add="${f.field_id}" title="Add another crop or variety">+</button>` : ''}</td>
      </tr>`;
    });
  }

  el.innerHTML = `
    <div class="section-head"><h2>Crops</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous season">‹</button>
        <strong class="season">${cropSeason}</strong>
        <button data-season="1" aria-label="Next season">›</button>
        <button class="primary" data-add="">Add crop</button>
      </div></div>
    <p class="muted small">${planted} of ${fields.length} fields entered for ${cropSeason}. Click a field name for its full history.</p>
    ${refs.crops.length ? '' : '<div class="empty">Add your crops under <b>Setup → Crops</b> first.</div>'}
    <div class="card table-wrap"><table class="crop-table">
      <thead><tr><th>Field</th><th>Crop</th><th class="c-variety">Variety</th><th class="c-planted">Planted</th><th class="r c-yield">Yield</th><th></th></tr></thead>
      <tbody>${body}</tbody></table></div>`;

  const reload = () => renderCrops(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { cropSeason += Number(b.dataset.season); reload(); }));
  $$('[data-add]', el).forEach((b) => (b.onclick = () =>
    openCropYear(null, { field_id: b.dataset.add ? Number(b.dataset.add) : null, season: cropSeason }, reload)));
  $$('[data-edit-cy]', el).forEach((b) => (b.onclick = () =>
    openCropYear(rows.find((r) => r.crop_year_id === Number(b.dataset.editCy)), null, reload)));
  $$('[data-history]', el).forEach((b) => (b.onclick = () => openFieldHistory(Number(b.dataset.history), reload)));
}

async function openFieldHistory(fieldId, onChange) {
  const f = fieldById(fieldId);
  const rows = await q(sb.from('crop_year_summary').select('*').eq('field_id', fieldId)
    .order('season', { ascending: false }).order('sequence'));
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<div class="form">
    <div class="dialog-head"><div><h3>${esc(f.name)}</h3>
      <p class="muted small">${[f.farm_unit && 'Farm unit ' + esc(f.farm_unit), f.block && 'Block ' + esc(f.block),
        f.acres != null && num(f.acres, 0) + ' acres', esc(tenureOf(f))].filter(Boolean).join(' · ')}</p></div>
      <button class="primary small" data-act="add">Add crop year</button></div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Season</th><th>Crop</th><th>Variety</th><th>Planted</th><th class="r">Yield</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><b>${seasonSpan(r)}</b>${r.multi_year && r.end_season == null ? ' <span class="muted small">still in</span>' : ''}${r.sequence > 1 ? ` <span class="muted small">${SEQ[r.sequence] ?? ''}</span>` : ''}</td>
        <td><span class="crop-tag">${esc(cropName(r.crop_id))}</span>${planTag(r)}${isoTag(r)}</td><td>${esc(r.variety ?? '')}</td>
        <td>${plantedCell(r, r.season)}</td><td class="r">${r.grown_by ? '<span class="muted">—</span>' : yieldText(r)}</td>
        <td class="r"><button class="small" data-edit-cy="${r.crop_year_id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No crops recorded for this field yet.</p>'}
    <div class="actions"><span class="spacer"></span><button data-act="close">Close</button></div></div>`;

  const reopen = () => { onChange(); openFieldHistory(fieldId, onChange); };
  $('[data-act=close]', dlg).onclick = () => dlg.close();
  $('[data-act=add]', dlg).onclick = () =>
    openCropYear(null, { field_id: fieldId, season: new Date().getFullYear() }, reopen);
  $$('[data-edit-cy]', dlg).forEach((b) => (b.onclick = () =>
    openCropYear(rows.find((r) => r.crop_year_id === Number(b.dataset.editCy)), null, reopen)));
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

async function openCropYear(row, defaults, onDone) {
  const v = row ?? { sequence: 1, status: (defaults?.season ?? 0) > new Date().getFullYear() ? 'planned' : 'planted', ...defaults };
  // Every variety used before, grouped by crop, for the suggestions list.
  const used = await q(sb.from('crop_years').select('crop_id, variety').not('variety', 'is', null));
  const varietiesFor = (cropId) => [...new Map(used
    .filter((u) => u.crop_id === cropId && u.variety.trim())
    .map((u) => [u.variety.trim().toLowerCase(), u.variety.trim()])).values()].sort();

  const crops = refs.crops.filter((c) => c.active || c.crop_id === v.crop_id);
  const fields = fieldsInOrder().filter((f) => f.active || f.field_id === v.field_id);
  const dlg = $('#dialog');
  dlg.classList.remove('wide');
  dlg.innerHTML = `<form class="form">
    <h3>${row ? 'Edit' : 'Add'} crop year</h3>
    <label>Field *<select name="field_id" required><option value="">Choose…</option>
      ${fields.map((f) => `<option value="${f.field_id}" ${f.field_id === v.field_id ? 'selected' : ''}>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</option>`).join('')}
    </select></label>
    <label>Status<select name="status">
      <option value="planted" ${v.status !== 'planned' ? 'selected' : ''}>Planted</option>
      <option value="planned" ${v.status === 'planned' ? 'selected' : ''}>Planned (on the crop plan, not in the ground yet)</option>
    </select></label>
    <div class="row2">
      <label>Season *<input type="number" name="season" min="1990" max="2100" required value="${esc(v.season ?? '')}"></label>
      <label>Crop in season<select name="sequence">
        ${Object.entries(SEQ).map(([n, t]) => `<option value="${n}" ${Number(n) === v.sequence ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
    </div>
    <label>Crop *<select name="crop_id" required><option value="">Choose…</option>
      ${crops.map((c) => `<option value="${c.crop_id}" ${c.crop_id === v.crop_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select></label>
    <label class="check"><input type="checkbox" name="multi_year" ${v.multi_year ? 'checked' : ''}> Multi-year stand</label>
    <label id="end-wrap">Last season in the field<select name="end_season"></select></label>
    <label>Variety<input name="variety" list="variety-options" autocomplete="off" value="${esc(v.variety ?? '')}"
      placeholder="Start typing — past varieties appear">
      <datalist id="variety-options"></datalist></label>
    <div id="leased-out" class="leased-out">
      <p class="small">This field is leased out this season. Only crop and variety are kept, no planting or harvest data.</p>
      <label>Grown by<input name="grown_by" value="${esc(v.grown_by ?? '')}"></label>
    </div>
    <div id="our-crop">
      <div class="row2">
        <label id="pdate-wrap">Planting date<input type="date" name="planting_date" value="${esc(v.planting_date ?? '')}"></label>
        <label>Acres<input type="number" name="acres" step="0.1" min="0" value="${esc(v.acres ?? '')}"></label>
      </div>
      <p class="muted small" id="acres-hint"></p>
    </div>
    <div class="row2">
      <label>Isolation required<input type="number" name="iso" step="any" min="0" placeholder="None"
        value="${v.isolation_ft == null ? '' : Number(v.isolation_ft) >= 5280 ? Number((v.isolation_ft / 5280).toFixed(3)) : Number(v.isolation_ft)}"></label>
      <label>&nbsp;<select name="iso_unit">
        <option value="ft" ${v.isolation_ft == null || Number(v.isolation_ft) < 5280 ? 'selected' : ''}>feet</option>
        <option value="mi" ${Number(v.isolation_ft) >= 5280 ? 'selected' : ''}>miles</option>
      </select></label>
    </div>
    <fieldset id="contract" class="contract">
      <legend>Contract <span class="muted small">(optional)</span></legend>
      <div class="row2">
        <label>Company<input name="contract_company" value="${esc(v.contract_company ?? '')}"></label>
        <label>Contract #<input name="contract_number" value="${esc(v.contract_number ?? '')}"></label>
      </div>
      <div class="row2">
        <label>Price<input type="number" name="contract_price" step="any" min="0" value="${esc(v.contract_price ?? '')}"></label>
        <label>Bonus<input type="number" name="contract_bonus" step="any" min="0" value="${esc(v.contract_bonus ?? '')}"></label>
      </div>
      <div class="row2">
        <label>Per<select name="contract_unit">
          ${['lb', 'bu', 'cwt', 'ton', 'acre'].map((u) => `<option value="${u}" ${(v.contract_unit ?? 'lb') === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select></label>
        <label>Minimum<input type="number" name="contract_minimum" step="any" min="0" value="${esc(v.contract_minimum ?? '')}"></label>
      </div>
      <label>Overage terms<input name="contract_overage" value="${esc(v.contract_overage ?? '')}"></label>
    </fieldset>
    <label>Notes<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    <div class="actions">
      ${row ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div></form>`;

  const form = $('form', dlg);
  const el = form.elements;
  const fillVarieties = () => {
    $('#variety-options', dlg).innerHTML = varietiesFor(Number(el.crop_id.value))
      .map((x) => `<option value="${esc(x)}"></option>`).join('');
  };
  const acresHint = () => {
    const f = fieldById(el.field_id.value);
    $('#acres-hint', dlg).textContent = f?.acres != null
      ? `Leave acres blank if the whole field (${num(f.acres, 0)} ac) is in this crop.` : '';
  };
  const syncStand = () => {
    const show = el.multi_year.checked;
    $('#end-wrap', dlg).hidden = !show;
    const start = Number(el.season.value) || new Date().getFullYear();
    const keep = el.end_season.value || (v.end_season ?? '');
    el.end_season.innerHTML = '<option value="">Still in the field</option>' +
      Array.from({ length: 11 }, (_, i) => start + i)
        .map((y) => `<option value="${y}" ${String(y) === String(keep) ? 'selected' : ''}>${y}</option>`).join('');
  };
  const syncStatus = () => {
    const planned = el.status.value === 'planned';
    $('#pdate-wrap', dlg).hidden = planned;
    $('#contract', dlg).hidden = planned || !$('#leased-out', dlg).hidden;
  };
  el.status.onchange = syncStatus;
  const syncLeasedOut = () => {
    const lease = el.field_id.value && el.season.value ? leasedOutIn(Number(el.field_id.value), Number(el.season.value)) : null;
    const out = !!lease || !!(row?.grown_by);
    $('#leased-out', dlg).hidden = !out;
    $('#our-crop', dlg).hidden = out;
    syncStatus();
    if (out && !el.grown_by.value && lease) el.grown_by.value = lease.lessor;
  };
  el.crop_id.onchange = () => {
    fillVarieties();
    if (!row) { el.multi_year.checked = !!refs.crops.find((c) => c.crop_id === Number(el.crop_id.value))?.multi_year; syncStand(); }
  };
  el.field_id.onchange = () => { acresHint(); syncLeasedOut(); };
  el.season.oninput = () => { syncStand(); syncLeasedOut(); };
  el.multi_year.onchange = syncStand;
  fillVarieties();
  acresHint();
  syncStand();
  syncLeasedOut();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const val = (k) => el[k].value.trim();
    const data = {
      field_id: Number(val('field_id')),
      season: Number(val('season')),
      sequence: Number(val('sequence')),
      crop_id: Number(val('crop_id')),
      variety: val('variety') || null,
      planting_date: val('planting_date') || null,
      acres: val('acres') === '' ? null : Number(val('acres')),
      notes: val('notes') || null,
      multi_year: el.multi_year.checked,
      end_season: el.multi_year.checked && val('end_season') ? Number(val('end_season')) : null,
      grown_by: null,
      status: el.status.value,
      isolation_ft: val('iso') === '' ? null : Number(val('iso')) * (el.iso_unit.value === 'mi' ? 5280 : 1),
    };
    const contractFields = ['contract_company', 'contract_number', 'contract_price', 'contract_bonus', 'contract_unit', 'contract_minimum', 'contract_overage'];
    const numeric = ['contract_price', 'contract_bonus', 'contract_minimum'];
    const contractOn = $('#contract', dlg).hidden === false;
    for (const k of contractFields) data[k] = contractOn && val(k) !== '' ? (numeric.includes(k) ? Number(val(k)) : val(k)) : null;
    if (!data.contract_company && !data.contract_number && data.contract_price == null) data.contract_unit = null;
    if (data.status === 'planned') data.planting_date = null;
    if (!$('#leased-out', dlg).hidden) {
      data.grown_by = val('grown_by') || null;
      data.planting_date = null;
      data.acres = null;
    }
    // Reuse the spelling already on file ("dekalb 51-20" -> "DeKalb 51-20").
    if (data.variety) {
      const match = varietiesFor(data.crop_id).find((x) => x.toLowerCase() === data.variety.toLowerCase());
      if (match) data.variety = match;
    }
    try {
      if (row) await q(sb.from('crop_years').update(data).eq('crop_year_id', row.crop_year_id));
      else await q(sb.from('crop_years').insert(data));
      dlg.close();
      toast('Saved');
      onDone();
    } catch { /* shown */ }
  };
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm('Delete this crop year? Any harvest records attached to it are deleted too.')) return;
    try {
      await q(sb.from('crop_years').delete().eq('crop_year_id', row.crop_year_id));
      dlg.close();
      toast('Deleted');
      onDone();
    } catch { /* shown */ }
  };
  if (!dlg.open) dlg.showModal();
}

// =====================================================================
// Farm map: fields coloured by crop for a season, with shape editing.
// A field's outline is stored on fields.boundary as a GeoJSON Feature.
// Pivots keep their centre, radius and arc so they stay easy to adjust.
// =====================================================================
const PALETTE = ['#2563a8', '#e07b39', '#3a9d5d', '#c0392b', '#7c3aed', '#d4a017', '#0f766e', '#db2777',
  '#65a30d', '#0891b2', '#9f1239', '#a16207', '#4338ca', '#15803d', '#ea580c', '#475569'];
const cropColor = (id) => refs.crops.find((c) => c.crop_id === id)?.color || PALETTE[id % PALETTE.length];

const AC_M2 = 4046.8564224;
const M_LAT = 110574;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const toLL = ([lng, lat]) => [lat, lng];
const fromLL = (ll) => [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
const offsetPt = ([lng, lat], dx, dy) => [lng + dx / mLon(lat), lat + dy / M_LAT];
const metresBetween = (a, b) => Math.hypot((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT);
const bearingTo = (a, b) => ((Math.atan2((b[0] - a[0]) * mLon(a[1]), (b[1] - a[1]) * M_LAT) * 180) / Math.PI + 360) % 360;
const spanOf = (p) => (((p.end - p.start) % 360) + 360) % 360 || 360;
const atBearing = (p, deg, r = p.radius) =>
  offsetPt(p.center, r * Math.sin((deg * Math.PI) / 180), r * Math.cos((deg * Math.PI) / 180));

function pivotRing(p) {
  const span = spanOf(p);
  const steps = Math.max(8, Math.round((72 * span) / 360));
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(atBearing(p, p.start + (span * i) / steps));
  if (span < 360) pts.unshift([...p.center]);
  pts.push(pts[0]);
  return pts;
}
function ringAcres(ring) {
  if (!ring || ring.length < 4) return 0;
  const k = mLon(ring[0][1]);
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * k * ring[i + 1][1] * M_LAT - ring[i + 1][0] * k * ring[i][1] * M_LAT;
  }
  return Math.abs(s) / 2 / AC_M2;
}
const radiusForAcres = (acres, span = 360) => Math.sqrt((acres * AC_M2) / (Math.PI * (span / 360)));

// Draft shape -> GeoJSON Feature
function toFeature(d) {
  if (d.shape === 'pivot') {
    return { type: 'Feature',
      properties: { shape: 'pivot', center: d.center.map((x) => Number(x.toFixed(7))), radius: Number(d.radius.toFixed(1)), start: d.start, end: d.end },
      geometry: { type: 'Polygon', coordinates: [pivotRing(d)] } };
  }
  const ring = d.ring.map((p) => [...p]);
  ring.push([...ring[0]]);
  return { type: 'Feature', properties: { shape: 'polygon' }, geometry: { type: 'Polygon', coordinates: [ring] } };
}
// GeoJSON Feature -> editable draft
function toDraft(f) {
  const p = f.properties ?? {};
  if (p.shape === 'pivot') return { shape: 'pivot', center: [...p.center], radius: p.radius, start: p.start ?? 0, end: p.end ?? 360 };
  return { shape: 'polygon', ring: f.geometry.coordinates[0].slice(0, -1).map((x) => [...x]) };
}
const draftRing = (d) => (d.shape === 'pivot' ? pivotRing(d) : d.ring.length ? [...d.ring, d.ring[0]] : []);

const mapState = { map: null, view: null, season: new Date().getFullYear(), editMode: false, layers: [], ed: null };

async function renderMap(el) {
  if (!window.L) {
    el.innerHTML = '<div class="empty">The map library didn\'t load. Check your connection and refresh.</div>';
    return;
  }
  const season = mapState.season;
  const rows = (await q(sb.from('crop_year_summary').select('*').lte('season', season)
    .or(`season.eq.${season},multi_year.eq.true`).order('sequence')))
    .filter((r) => r.season === season || (r.multi_year && (r.end_season == null || r.end_season >= season)));
  const cropsByField = new Map();
  rows.forEach((r) => cropsByField.set(r.field_id, [...(cropsByField.get(r.field_id) ?? []), r]));
  mapState.cropsByField = cropsByField;

  el.innerHTML = `
    <div class="section-head"><h2>Farm map</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous season">‹</button>
        <strong class="season">${season}</strong>
        <button data-season="1" aria-label="Next season">›</button>
        <button class="${mapState.editMode ? 'primary' : ''}" data-act="edit">${mapState.editMode ? 'Done editing' : 'Edit shapes'}</button>
      </div></div>
    <div class="map-wrap"><div id="map"></div><aside class="card map-side" id="map-side"></aside></div>`;

  $$('[data-season]', el).forEach((b) => (b.onclick = () => {
    if (!confirmDiscard()) return;
    mapState.season += Number(b.dataset.season);
    renderMap(el);
  }));
  $('[data-act=edit]', el).onclick = () => {
    if (!confirmDiscard()) return;
    mapState.editMode = !mapState.editMode;
    mapState.ed = null;
    renderMap(el);
  };

  if (mapState.map) { mapState.view = { center: mapState.map.getCenter(), zoom: mapState.map.getZoom() }; mapState.map.remove(); }
  const map = L.map('map', { zoomControl: true, maxZoom: 19, doubleClickZoom: !mapState.editMode });
  mapState.map = map;
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(map);
  map.on('zoomend', () => $('#map')?.classList.toggle('hide-labels', map.getZoom() < 13));
  map.on('click', (e) => onMapClick(e));

  drawFields();
  const shaped = refs.fields.filter((f) => f.boundary);
  if (mapState.view) map.setView(mapState.view.center, mapState.view.zoom);
  else if (shaped.length) map.fitBounds(L.featureGroup(mapState.layers.map((x) => x.layer)).getBounds(), { padding: [20, 20] });
  else map.setView([39.5, -98.35], 4);
  $('#map').classList.toggle('hide-labels', map.getZoom() < 13);
  drawSide();
}

function confirmDiscard() {
  return !mapState.ed?.dirty || confirm('Discard your changes to this field\'s shape?');
}

function drawFields() {
  const map = mapState.map;
  mapState.layers.forEach((x) => x.layer.remove());
  mapState.layers = [];
  for (const f of refs.fields) {
    if (!f.boundary || mapState.ed?.field.field_id === f.field_id) continue;
    const crops = mapState.cropsByField.get(f.field_id) ?? [];
    const color = crops.length ? cropColor(crops[0].crop_id) : '#9aa5b1';
    const planned = crops.length > 0 && crops.every((r) => r.status === 'planned');
    const layer = L.polygon(f.boundary.geometry.coordinates[0].map(toLL), {
      color: mapState.editMode ? '#ffffff' : planned ? '#ffffff' : color, weight: mapState.editMode ? 2 : planned ? 2 : 1.5,
      dashArray: planned ? '3 5' : crops.length > 1 ? '8 4' : null,
      fillColor: color, fillOpacity: !crops.length ? 0.25 : planned ? 0.3 : 0.55,
    }).addTo(map);
    layer.bindTooltip(esc(f.name), { permanent: true, direction: 'center', className: 'field-label' });
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (mapState.ed?.mode === 'draw' || mapState.ed?.mode === 'place') return onMapClick(e);
      if (mapState.editMode) startEdit(f);
      else showFieldInfo(f);
    });
    mapState.layers.push({ field: f, layer });
  }
}

// ---------- Side panel ----------
function drawSide(info) {
  const side = $('#map-side');
  if (!side) return;
  if (mapState.editMode) return drawEditSide();
  if (info) return;
  // Legend: crops on the map this season, with acres
  const totals = new Map();
  for (const [fid, list] of mapState.cropsByField) {
    const f = fieldById(fid);
    if (!f) continue;
    for (const r of list) {
      const acres = Number(r.acres ?? f.acres ?? 0) / (r.acres == null ? list.filter((x) => x.acres == null).length : 1);
      totals.set(r.crop_id, (totals.get(r.crop_id) ?? 0) + acres);
    }
  }
  const unmapped = refs.fields.filter((f) => f.active && !f.boundary).length;
  side.innerHTML = `<h3>${mapState.season} crops</h3>
    ${totals.size ? `<ul class="legend">${[...totals].sort((a, b) => b[1] - a[1]).map(([id, ac]) => `
      <li><span class="swatch" style="background:${esc(cropColor(id))}"></span>${esc(cropName(id))}
        <span class="muted">${Math.round(ac).toLocaleString()} ac</span></li>`).join('')}</ul>`
      : '<p class="muted">No crops entered for this season.</p>'}
    <p class="muted small">Acres are from your crop records. Long dashes = more than one crop or variety.
      Pale with a white dotted edge = planned, not planted. Click a field for details.</p>
    ${isoFields().length ? `<h4>Isolation</h4>
      <label class="check small"><input type="checkbox" data-act="all-rings" ${mapState.allRings ? 'checked' : ''}> Show all isolation rings</label>
      <ul class="missing">${isoFields().map(({ f, r }) => `<li><span>${esc(f.name)} <span class="muted small">${esc(cropName(r.crop_id))} · ${isoText(r.isolation_ft)}</span></span>
        <button class="small" data-ring="${f.field_id}">Check</button></li>`).join('')}</ul>` : ''}
    ${unmapped ? `<p class="small">${unmapped} active field(s) aren't on the map yet. Use <b>Edit shapes</b> to add them.</p>` : ''}`;
  const all = $('[data-act=all-rings]', side);
  if (all) all.onchange = () => { mapState.allRings = all.checked; drawRings(); };
  $$('[data-ring]', side).forEach((b) => (b.onclick = () => showFieldInfo(fieldById(b.dataset.ring))));
  drawRings();
}

// ---------- Isolation rings ----------
// Fields with an isolation requirement on a crop this season (largest requirement per field).
function isoFields() {
  const out = [];
  for (const [fid, list] of mapState.cropsByField ?? []) {
    const f = fieldById(fid);
    const r = list.filter((x) => x.isolation_ft != null).sort((a, b) => b.isolation_ft - a.isolation_ft)[0];
    if (f?.boundary && r) out.push({ f, r });
  }
  return out.sort((a, b) => a.f.name.localeCompare(b.f.name, undefined, { numeric: true }));
}
// Centre and outer reach of a field's outline, in metres.
function shapeReach(f) {
  const ring = f.boundary.geometry.coordinates[0];
  const p = f.boundary.properties ?? {};
  const center = p.shape === 'pivot' ? p.center
    : ring.slice(0, -1).reduce((a, x, _, arr) => [a[0] + x[0] / arr.length, a[1] + x[1] / arr.length], [0, 0]);
  return { center, reach: Math.max(...ring.map((x) => metresBetween(center, x))) };
}
// Ring = field outline pushed out by the isolation distance (exact for full pivots, a little generous for other shapes).
function isoRing(f, r) {
  const { center, reach } = shapeReach(f);
  const radius = reach + Number(r.isolation_ft) * 0.3048;
  const inside = [];
  for (const g of refs.fields) {
    if (g.field_id === f.field_id || !g.boundary) continue;
    const d = Math.min(...g.boundary.geometry.coordinates[0].map((x) => metresBetween(center, x)));
    if (d <= radius) inside.push(g);
  }
  return { center, radius, inside };
}
function drawRings(focus) {
  (mapState.rings ?? []).forEach((l) => l.remove());
  mapState.rings = [];
  if (mapState.editMode || !mapState.map) return;
  const list = focus ? isoFields().filter((x) => x.f.field_id === focus.field_id)
    : mapState.allRings ? isoFields() : [];
  for (const { f, r } of list) {
    const { center, radius } = isoRing(f, r);
    mapState.rings.push(L.circle(toLL(center), { radius, color: '#ffd400', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(mapState.map));
  }
}

function showFieldInfo(f) {
  const crops = mapState.cropsByField.get(f.field_id) ?? [];
  const drawn = f.boundary ? ringAcres(f.boundary.geometry.coordinates[0]) : 0;
  $('#map-side').innerHTML = `
    <div class="dialog-head"><h3>${esc(f.name)}</h3><button class="small ghost" data-act="back">✕</button></div>
    <p class="muted small">${[f.farm_unit && 'Farm unit ' + esc(f.farm_unit), f.acres != null && num(f.acres, 0) + ' ac',
      esc(tenureOf(f))].filter(Boolean).join(' · ')}</p>
    ${crops.length ? crops.map((r) => `<div class="info-crop">
        <span class="swatch" style="background:${esc(cropColor(r.crop_id))}"></span>
        <div><b>${esc(cropName(r.crop_id))}</b>${r.variety ? ` · ${esc(r.variety)}` : ''}
          <div class="muted small">${r.grown_by ? 'Grown by ' + esc(r.grown_by)
            : r.status === 'planned' ? 'Planned'
            : r.season !== mapState.season ? `Stand planted ${r.season}` : esc(fmtDate(r.planting_date) || 'No planting date')}${
            r.isolation_ft != null ? ` · isolation ${isoText(r.isolation_ft)}` : ''}</div></div>
      </div>`).join('') : `<p class="muted">Nothing entered for ${mapState.season}.</p>`}
    <p class="muted small">Outline is ${num(drawn, 1)} ac.</p>
    ${isoSection(f, crops)}
    <div class="actions"><button data-act="history">Crop history</button></div>`;
  drawRings(crops.some((r) => r.isolation_ft != null) ? f : null);
  $('[data-act=back]').onclick = () => { drawRings(); drawSide(); };
  $('[data-act=history]').onclick = () => openFieldHistory(f.field_id, () => {});
}

function isoSection(f, crops) {
  const r = crops.filter((x) => x.isolation_ft != null).sort((a, b) => b.isolation_ft - a.isolation_ft)[0];
  if (!r || !f.boundary) return '';
  const { inside } = isoRing(f, r);
  const rows = inside.map((g) => {
    const gc = mapState.cropsByField.get(g.field_id) ?? [];
    const same = gc.some((x) => x.crop_id === r.crop_id);
    return { g, gc, same };
  }).sort((a, b) => Number(b.same) - Number(a.same));
  const empty = rows.filter((x) => !x.gc.length).length;
  rows.splice(0, rows.length, ...rows.filter((x) => x.gc.length));
  return `<div class="iso-box"><b>Isolation ${isoText(r.isolation_ft)}</b> <span class="muted small">for ${esc(cropName(r.crop_id))}</span>
    ${rows.length ? `<p class="muted small">Fields inside the ring for ${mapState.season}:</p><ul class="iso-list">${rows.map(({ g, gc, same }) => `
      <li class="${same ? 'conflict' : ''}"><span>${esc(g.name)}</span>
        <span class="small">${gc.length ? gc.map((x) => esc(cropName(x.crop_id)) + (x.status === 'planned' ? ' (plan)' : '')).join(', ') : '<span class="muted">nothing entered</span>'}</span></li>`).join('')}</ul>
      ${empty ? `<p class="muted small">Plus ${empty} field(s) with nothing entered.</p>` : ''}
      ${rows.some((x) => x.same) ? '<p class="small conflict-note">Red = same crop inside the isolation distance.</p>' : ''}`
      : `<p class="muted small">${empty ? `${empty} field(s) inside the ring, none with a crop entered.` : 'No other fields inside the ring.'}</p>`}</div>`;
}

// ---------- Editing ----------
function drawEditSide() {
  const ed = mapState.ed;
  const side = $('#map-side');
  if (!ed) {
    const missing = fieldsInOrder().filter((f) => f.active && !f.boundary);
    side.innerHTML = `<h3>Edit shapes</h3>
      <p class="muted small">Click a field on the map to adjust it.</p>
      ${missing.length ? `<h4>Not on the map yet</h4><ul class="missing">${missing.map((f) => `
        <li><span>${esc(f.name)} <span class="muted small">${f.acres != null ? num(f.acres, 0) + ' ac' : ''}</span></span>
          <span class="row"><button class="small" data-place="${f.field_id}">Pivot</button>
          <button class="small" data-draw="${f.field_id}">Draw</button></span></li>`).join('')}</ul>`
        : '<p class="muted small">Every active field is on the map.</p>'}`;
    $$('[data-place]', side).forEach((b) => (b.onclick = () => startPlace(fieldById(b.dataset.place), 'place')));
    $$('[data-draw]', side).forEach((b) => (b.onclick = () => startPlace(fieldById(b.dataset.draw), 'draw')));
    return;
  }
  const f = ed.field;
  const d = ed.draft;
  const drawn = d ? ringAcres(draftRing(d)) : 0;
  let body = '';
  if (ed.mode === 'place') body = '<p class="notice">Click the pivot point on the map.</p>';
  else if (ed.mode === 'draw') {
    body = `<p class="notice">Click around the field's edge. ${d.ring.length} point(s) so far.</p>
      <div class="row wrap"><button class="small" data-act="undo" ${d.ring.length ? '' : 'disabled'}>Undo point</button>
      <button class="small primary" data-act="finish" ${d.ring.length >= 3 ? '' : 'disabled'}>Finish shape</button></div>`;
  } else if (d.shape === 'pivot') {
    const span = spanOf(d);
    body = `<p class="muted small">Drag the centre dot to move it, the edge dot to resize${span < 360 ? ', and the two end dots to set the arc' : ''}.</p>
      <label class="small">Arc<select data-act="arc">
        ${[['0-360', 'Full circle'], ['270-90', 'North half'], ['90-270', 'South half'], ['0-180', 'East half'], ['180-360', 'West half'],
          ['custom', 'Custom (drag end dots)']].map(([v, t]) =>
          `<option value="${v}" ${v === `${d.start}-${d.end}` || (v === 'custom' && !['0-360', '270-90', '90-270', '0-180', '180-360'].includes(`${d.start}-${d.end}`)) ? 'selected' : ''}>${t}</option>`).join('')}
      </select></label>
      <div class="row wrap"><button class="small" data-act="fit" ${f.acres ? '' : 'disabled'}>Size to ${f.acres ? num(f.acres, 0) + ' ac' : 'field acres'}</button>
      <button class="small" data-act="topoly">Switch to drawn shape</button></div>`;
  } else {
    body = `<p class="muted small">Drag the white dots to move corners. Drag a small dot to add a corner. Double-click a corner to remove it.</p>
      <div class="row wrap"><button class="small" data-act="redraw">Redraw from scratch</button>
      <button class="small" data-act="topivot">Switch to pivot</button></div>`;
  }
  side.innerHTML = `
    <div class="dialog-head"><h3>${esc(f.name)}</h3></div>
    <div class="acre-compare">
      <div><span class="muted small">Field acres</span><b>${f.acres != null ? num(f.acres, 1) : '—'}</b></div>
      <div><span class="muted small">Drawn</span><b>${num(drawn, 1)}</b></div>
    </div>
    ${body}
    <div class="actions">
      ${f.boundary ? '<button class="small danger" data-act="remove">Remove</button>' : ''}
      <span class="spacer"></span>
      <button data-act="cancel">Cancel</button>
      <button class="primary" data-act="save" ${d && (d.shape === 'pivot' || d.ring.length >= 3) && ed.mode === 'edit' ? '' : 'disabled'}>Save</button>
    </div>`;

  const act = (name, fn) => { const b = $(`[data-act=${name}]`, side); if (b) b.onclick = fn; };
  act('cancel', () => { if (confirmDiscard()) endEdit(); });
  act('save', saveShape);
  act('remove', async () => {
    if (!confirm(`Take ${f.name} off the map?`)) return;
    await persistBoundary(f, null);
  });
  act('undo', () => { d.ring.pop(); ed.dirty = true; redrawDraft(); });
  act('finish', () => { ed.mode = 'edit'; redrawDraft(); });
  act('fit', () => { d.radius = radiusForAcres(Number(f.acres), spanOf(d)); ed.dirty = true; redrawDraft(); });
  act('topoly', () => {
    ed.draft = { shape: 'polygon', ring: simplifyRing(pivotRing(d).slice(0, -1)) };
    ed.dirty = true; redrawDraft();
  });
  act('topivot', () => {
    const ring = d.ring;
    const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    ed.draft = { shape: 'pivot', center: c, radius: radiusForAcres(Number(f.acres) || ringAcres(draftRing(d)) || 10), start: 0, end: 360 };
    ed.dirty = true; redrawDraft();
  });
  act('redraw', () => { ed.draft = { shape: 'polygon', ring: [] }; ed.mode = 'draw'; ed.dirty = true; redrawDraft(); });
  const arc = $('[data-act=arc]', side);
  if (arc) arc.onchange = () => {
    if (arc.value === 'custom') { if (spanOf(d) === 360) { d.start = 0; d.end = 270; } }
    else [d.start, d.end] = arc.value.split('-').map(Number);
    ed.dirty = true; redrawDraft();
  };
}

// Every 4th point of a circle is plenty to start reshaping from.
const simplifyRing = (ring) => ring.filter((_, i) => i % 4 === 0);

function startEdit(f) {
  if (!confirmDiscard()) return;
  mapState.ed = { field: f, draft: f.boundary ? toDraft(f.boundary) : null, mode: 'edit', dirty: false, handles: [], layer: null };
  drawFields();
  redrawDraft();
}

function startPlace(f, mode) {
  if (!confirmDiscard()) return;
  mapState.ed = { field: f, mode, dirty: true, handles: [], layer: null,
    draft: mode === 'draw' ? { shape: 'polygon', ring: [] } : null };
  drawFields();
  redrawDraft();
}

function onMapClick(e) {
  const ed = mapState.ed;
  if (!ed) return;
  const pt = fromLL(e.latlng);
  if (ed.mode === 'place') {
    const acres = Number(ed.field.acres) || 40;
    ed.draft = { shape: 'pivot', center: pt, radius: radiusForAcres(acres), start: 0, end: 360 };
    ed.mode = 'edit';
    redrawDraft();
  } else if (ed.mode === 'draw') {
    ed.draft.ring.push(pt);
    redrawDraft();
  }
}

function handle(latlng, cls, opts = {}) {
  return L.marker(latlng, { draggable: true, autoPan: true, icon: L.divIcon({ className: `map-handle ${cls}`, iconSize: opts.size ?? [16, 16] }) })
    .addTo(mapState.map);
}

function redrawDraft() {
  const ed = mapState.ed;
  const map = mapState.map;
  ed.handles.forEach((h) => h.remove());
  ed.handles = [];
  ed.layer?.remove();
  ed.layer = null;
  const d = ed.draft;
  if (d) {
    const ring = draftRing(d);
    if (ring.length) {
      ed.layer = (ed.mode === 'draw' ? L.polyline(d.ring.map(toLL), { color: '#ffd400', weight: 3 })
        : L.polygon(ring.map(toLL), { color: '#ffd400', weight: 3, fillColor: '#ffd400', fillOpacity: 0.2 })).addTo(map);
    }
    const update = () => { ed.dirty = true; ed.layer?.setLatLngs(draftRing(d).map(toLL)); refreshAcres(); };
    if (d.shape === 'pivot' && ed.mode === 'edit') {
      const span = spanOf(d);
      const mid = span < 360 ? d.start + span / 2 : 90;
      const center = handle(toLL(d.center), 'center', { size: [18, 18] });
      const edge = handle(toLL(atBearing(d, mid)), 'edge');
      const ends = span < 360 ? [handle(toLL(atBearing(d, d.start)), 'end'), handle(toLL(atBearing(d, d.end)), 'end')] : [];
      const place = () => {
        const s = spanOf(d);
        edge.setLatLng(toLL(atBearing(d, s < 360 ? d.start + s / 2 : 90)));
        if (ends.length) { ends[0].setLatLng(toLL(atBearing(d, d.start))); ends[1].setLatLng(toLL(atBearing(d, d.end))); }
      };
      center.on('drag', () => { d.center = fromLL(center.getLatLng()); place(); update(); });
      edge.on('drag', () => { d.radius = Math.max(5, metresBetween(d.center, fromLL(edge.getLatLng()))); update(); });
      edge.on('dragend', place);
      ends.forEach((h, i) => {
        h.on('drag', () => {
          const b = Math.round(bearingTo(d.center, fromLL(h.getLatLng())));
          if (i === 0) d.start = b; else d.end = b;
          update();
        });
        h.on('dragend', () => { place(); drawEditSide(); });
      });
      ed.handles.push(center, edge, ...ends);
    } else if (d.shape === 'polygon' && ed.mode === 'edit') {
      d.ring.forEach((p, i) => {
        const h = handle(toLL(p), 'vertex');
        h.on('drag', () => { d.ring[i] = fromLL(h.getLatLng()); update(); });
        h.on('dragend', redrawDraft);
        h.on('dblclick', () => { if (d.ring.length > 3) { d.ring.splice(i, 1); ed.dirty = true; redrawDraft(); } });
        ed.handles.push(h);
      });
      d.ring.forEach((p, i) => {
        const q2 = d.ring[(i + 1) % d.ring.length];
        const h = handle(toLL([(p[0] + q2[0]) / 2, (p[1] + q2[1]) / 2]), 'mid', { size: [11, 11] });
        let inserted = false;
        h.on('drag', () => {
          if (!inserted) { d.ring.splice(i + 1, 0, fromLL(h.getLatLng())); inserted = true; }
          d.ring[i + 1] = fromLL(h.getLatLng());
          update();
        });
        h.on('dragend', redrawDraft);
        ed.handles.push(h);
      });
    } else if (ed.mode === 'draw') {
      d.ring.forEach((p) => {
        const h = L.marker(toLL(p), { interactive: false, icon: L.divIcon({ className: 'map-handle vertex', iconSize: [12, 12] }) }).addTo(map);
        ed.handles.push(h);
      });
    }
  }
  drawEditSide();
}

function refreshAcres() {
  const d = mapState.ed?.draft;
  const el = $$('.acre-compare b')[1];
  if (d && el) el.textContent = num(ringAcres(draftRing(d)), 1);
}

async function saveShape() {
  const { field, draft } = mapState.ed;
  await persistBoundary(field, toFeature(draft));
}

async function persistBoundary(f, feature) {
  try {
    await q(sb.from('fields').update({ boundary: feature }).eq('field_id', f.field_id));
    f.boundary = feature;
    toast(feature ? 'Shape saved' : 'Removed from map');
    endEdit();
  } catch { /* shown */ }
}

function endEdit() {
  const ed = mapState.ed;
  if (ed) { ed.handles.forEach((h) => h.remove()); ed.layer?.remove(); }
  mapState.ed = null;
  drawFields();
  drawSide();
}

// =====================================================================
// Setup: reference lists
// =====================================================================
let setupTab = 'riders';
async function renderSetup(el) {
  const tabs = ['riders', 'turnouts', 'crops', 'operators', 'chemicals', 'equipment', 'leases'];
  el.innerHTML = `<div class="subtabs">${tabs.map((t) =>
    `<button data-tab="${t}" class="${t === setupTab ? 'active' : ''}">${esc(CRUD[t].title)}</button>`).join('')}</div>
    <div id="setup-body"><p class="muted">Loading…</p></div>`;
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { setupTab = b.dataset.tab; renderSetup(el); }));
  await renderCrud(CRUD[setupTab], $('#setup-body', el));
}

// =====================================================================
// Navigation and sign-in
// =====================================================================
const VIEWS = {
  home: renderHome,
  order: renderOrder,
  fields: (el) => renderCrud(CRUD.fields, el),
  crops: renderCrops,
  map: renderMap,
  setup: renderSetup,
};
let currentView = 'home';

async function show(view) {
  if (currentView === 'map' && view !== 'map' && !confirmDiscard()) return;
  if (view !== 'map') mapState.ed = null;
  if (currentView === 'order' && view !== 'order' && !okToLeaveOrder()) return;
  orderState.dirty = false;
  currentView = view;
  $$('nav [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const el = $('#view');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await VIEWS[view](el);
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty">This page couldn't load: ${esc(e.message)}</div>`;
  }
}

async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  try { await loadRefs(); } catch { return; }
  show(currentView);
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_KEY.includes('YOUR-')) {
  $('#config-warning').hidden = false;
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('button', f);
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: f.elements.email.value.trim(), password: f.elements.password.value });
  btn.disabled = false;
  if (error) toast(error.message, true);
};
$('#signout').onclick = () => sb.auth.signOut();
$$('nav [data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view)));

window.addEventListener('beforeunload', (e) => {
  if (currentView === 'order' && orderState.dirty) { e.preventDefault(); e.returnValue = ''; }
});

let started = false;
sb.auth.onAuthStateChange((_event, session) => {
  if (session && !started) {
    started = true;
    setTimeout(startApp, 0); // run outside the auth callback
  } else if (!session) {
    started = false;
    showLogin();
  }
});
