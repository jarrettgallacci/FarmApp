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
          ${cols.map((c) => `<td>${esc(display(c, r))}</td>`).join('')}
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
  const v = row ? row[c.key] : c.default;
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
  if (r.grown_by) return `<span class="badge off">Grown by ${esc(r.grown_by)}</span>`;
  if (r.season !== season) return `<span class="muted small">Planted ${r.season}</span>`;
  return esc(fmtDate(r.planting_date)) + (r.acres != null ? ` <span class="muted small">· ${num(r.acres, 0)} ac</span>` : '');
}
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
        <td><span class="crop-tag">${esc(cropName(r.crop_id))}</span>${r.sequence > 1 ? ` <span class="muted small">${SEQ[r.sequence] ?? ''}</span>` : ''}
          ${standNote(r, cropSeason)}
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
        <td><span class="crop-tag">${esc(cropName(r.crop_id))}</span></td><td>${esc(r.variety ?? '')}</td>
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
  const v = row ?? { sequence: 1, ...defaults };
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
        <label>Planting date<input type="date" name="planting_date" value="${esc(v.planting_date ?? '')}"></label>
        <label>Acres planted<input type="number" name="acres" step="0.1" min="0" value="${esc(v.acres ?? '')}"></label>
      </div>
      <p class="muted small" id="acres-hint"></p>
    </div>
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
  const syncLeasedOut = () => {
    const lease = el.field_id.value && el.season.value ? leasedOutIn(Number(el.field_id.value), Number(el.season.value)) : null;
    const out = !!lease || !!(row?.grown_by);
    $('#leased-out', dlg).hidden = !out;
    $('#our-crop', dlg).hidden = out;
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
    };
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
  setup: renderSetup,
};
let currentView = 'home';

async function show(view) {
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
