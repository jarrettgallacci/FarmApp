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
const refs = { riders: [], turnouts: [], fields: [] };

async function loadRefs() {
  const [riders, turnouts, fields] = await Promise.all([
    q(sb.from('ditch_riders').select('*').order('name')),
    q(sb.from('turnouts').select('*').order('name')),
    q(sb.from('fields').select('*').order('name')),
  ]);
  Object.assign(refs, { riders, turnouts, fields });
}
const fieldById = (id) => refs.fields.find((f) => f.field_id === Number(id));
const fieldName = (id) => fieldById(id)?.name ?? '';

// =====================================================================
// Generic list + edit screens (fields and setup tables)
// =====================================================================
const CRUD = {
  fields: {
    table: 'fields', pk: 'field_id', title: 'Fields', singular: 'field', order: 'name',
    search: true, refreshRefs: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'farm_unit', label: 'Farm unit', type: 'text', list: true },
      { key: 'block', label: 'Block', type: 'text' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'acres', label: 'Acres', type: 'number', step: '0.01', list: true },
      { key: 'tenure', label: 'Deeded or leased', type: 'select', list: true,
        options: () => [['deeded', 'Deeded'], ['leased', 'Leased']] },
      { key: 'turnout_id', label: 'Turnout', type: 'select', num: true, list: true,
        options: () => refs.turnouts.map((t) => [t.turnout_id, t.name]) },
      { key: 'flow_rate_cfs', label: 'Flow rate (CFS)', type: 'number', step: '0.01', list: true },
      { key: 'parent_field_id', label: 'Parent field (only for split halves)', type: 'select', num: true, list: true,
        options: (row) => refs.fields
          .filter((f) => !f.parent_field_id && f.field_id !== row?.field_id)
          .map((f) => [f.field_id, f.name]) },
      { key: 'water_field_id', label: 'District water field ID', type: 'text' },
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
    table: 'ditch_riders', pk: 'rider_id', title: 'Ditch riders', singular: 'ditch rider', order: 'name',
    refreshRefs: true, allowDelete: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'phone', label: 'Phone', type: 'text', list: true },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
  },
  turnouts: {
    table: 'turnouts', pk: 'turnout_id', title: 'Turnouts', singular: 'turnout', order: 'name',
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
  leases: {
    table: 'leases', pk: 'lease_id', title: 'Leases', singular: 'lease', order: 'start_date',
    allowDelete: true,
    columns: [
      { key: 'field_id', label: 'Field', type: 'select', num: true, required: true, list: true,
        options: () => refs.fields.map((f) => [f.field_id, f.name]) },
      { key: 'lessor', label: 'Lessor', type: 'text', required: true, list: true },
      { key: 'start_date', label: 'Start date', type: 'date', required: true, list: true },
      { key: 'end_date', label: 'End date', type: 'date', list: true },
      { key: 'rate', label: 'Rate', type: 'number', step: '0.01', list: true },
      { key: 'rate_basis', label: 'Rate basis (per acre, flat, crop share)', type: 'text', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
};

function display(c, r) {
  const v = r[c.key];
  if (c.type === 'checkbox') return v ? 'Yes' : 'No';
  if (c.type === 'select') return c.options(null).find(([val]) => String(val) === String(v))?.[1] ?? '';
  return v ?? '';
}

async function renderCrud(cfg, el) {
  const rows = await q(sb.from(cfg.table).select('*').order(cfg.order));
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
};

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
  await loadOrder(orderState.date);
  drawOrder($('#order-body', el));
}

function drawOrder(body) {
  const s = orderState;
  const parents = orderParents();
  if (!parents.length) {
    body.innerHTML = `<div class="empty">To build an order you need a ditch rider, a turnout assigned to that rider,
      and at least one field assigned to that turnout. Add them under <b>Setup</b> and <b>Fields</b>.</div>`;
    return;
  }
  const noTurnout = refs.fields.filter((f) => f.active && !f.parent_field_id && !f.turnout_id).length;

  let html = `<p id="order-status"></p>
    ${noTurnout ? `<p class="muted small">${noTurnout} field(s) have no turnout and aren't shown.</p>` : ''}
    <div class="order-grid"><div class="order-fields">`;

  for (const r of refs.riders) {
    const tos = refs.turnouts.filter((t) => t.rider_id === r.rider_id && parents.some((f) => f.turnout_id === t.turnout_id));
    if (!tos.length) continue;
    html += `<section class="card"><h3>${esc(r.name)}</h3>`;
    for (const t of tos) {
      html += `<div class="turnout"><div class="turnout-head"><span>${esc(t.name)}</span>
        <span class="total" data-total="${t.turnout_id}"></span></div>`;
      for (const f of parents.filter((p) => p.turnout_id === t.turnout_id)) {
        const l = lineFor(f);
        const subs = subunitsOf(f.field_id);
        html += `<div class="field-row">
          <label class="switch"><input type="checkbox" data-on="${f.field_id}" ${l.is_on ? 'checked' : ''}>
            <span>${esc(f.name)}</span></label>
          <span class="cfs"><input type="number" min="0" step="0.05" inputmode="decimal"
            data-cfs="${f.field_id}" value="${num(l.cfs)}"> CFS</span>
          ${subs.length ? `<div class="subs">${subs.map((sf) => `<label>
            <input type="checkbox" data-sub="${sf.field_id}" ${s.subs.get(sf.field_id) ? 'checked' : ''}>
            ${esc(sf.name)} watered</label>`).join('')}</div>` : ''}
        </div>`;
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

  $$('[data-on]', body).forEach((cb) => (cb.onchange = () => {
    lineFor(fieldById(cb.dataset.on)).is_on = cb.checked;
    s.dirty = true;
    updateOrderOutput(body);
  }));
  $$('[data-cfs]', body).forEach((inp) => (inp.oninput = () => {
    lineFor(fieldById(inp.dataset.cfs)).cfs = Number(inp.value) || 0;
    s.dirty = true;
    updateOrderOutput(body);
  }));
  $$('[data-sub]', body).forEach((cb) => (cb.onchange = () => { s.subs.set(Number(cb.dataset.sub), cb.checked); s.dirty = true; updateOrderOutput(body); }));
  $$('[data-save]', body).forEach((b) => (b.onclick = () => saveOrder(b.dataset.save, body)));
  updateOrderOutput(body);
}

function riderTexts() {
  const s = orderState;
  const out = [];
  for (const r of refs.riders) {
    const rows = [];
    for (const t of refs.turnouts.filter((x) => x.rider_id === r.rider_id)) {
      const now = turnoutCfs(t.turnout_id, s.lines);
      const was = turnoutCfs(t.turnout_id, s.prev);
      if (now === 0 && was === 0) continue;
      const val = now > 0 ? `${num(now)} CFS` : 'OFF';
      const note = s.prevDate == null ? ''
        : Math.abs(now - was) < 0.001 ? ' (no change)'
        : was > 0 ? ` (was ${num(was)})` : ' (new)';
      rows.push(`${t.name}: ${val}${note}`);
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
    : '<p class="muted">No water on or changing for this day.</p>';

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

  const needsOrder = (!tmr || tmr.status === 'draft') && new Date().getHours() >= 10;

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
// Setup: reference lists
// =====================================================================
let setupTab = 'riders';
async function renderSetup(el) {
  const tabs = ['riders', 'turnouts', 'operators', 'chemicals', 'equipment', 'leases'];
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
