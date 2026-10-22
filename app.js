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
const refs = { riders: [], turnouts: [], fields: [], leases: [], crops: [], chemicals: [], operators: [], workTypes: [], equipment: [] };

async function loadRefs() {
  const [riders, turnouts, fields, leases, crops, chemicals, operators] = await Promise.all([
    q(sb.from('ditch_riders').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('turnouts').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('fields').select('*').order('sort_order', { nullsFirst: false }).order('name')),
    q(sb.from('leases').select('*')),
    q(sb.from('crops').select('*').order('name')),
    q(sb.from('chemicals').select('*').order('name')),
    q(sb.from('operators').select('*').order('name')),
  ]);
  Object.assign(refs, { riders, turnouts, fields, leases, crops, chemicals, operators });
  // Work types (tolerates the table/columns not being set up yet)
  refs.workTypes = (await sb.from('operation_types').select('*').order('sort_order', { nullsFirst: false }).order('operation')).data ?? [];
  refs.equipment = (await sb.from('equipment').select('*, equipment_work_types(operation)').order('name')).data ?? [];
}
const equipName = (id) => refs.equipment.find((e) => e.equipment_id === id)?.name ?? '';
const isTractor = (e) => /tractor/i.test(e.type ?? '');
const isSprayer = (e) => /sprayer/i.test(e.type ?? '');
const doesWork = (e, op) => (e.equipment_work_types ?? []).some((x) => x.operation === op);
const workLabel = (op) => (op === 'cultivating' ? 'Cultivation' : op ? op[0].toUpperCase() + op.slice(1) : '');

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
    search: true, refreshRefs: true, allowDelete: true,
    tabs: [{ key: 'active', label: 'Active fields', test: (r) => r.active }, { key: 'inactive', label: 'Inactive fields', test: (r) => !r.active }],
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
      { key: 'active', label: 'Active', type: 'checkbox', default: true },
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
    allowDelete: true, refreshRefs: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'type', label: 'Type (contractor = work hired out)', type: 'select', required: true, list: true,
        options: () => [['partner', 'Partner'], ['employee', 'Employee'], ['contractor', 'Contractor']] },
      { key: 'license_no', label: 'Pesticide license / certification no.', type: 'text', list: true, listLabel: 'License no.' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
  },
  chemicals: {
    table: 'chemicals', pk: 'chemical_id', title: 'Chemicals', singular: 'chemical', order: 'name',
    allowDelete: true, refreshRefs: true, search: true,
    rowAction: { label: 'Label', fn: (row, reload) => openLabelDialog(chemById(row.chemical_id) ?? row, reload) },
    filters: [
      { key: 'type', all: 'All types', options: () => CHEM_TYPES, test: (r, v) => r.type === v },
      { key: 'label', all: 'Any label status', options: () => [['checked', 'Label checked'], ['unchecked', 'Label data, not checked'],
          ['nodata', 'No label data yet'], ['pdf', 'Has PDF'], ['nopdf', 'No PDF']],
        test: (r, v) => ({ checked: r.label_checked, unchecked: !!r.label_source && !r.label_checked, nodata: !r.label_source,
          pdf: !!r.label_path, nopdf: !r.label_path })[v] },
      { key: 'active', all: 'Active and inactive', options: () => [['yes', 'Active only'], ['no', 'Inactive only']],
        test: (r, v) => (v === 'yes' ? r.active !== false : r.active === false) },
    ],
    sorts: [
      ['name', 'Name', (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })],
      ['type', 'Type', (a, b) => a.type.localeCompare(b.type)],
      ['maker', 'Maker', (a, b) => (a.manufacturer ?? '~').localeCompare(b.manufacturer ?? '~')],
      ['label', 'Label status', (a, b) => (Number(!!b.label_checked) * 2 + Number(!!b.label_source)) - (Number(!!a.label_checked) * 2 + Number(!!a.label_source))],
    ],
    columns: [
      { key: 'name_list', label: 'Name', list: true, form: false, compute: (r) => r.name + (r.active === false ? ' (inactive)' : '') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'type', label: 'Type', type: 'select', required: true, list: true, options: () => CHEM_TYPES },
      { key: 'active_ingredient', label: 'Active ingredient', listLabel: 'Active ingr.', type: 'text', list: true },
      { key: 'manufacturer', label: 'Manufacturer', listLabel: 'Maker', type: 'text', list: true },
      { key: 'label_status', label: 'Label', list: true, form: false,
        compute: (r) => [r.label_path ? 'PDF' : null, r.label_source ? (r.label_checked ? '✓ checked' : 'not checked') : null].filter(Boolean).join(' · ') },
      { key: 'epa_reg_no', label: 'EPA reg. no. (links the current EPA label)', type: 'text' },
      { key: 'label_url', label: 'Other label link (manufacturer, 24c, PICOL…)', type: 'url' },
      { key: 'label_version', label: 'Label version the data came from (EPA accepted date or revision code)', type: 'text' },
      { key: 'active', label: 'Active (shows when picking products)', type: 'checkbox', default: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  equipment: {
    table: 'equipment', pk: 'equipment_id', title: 'Equipment', singular: 'equipment', order: 'name',
    allowDelete: true, refreshRefs: true,
    search: true,
    filters: [{ key: 'work', all: 'All work', options: () => refs.workTypes.filter((w) => w.active).map((w) => [w.operation, workLabel(w.operation)]),
      test: (r, v) => (r.equipment_work_types ?? []).some((x) => x.operation === v) },
      { key: 'type', all: 'All types', options: () => ['Tractor', 'Combine', 'Sprayer', 'Windrower', 'Implement', 'Truck', 'Other'].map((t) => [t, t]), test: (r, v) => (r.type ?? '').toLowerCase() === v.toLowerCase() }],
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'type', label: 'Type (tractor, combine, sprayer, implement...)', listLabel: 'Type', type: 'text', list: true },
      { key: 'make', label: 'Make', type: 'text', list: true },
      { key: 'model', label: 'Model', type: 'text', list: true },
      { key: 'model_year', label: 'Model year', listLabel: 'Year', type: 'number', step: '1', list: true },
      { key: 'serial_no', label: 'Serial number / PIN', listLabel: 'Serial / PIN', type: 'text', list: true },
      { key: 'unit_no', label: 'Unit number or nickname', type: 'text' },
      { key: 'engine_serial', label: 'Engine serial', type: 'text' },
      { key: 'hours', label: 'Hours', type: 'number', step: '0.1', list: true },
      { key: 'hours_date', label: 'Hours as of', type: 'date' },
      { key: 'purchase_date', label: 'Purchase date', type: 'date' },
      { key: 'purchase_price', label: 'Purchase price', type: 'number', step: '0.01' },
      { key: 'license_plate', label: 'License plate', type: 'text' },
      { key: 'planting_settings', label: 'Planting settings to record (planters only, one per line; for a choice write "Name: Option A | Option B")', type: 'textarea' },
      { key: 'work', label: 'Used for', list: true, form: false, compute: (r) => (r.equipment_work_types ?? []).map((x) => workLabel(x.operation)).join(', ') },
      { key: 'verified_on', label: 'Last checked (seen on the farm)', listLabel: 'Checked', type: 'date', list: true },
      { key: 'photos', label: 'Photos', list: true, form: false, compute: (r) => (r.equipment_photos?.[0]?.count ? `📷 ${r.equipment_photos[0].count}` : '') },
      { key: 'active', label: 'Active', type: 'checkbox', default: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    tabs: [{ key: 'active', label: 'Active', test: (r) => r.active }, { key: 'inactive', label: 'Sold / inactive', test: (r) => !r.active }],
    select: '*, equipment_photos(count), equipment_work_types(operation)',
    sorts: [['name', 'Name', (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })],
      ['type', 'Type', (a, b) => String(a.type ?? '').localeCompare(String(b.type ?? ''))],
      ['checked', 'Not checked first', (a, b) => String(a.verified_on ?? '').localeCompare(String(b.verified_on ?? ''))]],
    reopenAfterCreate: 'Saved. You can add photos now.',
    afterRender: (form, row) => { equipmentWorkTags(form, row); equipmentPhotos(form, row); },
  },
  worktypes: {
    table: 'operation_types', pk: 'operation', title: 'Work types', singular: 'work type', order: ['sort_order', 'operation'],
    refreshRefs: true, allowDelete: true,
    columns: [
      { key: 'operation', label: 'Work type (e.g. tillage, planting)', listLabel: 'Work type', type: 'text', required: true, list: true },
      { key: 'sort_order', label: 'Order in lists', listLabel: 'Order', type: 'number', step: '1', list: true },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
    ],
    beforeSave(d) { d.operation = d.operation.trim().toLowerCase(); },
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
  let req = sb.from(cfg.table).select(cfg.select ?? '*');
  for (const col of [].concat(cfg.order)) req = req.order(col, { nullsFirst: false });
  const rows = await q(req);
  const cols = cfg.columns.filter((c) => c.list);
  const st = (cfg.state ??= { q: '', f: {}, sort: cfg.sorts?.[0]?.[0] ?? '', tab: cfg.tabs?.[0]?.key });
  const filters = cfg.filters ?? [];
  const tab = cfg.tabs?.find((t) => t.key === st.tab);
  el.innerHTML = `
    <div class="section-head"><h2>${esc(cfg.title)}</h2>
      <button class="primary" data-act="add">Add ${esc(cfg.singular)}</button></div>
    ${cfg.tabs ? `<div class="subtabs">${cfg.tabs.map((t) => `<button class="${t.key === st.tab ? 'active' : ''}" data-tab="${t.key}">
      ${esc(t.label)} <span class="muted">${rows.filter(t.test).length}</span></button>`).join('')}</div>` : ''}
    ${cfg.search || filters.length || cfg.sorts ? `<div class="filters">
      ${cfg.search ? `<input type="search" class="search" placeholder="Search ${esc(cfg.title.toLowerCase())}…" value="${esc(st.q)}">` : ''}
      ${filters.map((f) => `<select data-filter="${f.key}"><option value="">${esc(f.all)}</option>${f.options().map(([v, t]) =>
        `<option value="${esc(v)}" ${st.f[f.key] === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`).join('')}
      ${cfg.sorts ? `<select data-sort>${cfg.sorts.map(([k, t]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>Sort: ${esc(t)}</option>`).join('')}</select>` : ''}
    </div><p class="muted small" data-count></p>` : ''}
    <div class="card table-wrap crud-wrap"><table class="crud">
      <thead><tr>${cols.map((c) => `<th>${esc(c.listLabel ?? c.label)}</th>`).join('')}<th></th></tr></thead>
      <tbody></tbody></table></div>`;

  const reload = () => renderCrud(cfg, el);
  const draw = () => {
    const term = st.q.trim().toLowerCase();
    const pool = tab ? rows.filter(tab.test) : rows;
    let shown = pool.filter((r) => filters.every((f) => !st.f[f.key] || f.test(r, st.f[f.key])) &&
      (!term || cols.some((c) => String(display(c, r) ?? '').toLowerCase().includes(term))));
    const sorter = cfg.sorts?.find(([k]) => k === st.sort)?.[2];
    if (sorter) shown = [...shown].sort((a, b) => sorter(a, b) || String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { numeric: true }));
    $('tbody', el).innerHTML = shown.length ? shown.map((r) => `<tr>
        ${cols.map((c) => c.type === 'color'
          ? `<td><span class="swatch" style="background:${esc(r[c.key] || c.fallback(r))}"></span></td>`
          : `<td>${esc(display(c, r))}</td>`).join('')}
        <td class="nowrap"><button class="small" data-edit="${r[cfg.pk]}">Edit</button>${cfg.rowAction ? ` <button class="small primary" data-row-act="${r[cfg.pk]}">${esc(cfg.rowAction.label)}</button>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="${cols.length + 1}" class="muted">${pool.length ? 'Nothing matches.' : 'Nothing here yet.'}</td></tr>`;
    const count = $('[data-count]', el);
    if (count) count.textContent = `${shown.length} of ${pool.length}`;
    $$('[data-edit]', el).forEach((b) => (b.onclick = () =>
      openForm(cfg, rows.find((r) => String(r[cfg.pk]) === b.dataset.edit), reload)));
    $$('[data-row-act]', el).forEach((b) => (b.onclick = () =>
      cfg.rowAction.fn(rows.find((r) => String(r[cfg.pk]) === b.dataset.rowAct), reload)));
  };
  $('[data-act=add]', el).onclick = () => openForm(cfg, null, reload);
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; reload(); }));
  const search = $('.search', el);
  if (search) search.oninput = () => { st.q = search.value; draw(); };
  $$('[data-filter]', el).forEach((s) => (s.onchange = () => { st.f[s.dataset.filter] = s.value; draw(); }));
  const sort = $('[data-sort]', el);
  if (sort) sort.onchange = () => { st.sort = sort.value; draw(); };
  draw();
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
  cfg.afterRender?.(form, row);

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
      else if (cfg.reopenAfterCreate) {
        const created = await q(sb.from(cfg.table).insert(data).select().single());
        if (cfg.refreshRefs) await loadRefs();
        toast(cfg.reopenAfterCreate);
        onDone();
        return openForm(cfg, created, onDone);
      } else await q(sb.from(cfg.table).insert(data));
      await finish('Saved');
    } catch { /* error already shown */ }
  };
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete this ${cfg.singular}? This can't be undone.`)) return;
    const { error } = await sb.from(cfg.table).delete().eq(cfg.pk, row[cfg.pk]);
    if (!error) return finish('Deleted');
    const fn = DELETE_EVERYWHERE[cfg.table];
    if (error.code !== '23503' || !fn) return toast(error.message, true);
    deleteEverythingDialog(cfg, row, fn, finish);
  };
  dlg.showModal();
}

// When a normal delete is blocked by attached records, offer to hide it (inactive)
// or delete it with everything attached (functions in sql/delete_helpers.sql).
const DELETE_EVERYWHERE = {
  fields: { fn: 'delete_field_everywhere', arg: 'p_field',
    what: 'its split halves, water order history, crop years and harvests, chemical records, work records and leases' },
  turnouts: { fn: 'delete_turnout_everywhere', arg: 'p_turnout',
    what: 'its water order history. Fields on this turnout are kept but will have no turnout' },
  ditch_riders: { fn: 'delete_rider_everywhere', arg: 'p_rider',
    what: 'their turnouts and the water order history for those turnouts. Fields are kept but will have no turnout' },
};

function deleteEverythingDialog(cfg, row, spec, onDone) {
  const dlg = $('#dialog');
  const name = String(row.name ?? '');
  const canHide = 'active' in row;
  dlg.innerHTML = `<form class="form">
    <h3>${esc(name)} has records attached</h3>
    <p>This ${esc(cfg.singular)} can't be deleted on its own because other records point to it.</p>
    ${canHide ? `<p><b>Mark inactive</b> hides it everywhere but keeps its history. Use this for anything real.</p>` : ''}
    <p><b>Delete everything</b> removes it along with ${esc(spec.what)}. Only for test entries; this can't be undone.</p>
    <label>To delete everything, type the name: <b>${esc(name)}</b><input name="confirm" autocomplete="off"></label>
    <div class="actions">
      <button type="button" class="danger" data-act="nuke" disabled>Delete everything</button>
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      ${canHide ? '<button type="button" class="primary" data-act="hide">Mark inactive</button>' : ''}
    </div></form>`;
  const input = $('[name=confirm]', dlg);
  const nuke = $('[data-act=nuke]', dlg);
  input.oninput = () => { nuke.disabled = input.value.trim() !== name.trim(); };
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  const hide = $('[data-act=hide]', dlg);
  if (hide) hide.onclick = async () => {
    try { await q(sb.from(cfg.table).update({ active: false }).eq(cfg.pk, row[cfg.pk])); await onDone('Marked inactive'); } catch { /* shown */ }
  };
  nuke.onclick = async () => {
    nuke.disabled = true;
    try { await q(sb.rpc(spec.fn, { [spec.arg]: row[cfg.pk] })); await onDone('Deleted'); }
    catch { nuke.disabled = false; }
  };
  if (!dlg.open) dlg.showModal();
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

// Fields on the water order, in water-order order, grouped by ditch rider.
function fieldsByRider() {
  return refs.riders.map((r) => ({
    rider: r,
    fields: refs.turnouts.filter((t) => t.rider_id === r.rider_id)
      .flatMap((t) => orderParents().filter((f) => f.turnout_id === t.turnout_id)),
  })).filter((g) => g.fields.length);
}

// What one field is doing in an order: off, or on at x CFS (and which halves).
function fieldState(f, o) {
  const l = o.lines.get(f.field_id);
  const on = !!l?.is_on;
  const subs = subunitsOf(f.field_id);
  const halves = on && subs.length ? subs.filter((sf) => o.subs.get(sf.field_id)) : [];
  const name = halves.length && halves.length < subs.length ? halves.map((h) => h.name).join(' + ') : f.name;
  return { on, cfs: on ? Number(l.cfs || 0) : 0, name, halfKey: halves.map((h) => h.field_id).join(',') };
}

async function renderHome(el) {
  const today = localDate();
  const tomorrow = addDays(today, 1);

  const [recent, todayRows, tomorrowRows] = await Promise.all([
    q(sb.from('water_orders').select('order_id, order_date, status').lte('order_date', today)
      .neq('status', 'draft').order('order_date', { ascending: false }).limit(2)),
    q(sb.from('water_orders').select('order_id, status').eq('order_date', today)),
    q(sb.from('water_orders').select('order_id, status, submitted_at').eq('order_date', tomorrow)),
  ]);

  const [current, previous] = recent;
  const changedToday = current?.order_date === today;
  const none = { lines: new Map(), subs: new Map() };
  const cur = current ? await linesFor(current.order_id) : none;
  const prev = changedToday && previous ? await linesFor(previous.order_id) : none;


  const groups = fieldsByRider().map((g) => ({
    rider: g.rider,
    rows: g.fields.map((f) => ({ f, a: fieldState(f, prev), b: fieldState(f, cur) })),
  }));
  const isChange = ({ a, b }) => a.on !== b.on || Math.abs(a.cfs - b.cfs) >= 0.001 || (a.on && b.on && a.halfKey !== b.halfKey);
  const changeGroups = changedToday
    ? groups.map((g) => ({ rider: g.rider, rows: g.rows.filter(isChange) })).filter((g) => g.rows.length) : [];
  const onGroups = groups.map((g) => ({ rider: g.rider, rows: g.rows.filter((r) => r.b.on) })).filter((g) => g.rows.length);
  const onCount = onGroups.reduce((n, g) => n + g.rows.length, 0);
  const onCfs = onGroups.reduce((n, g) => n + g.rows.reduce((m, r) => m + r.b.cfs, 0), 0);


  // ---- Water changes card (by field)
  const changeLine = ({ a, b }) => {
    let value, badge, name = b.on ? b.name : a.name;
    if (!b.on) { value = 'Off'; badge = '<span class="badge off">Off</span>'; }
    else if (!a.on) { value = `On ${num(b.cfs)} CFS`; badge = '<span class="badge new">On</span>'; }
    else if (a.halfKey !== b.halfKey && Math.abs(a.cfs - b.cfs) < 0.001) { name = b.name; value = `Moved from ${esc(a.name)}`; badge = '<span class="badge up">Move</span>'; }
    else { value = `${num(a.cfs)} → ${num(b.cfs)} CFS`; badge = b.cfs > a.cfs ? '<span class="badge up">Up</span>' : '<span class="badge down">Down</span>'; }
    return `<li><span class="li-name">${esc(name)}</span><span class="li-value">${value} ${badge}</span></li>`;
  };
  const groupHtml = (gs, line) => gs.map((g) => `<div class="group"><h4>${esc(g.rider.name)}</h4>
    <ul class="list">${g.rows.map(line).join('')}</ul></div>`).join('');

  let changesHtml;
  if (changedToday) {
    changesHtml = changeGroups.length
      ? groupHtml(changeGroups, changeLine)
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

  // ---- On after today's changes (by field)
  const runningHtml = onGroups.length
    ? groupHtml(onGroups, ({ b }) => `<li><span class="li-name">${esc(b.name)}</span><span class="li-value">${num(b.cfs)} CFS</span></li>`)
      + `<p class="muted small total-line">${onCount} field${onCount === 1 ? '' : 's'} · ${num(onCfs)} CFS total</p>`
    : '<p class="muted">Nothing is on.</p>';

  const needsOrder = (!tmr || tmr.status === 'draft') && new Date().getHours() * 60 + new Date().getMinutes() >= 14 * 60 + 30;

  el.innerHTML = `
    <div class="home-head">
      <p class="eyebrow">${esc(fmtLong(today))}</p>
      <h2>Today on the farm</h2>
    </div>
    ${needsOrder ? `<div class="alert">
      <span><b>Tomorrow's water order hasn't been sent.</b> It's due to the ditch riders around 2:30 PM.</span>
      <button class="primary small" data-act="tomorrow">Open order</button></div>` : ''}

    <div class="forecast" id="forecast"><p class="muted small">Loading forecast…</p></div>

    <div class="dash-grid">
      <div>
        <section class="card"><h3>Water changes today</h3>${changesHtml}</section>
        <section class="card"><h3>Water on after today's changes</h3>${runningHtml}</section>
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
  drawForecast($('#forecast', el));
}

// ---- 4-day forecast for the farm (Open-Meteo: free, no key). Cached 30 min per browser.
const FARM_LAT = 47.073, FARM_LON = -119.123;   // middle of the mapped fields
const WX = [
  [[0], '☀️', 'Sunny'], [[1], '🌤️', 'Mostly sunny'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'], [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 65, 66, 67], '🌧️', 'Rain'],
  [[71, 73, 75, 77, 85, 86], '🌨️', 'Snow'], [[80, 81, 82], '🌦️', 'Showers'], [[95, 96, 99], '⛈️', 'Thunderstorms'],
];
const wxOf = (code) => WX.find(([codes]) => codes.includes(code)) ?? [[], '🌡️', ''];
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

const SPRAY_MAX_MPH = 10, SPRAY_MIN_MPH = 2;   // highlighted spray window (sustained wind)
const MM_IN = 25.4;

async function loadForecast() {
  const key = 'farm-forecast-v2';
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.wx;
  } catch { /* storage unavailable */ }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + FARM_LAT + '&longitude=' + FARM_LON +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,' +
    'wind_direction_10m_dominant,precipitation_probability_max,precipitation_sum,et0_fao_evapotranspiration,sunrise,sunset' +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,cloud_cover,' +
    'wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles&forecast_days=4';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Forecast unavailable (' + res.status + ')');
  const { daily, hourly } = await res.json();
  const wx = { daily, hourly };
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), wx })); } catch { /* ignore */ }
  return wx;
}

const hourLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric' });
const inches = (mm) => (mm == null ? '—' : (mm / MM_IN).toFixed(2) + ' in');

async function drawForecast(box) {
  if (!box) return;
  try {
    const wx = await loadForecast();
    const d = wx.daily;
    const today = localDate();
    box.innerHTML = d.time.map((day, i) => {
      const [, icon, text] = wxOf(d.weather_code[i]);
      const label = day === today ? 'Today' : new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
      const rain = d.precipitation_probability_max?.[i];
      return `<button type="button" class="stat wx" data-wx-day="${i}" aria-label="${esc(label)} details">
        <span class="stat-label">${esc(label)} <span class="wx-more">Details ›</span></span>
        <div class="wx-main"><span class="wx-icon" aria-hidden="true">${icon}</span>
          <span class="stat-value">${Math.round(d.temperature_2m_max[i])}°<small> / ${Math.round(d.temperature_2m_min[i])}°</small></span></div>
        <span class="wx-text">${esc(text)}${rain >= 20 ? ` · ${rain}% rain` : ''}</span>
        <span class="wx-wind">Wind ${compass(d.wind_direction_10m_dominant[i])} ${Math.round(d.wind_speed_10m_max[i])}, gusts ${Math.round(d.wind_gusts_10m_max[i])} mph</span>
      </button>`;
    }).join('');
    $$('[data-wx-day]', box).forEach((b) => (b.onclick = () => openDayWeather(wx, Number(b.dataset.wxDay))));
  } catch (e) {
    box.innerHTML = `<p class="muted small">Forecast couldn't load right now (${esc(e.message)}).</p>`;
  }
}

function openDayWeather(wx, i) {
  const d = wx.daily, h = wx.hourly;
  const day = d.time[i];
  const hrs = h.time.map((t, k) => k).filter((k) => h.time[k].startsWith(day));
  const sunrise = d.sunrise?.[i], sunset = d.sunset?.[i];
  const daylight = (k) => !sunrise || (h.time[k] >= sunrise.slice(0, 13) && h.time[k] <= sunset);
  const sprayOk = (k) => daylight(k) && h.wind_speed_10m[k] >= SPRAY_MIN_MPH && h.wind_speed_10m[k] <= SPRAY_MAX_MPH;
  // Contiguous spray-friendly stretches, e.g. "6 AM–11 AM"
  const windows = [];
  for (const k of hrs) {
    if (!sprayOk(k)) continue;
    const last = windows[windows.length - 1];
    if (last && last.end === k - 1) last.end = k; else windows.push({ start: k, end: k });
  }
  const winText = windows.length
    ? windows.map((w) => `${hourLabel(h.time[w.start])}–${hourLabel(new Date(new Date(h.time[w.end]).getTime() + 3600e3))}`).join(', ')
    : 'None today';
  const [, icon, text] = wxOf(d.weather_code[i]);
  const title = new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<div class="form wx-day">
    <div class="dialog-head"><div><h3>${icon} ${esc(title)}</h3>
      <p class="muted small">${esc(text)} · forecast for the middle of the farm</p></div>
      <button data-act="close">Close</button></div>
    <div class="wx-summary">
      <div><span class="stat-label">High / low</span><b>${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°F</b></div>
      <div><span class="stat-label">Rain</span><b>${d.precipitation_probability_max?.[i] ?? 0}% · ${inches(d.precipitation_sum?.[i])}</b></div>
      <div><span class="stat-label">Crop water use (ET₀)</span><b>${inches(d.et0_fao_evapotranspiration?.[i])}</b></div>
      <div><span class="stat-label">Sunrise / sunset</span><b>${sunrise ? hourMin(sunrise) : '—'} / ${sunset ? hourMin(sunset) : '—'}</b></div>
    </div>
    <p class="wx-window"><b>Spray window</b> (daylight, wind ${SPRAY_MIN_MPH}–${SPRAY_MAX_MPH} mph): ${esc(winText)}</p>
    <div class="table-wrap"><table class="wx-hours">
      <thead><tr><th>Time</th><th class="r">Temp</th><th>Wind (mph)</th><th class="r">Gusts</th><th class="r">Rain</th><th class="r">Clouds</th><th class="r">Humidity</th></tr></thead>
      <tbody>${hrs.map((k) => `<tr class="${sprayOk(k) ? 'spray' : ''}${daylight(k) ? '' : ' night'}">
        <td>${esc(hourLabel(h.time[k]))}</td>
        <td class="r">${Math.round(h.temperature_2m[k])}°</td>
        <td>${compass(h.wind_direction_10m[k])} ${Math.round(h.wind_speed_10m[k])}</td>
        <td class="r">${Math.round(h.wind_gusts_10m[k])}</td>
        <td class="r">${h.precipitation_probability[k] ?? 0}%${h.precipitation[k] > 0 ? ` <span class="muted">${(h.precipitation[k] / MM_IN).toFixed(2)}"</span>` : ''}</td>
        <td class="r">${h.cloud_cover[k]}%</td>
        <td class="r">${h.relative_humidity_2m[k]}%</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">Green rows are inside the spray window. Always check the product label's wind limits and watch for temperature inversions on calm mornings and evenings. Weather data: Open-Meteo.</p>
  </div>`;
  $('[data-act=close]', dlg).onclick = () => dlg.close();
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}
const hourMin = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

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
      body += `<tr data-cyrow="${r.crop_year_id}">${i === 0 ? nameCell(list.length) : ''}
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
  loadRotationData().then((d) => {
    for (const r of rows) {
      if (r.season !== cropSeason || r.grown_by) continue;
      const c = rotationConflicts(d, r.field_id, r.crop_id, r.planting_date || `${r.season}-03-01`);
      const cell = $(`[data-cyrow="${r.crop_year_id}"] td:not(.field-cell)`, el);
      if (c.length && cell) cell.insertAdjacentHTML('beforeend', ` <span class="rot-flag" title="${esc(c.map((x) => `${chemById(x.app.chemical_id)?.name}: not before ${x.earliest}`).join('; '))}">⚠ plant-back</span>`);
    }
  }).catch(() => {});
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
      <span class="row"><button class="small" data-act="share">Share location</button>
      <button class="primary small" data-act="add">Add crop year</button></span></div>
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
  $('[data-act=share]', dlg).onclick = () => shareFields([f]);
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
    <div id="rot-box"></div>
    ${row ? '<div id="planting-box"></div>' : ''}
    <label>Notes<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    <div class="actions">
      ${row ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div></form>`;

  const form = $('form', dlg);
  const el = form.elements;
  if (row) {
    const reopenCrop = async () => {
      onDone?.();
      const [fresh] = await q(sb.from('crop_year_summary').select('*').eq('crop_year_id', row.crop_year_id));
      openCropYear(fresh ?? row, null, onDone);
    };
    plantingSection($('#planting-box', dlg), row, reopenCrop);
  }
  let rotData = null;
  const checkRotation = () => {
    const box = $('#rot-box', dlg);
    if (!rotData || !el.field_id.value || !el.crop_id.value || !el.season.value) { box.innerHTML = ''; return; }
    const date = el.planting_date.value || `${el.season.value}-03-01`;
    box.innerHTML = conflictHtml(rotationConflicts(rotData, Number(el.field_id.value), Number(el.crop_id.value), date), !el.planting_date.value);
  };
  loadRotationData().then((d) => { rotData = d; checkRotation(); }).catch(() => {});
  ['field_id', 'crop_id', 'season', 'planting_date'].forEach((k) => el[k].addEventListener('change', checkRotation));
  el.season.addEventListener('input', checkRotation);
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
  mapState.rot = await loadRotationData().catch(() => null);

  el.innerHTML = `
    <div class="section-head"><h2>Farm map</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous season">‹</button>
        <strong class="season">${season}</strong>
        <button data-season="1" aria-label="Next season">›</button>
        ${mapState.editMode ? '' : `<button class="${mapState.selecting ? 'primary' : ''}" data-act="select">${mapState.selecting ? 'Done selecting' : 'Select fields'}</button>`}
        <button class="${mapState.editMode ? 'primary' : ''}" data-act="edit">${mapState.editMode ? 'Done editing' : 'Edit shapes'}</button>
      </div></div>
    <div class="map-wrap"><div id="map"></div><aside class="card map-side" id="map-side"></aside></div>`;

  $$('[data-season]', el).forEach((b) => (b.onclick = () => {
    if (!confirmDiscard()) return;
    mapState.season += Number(b.dataset.season);
    renderMap(el);
  }));
  const sel = $('[data-act=select]', el);
  if (sel) sel.onclick = () => {
    mapState.selecting = !mapState.selecting;
    if (!mapState.selecting) mapState.selected = new Set();
    renderMap(el);
  };
  $('[data-act=edit]', el).onclick = () => {
    if (!confirmDiscard()) return;
    mapState.selecting = false;
    mapState.selected = new Set();
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
      else if (mapState.selecting) toggleSelect(f);
      else showFieldInfo(f);
    });
    if (mapState.selected?.has(f.field_id)) layer.setStyle({ color: '#ffd400', weight: 4, dashArray: null });
    else if (!mapState.editMode && fieldConflicts(f).length) layer.setStyle({ color: '#e11d48', weight: 3.5, dashArray: null });
    mapState.layers.push({ field: f, layer });
  }
}

// ---------- Side panel ----------
function fieldConflicts(f) {
  if (!mapState.rot) return [];
  return (mapState.cropsByField.get(f.field_id) ?? [])
    .filter((r) => r.season === mapState.season && !r.grown_by)
    .flatMap((r) => rotationConflicts(mapState.rot, f.field_id, r.crop_id, r.planting_date || `${r.season}-03-01`).map((c) => ({ ...c, crop: r })));
}

function toggleSelect(f) {
  mapState.selected ??= new Set();
  if (mapState.selected.has(f.field_id)) mapState.selected.delete(f.field_id);
  else mapState.selected.add(f.field_id);
  drawFields();
  drawSide();
}

function drawSelectSide() {
  const side = $('#map-side');
  const ids = [...(mapState.selected ?? [])];
  const picked = ids.map(fieldById).filter(Boolean);   // in the order they were tapped
  const acres = picked.reduce((t, f) => t + Number(f.acres || 0), 0);
  side.innerHTML = `<h3>Select fields</h3>
    <p class="muted small">Click fields on the map to add or remove them. For a load, tap them in the order you'll do them.</p>
    ${picked.length ? `<p><b>${picked.length}</b> field(s) · ${num(acres, 0)} ac</p>
      <div class="chips">${picked.map((f, i) => `<span class="chip"><b>${i + 1}</b> ${esc(f.name)}</span>`).join('')}</div>
      <div class="stack">
        <button class="primary" data-act="start-load">Start a load</button>
        <button data-act="log-chem">Log chemical application</button>
        <button data-act="plan-chem">Plan chemical application</button>
        <button data-act="share">Share locations</button>
        <button class="ghost small" data-act="clear">Clear selection</button>
      </div>` : '<p class="muted">Nothing selected yet.</p>'}`;
  const go = (status) => openChemForm({ fieldIds: ids, status }, () => { mapState.selected = new Set(); drawFields(); drawSide(); });
  const b = (n, fn) => { const x = $(`[data-act=${n}]`, side); if (x) x.onclick = fn; };
  b('log-chem', () => go('done'));
  b('plan-chem', () => go('planned'));
  b('start-load', () => openChemForm({ fieldIds: ids, asLoad: true, keepOrder: true }, () => { mapState.selected = new Set(); drawFields(); drawSide(); }));
  b('clear', () => { mapState.selected = new Set(); drawFields(); drawSide(); });
  b('share', () => shareFields(picked));
}

function drawSide(info) {
  const side = $('#map-side');
  if (!side) return;
  if (mapState.editMode) return drawEditSide();
  if (mapState.selecting) return drawSelectSide();
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
      Pale with a white dotted edge = planned, not planted. <span class="rot-key">Red edge</span> = plant-back conflict. Click a field for details.</p>
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
    ${(() => { const c = fieldConflicts(f); return c.length ? conflictHtml(c, c.some((x) => !x.crop.planting_date)) : ''; })()}
    <div class="actions wrap"><button data-act="history">Crop history</button>
      <button data-act="share">Share location</button>
      <button class="primary" data-act="log-chem">Log chemical</button></div>
    <h4>Recent chemical</h4><div id="recent-chem"><p class="muted small">Loading…</p></div>`;
  $('[data-act=log-chem]').onclick = () => openChemForm({ fieldIds: [f.field_id] }, () => showFieldInfo(f));
  $('#map-side [data-act=share]').onclick = () => shareFields([f]);
  recentChem(f.field_id).then((rows) => {
    const box = $('#recent-chem');
    if (!box) return;
    box.innerHTML = rows.length ? rows.map((r) => `<button class="recent-chem" data-ev="${r.event_id}">
        <span class="nowrap"><b>${esc(fmtDate(r.applied_on))}</b> ${new Date(r.applied_on + 'T12:00').getFullYear() !== new Date().getFullYear() ? new Date(r.applied_on + 'T12:00').getFullYear() : ''}
          ${r.status === 'planned' ? '<span class="badge down">Plan</span>' : ''} <span class="muted small">${esc(methodName(r.method))}</span></span>
        <span class="small">${r.chemical_event_products.map((l) => esc(chemById(l.chemical_id)?.name ?? '?')).join(', ') || '<span class="muted">No products</span>'}</span>
      </button>`).join('') : '<p class="muted small">No chemical records for this field.</p>';
    $$('[data-ev]', box).forEach((b) => (b.onclick = () => openChemForm({ event: rows.find((r) => r.event_id === Number(b.dataset.ev)) }, () => showFieldInfo(f))));
  }).catch(() => {});
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
// Work records: one record per field per pass (tillage, planting, ...).
// Planting adds seed and planter details and links to the crop year.
// =====================================================================
const workState = { season: new Date().getFullYear(), op: '', q: '' };
const PLANT_LABELS = ['Female', 'Male 1', 'Male 2', 'Male 3'];
const dateRange = (a, b) => (b && b !== a ? `${fmtDate(a)}–${fmtDate(b)}` : fmtDate(a));
const actualRate = (d, acres) => (d?.seed_used != null && Number(acres) > 0 ? Number(d.seed_used) / Number(acres) : null);
const rateFmt = (n, unit) => (n == null ? '' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 })} ${unit ?? ''}`.trim());

async function renderWork(el) {
  const s = workState;
  const { data, error } = await sb.from('work_events')
    .select('*, planting_details(*), crop_years(crop_id, variety)')
    .gte('performed_on', `${s.season}-01-01`).lte('performed_on', `${s.season}-12-31`)
    .order('performed_on', { ascending: false }).order('event_id', { ascending: false });
  if (error) { el.innerHTML = `<div class="empty">Work records aren't set up yet. Run <b>work_records.sql</b> in Supabase first.</div>`; return; }
  const term = s.q.trim().toLowerCase();
  const rows = data.filter((r) => (!s.op || r.operation === s.op) &&
    (!term || fieldName(r.field_id).toLowerCase().includes(term) || equipName(r.equipment_id).toLowerCase().includes(term)));
  el.innerHTML = `
    <div class="section-head"><h2>Work records</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous year">‹</button>
        <strong class="season">${s.season}</strong>
        <button data-season="1" aria-label="Next year">›</button>
        <button class="primary" data-act="add">Log work</button>
      </div></div>
    <div class="filters">
      <input type="search" data-f="q" placeholder="Search field or equipment…" value="${esc(s.q)}">
      <select data-f="op"><option value="">All work</option>${refs.workTypes.map((w) => `<option value="${esc(w.operation)}" ${s.op === w.operation ? 'selected' : ''}>${esc(workLabel(w.operation))}</option>`).join('')}</select>
    </div>
    <p class="muted small">${rows.length} of ${data.length} record(s) in ${s.season}.</p>
    ${rows.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>Date</th><th>Field</th><th>Work</th><th>Equipment</th><th class="r">Acres</th><th>By</th><th></th></tr></thead>
      <tbody>${rows.map((r) => {
        const d = r.planting_details?.[0] ?? r.planting_details;
        const crop = r.crop_years ? `${cropName(r.crop_years.crop_id)}${r.crop_years.variety ? ' · ' + r.crop_years.variety : ''}` : '';
        return `<tr><td class="nowrap">${esc(dateRange(r.performed_on, r.end_date))}</td>
          <td><b>${esc(fieldName(r.field_id))}</b></td>
          <td>${esc(workLabel(r.operation))}${d?.planting_label ? ` <span class="badge up">${esc(d.planting_label)}</span>` : ''}${crop ? `<div class="muted small">${esc(crop)}</div>` : ''}</td>
          <td>${esc([equipName(r.tractor_id), equipName(r.equipment_id)].filter(Boolean).join(' + '))}</td>
          <td class="r">${r.acres != null ? num(r.acres, 1) : ''}</td>
          <td>${esc(operatorName(r.performed_by))}</td>
          <td class="r"><button class="small" data-edit="${r.event_id}">Edit</button></td></tr>`;
      }).join('')}</tbody></table></div>` : `<div class="empty">No work records${data.length ? ' match' : ` for ${s.season}`}.</div>`}`;
  const reload = () => renderWork(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $('[data-act=add]', el).onclick = () => openWorkForm({}, reload);
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => openWorkForm({ eventId: Number(b.dataset.edit) }, reload)));
  $$('[data-f]', el).forEach((inp) => {
    const apply = () => { s[inp.dataset.f] = inp.value; reload(); };
    if (inp.type === 'search') { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(apply, 300); }; } else inp.onchange = apply;
  });
}

// opts: { eventId } to edit, or { operation, fieldId, cropYearId } for a new record
async function openWorkForm(opts, onDone) {
  let ev = null;
  if (opts.eventId) [ev] = await q(sb.from('work_events').select('*, planting_details(*)').eq('event_id', opts.eventId));
  const d = (Array.isArray(ev?.planting_details) ? ev.planting_details[0] : ev?.planting_details) ?? {};
  const v = ev ?? { operation: opts.operation ?? 'planting', performed_on: localDate(), field_id: opts.fieldId ?? null, crop_year_id: opts.cropYearId ?? null };
  const bands = ev ? await q(sb.from('chemical_events').select('*, chemical_event_products(*)').eq('work_event_id', ev.event_id)) : [];
  const types = refs.workTypes.filter((w) => w.active || w.operation === v.operation);
  const fields = fieldsInOrder().filter((f) => f.active || f.field_id === v.field_id);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form work-form">
    <div class="dialog-head"><h3>${ev ? 'Edit' : 'Log'} work</h3></div>
    <div class="row2">
      <label>Work *<select name="operation" required>${types.map((w) => `<option value="${esc(w.operation)}" ${w.operation === v.operation ? 'selected' : ''}>${esc(workLabel(w.operation))}</option>`).join('')}</select></label>
      <label>Field *<select name="field_id" required><option value="">Choose…</option>${fields.map((f) => `<option value="${f.field_id}" ${f.field_id === v.field_id ? 'selected' : ''}>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</option>`).join('')}</select></label>
    </div>
    <div class="row2">
      <label>Start date *<input type="date" name="performed_on" required value="${esc(v.performed_on)}"></label>
      <label>End date<input type="date" name="end_date" value="${esc(v.end_date ?? '')}"></label>
    </div>
    <p class="muted small form-hint">Leave the end date blank if it was done in one day.</p>
    <label data-plant>Crop and variety *<select name="crop_year_id"></select></label>
    <p class="muted small" data-plant id="cy-hint"></p>
    <div class="row2">
      <label>Tractor<select name="tractor_id"></select></label>
      <label><span id="impl-label">Implement</span><select name="equipment_id"></select></label>
    </div>
    <div class="row2">
      <label>Operator<select name="performed_by"><option value="">—</option>${refs.operators.filter((o) => o.active || o.operator_id === v.performed_by).map((o) => `<option value="${o.operator_id}" ${o.operator_id === v.performed_by ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label>Acres<input type="number" step="any" min="0" name="acres" value="${esc(v.acres ?? '')}"></label>
    </div>
    <fieldset data-plant class="plant-box"><legend>Planting</legend>
      <label class="check"><input type="checkbox" name="staggered" ${d.planting_label ? 'checked' : ''}> Staggered planting (male/female planted separately)</label>
      <label data-stagger>Which planting<select name="planting_label">${PLANT_LABELS.map((x) => `<option ${d.planting_label === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <div class="row2">
        <label>Row spacing (in)<input type="number" step="any" min="0" name="row_spacing_in" value="${esc(d.row_spacing_in ?? '')}"></label>
        <label>Seed lot #<input name="seed_lot" value="${esc(d.seed_lot ?? '')}"></label>
      </div>
      <div class="row4">
        <label>Target rate<input type="number" step="any" min="0" name="target_rate" value="${esc(d.target_rate ?? '')}"></label>
        <label>Unit<select name="target_unit">${['lb/ac', 'seeds/ac'].map((u) => `<option ${(d.target_unit ?? 'lb/ac') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label>Seed used<input type="number" step="any" min="0" name="seed_used" value="${esc(d.seed_used ?? '')}"></label>
        <label>Unit<select name="seed_used_unit">${['lb', 'seeds'].map((u) => `<option ${(d.seed_used_unit ?? 'lb') === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      <p class="actual-rate" id="actual-rate"></p>
      <div class="lines-head"><b id="settings-title">Planter settings</b><span class="muted small" id="settings-hint"></span></div>
      <div class="settings-grid" id="settings-box"></div>
      <div class="row2 pattern-row">
        <label>Pattern<select name="pattern"><option value="">—</option>
          <option value="straight" ${d.pattern === 'straight' ? 'selected' : ''}>Straight lines</option>
          <option value="circle" ${d.pattern === 'circle' ? 'selected' : ''}>Circle</option></select></label>
        <label data-heading>GPS heading (°)<input type="number" step="any" min="0" max="360" name="heading_deg" value="${esc(d.heading_deg ?? '')}" placeholder="0–359"></label>
      </div>
      <div class="band-box">${ev ? `<div class="lines-head"><b>Planter band</b><button type="button" class="small" data-act="band">+ Add planter band</button></div>
        ${bands.length ? `<ul class="list">${bands.map((b) => `<li><span class="li-name">${b.chemical_event_products.map((l) => `${esc(chemById(l.chemical_id)?.name ?? '?')} <span class="muted">${esc(rateText(l))}</span>`).join(', ') || 'No products'}</span><span class="li-value"><button type="button" class="small" data-band="${b.event_id}">Edit</button></span></li>`).join('')}</ul>` : '<p class="muted small">None. Use this for anything applied in the furrow or band at planting; it becomes a chemical record linked here.</p>'}`
        : '<p class="muted small">Save first to add a planter band (in-furrow or banded product).</p>'}</div>
    </fieldset>
    <label>Notes<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    <div class="actions">
      ${ev ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div></form>`;
  const form = $('form', dlg), el = form.elements;
  const op = () => el.operation.value;
  const fillEquip = () => {
    const pickList = (sel, list, cur, none) => {
      const keep = cur ? refs.equipment.find((e) => e.equipment_id === cur) : null;
      const opts = [...list]; if (keep && !opts.includes(keep)) opts.push(keep);
      sel.innerHTML = `<option value="">${none}</option>` + opts.map((e) => `<option value="${e.equipment_id}" ${e.equipment_id === cur ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
    };
    const active = refs.equipment.filter((e) => e.active);
    const tagged = active.filter((e) => doesWork(e, op()));
    const tractors = tagged.filter(isTractor);
    pickList(el.tractor_id, tractors.length ? tractors : active.filter(isTractor), Number(el.tractor_id.value) || v.tractor_id, '—');
    pickList(el.equipment_id, tagged.filter((e) => !isTractor(e)), Number(el.equipment_id.value) || v.equipment_id, '—');
    $('#impl-label', dlg).textContent = op() === 'planting' ? 'Planter' : op() === 'harvest' ? 'Machine' : 'Implement';
  };
  const fillCropYears = async () => {
    const fid = Number(el.field_id.value);
    const date = el.performed_on.value || localDate();
    const list = fid ? await cropFor(fid, date) : [];
    const cur = Number(el.crop_year_id.value) || v.crop_year_id;
    el.crop_year_id.innerHTML = `<option value="">Choose…</option>` + list.map((c) => `<option value="${c.crop_year_id}" ${c.crop_year_id === cur ? 'selected' : ''}>${esc(cropName(c.crop_id))}${c.variety ? ' · ' + esc(c.variety) : ''} (${c.season})</option>`).join('');
    if (!el.crop_year_id.value && list.length === 1) el.crop_year_id.value = list[0].crop_year_id;
    $('#cy-hint', dlg).textContent = fid && !list.length ? `No crop entered for this field in ${date.slice(0, 4)}. Add it under Crops first.` : '';
  };
  const showRate = () => {
    const acres = Number(el.acres.value);
    const used = el.seed_used.value === '' ? null : Number(el.seed_used.value);
    const unit = el.seed_used_unit.value;
    const r = actualRate({ seed_used: used }, acres);
    const tgt = el.target_rate.value === '' ? null : Number(el.target_rate.value);
    let txt = r == null ? 'Actual rate: enter seed used and acres' : `Actual rate: <b>${rateFmt(r, unit + '/ac')}</b>`;
    if (r != null && tgt && el.target_unit.value === unit + '/ac') txt += ` <span class="muted">(${r >= tgt ? '+' : ''}${(((r - tgt) / tgt) * 100).toFixed(0)}% vs target)</span>`;
    $('#actual-rate', dlg).innerHTML = txt;
  };
  // Settings: each planter has its own list (Setup -> Equipment). Values carry across planter switches by name.
  const settingVals = { ...(d.settings ?? {}) };
  if (!d.settings) {   // records saved before per-planter settings
    const old = { 'Seed plate': d.seed_plate, 'Sprocket 1': d.sprocket_1, 'Sprocket 2': d.sprocket_2, 'Depth (in)': d.depth_in, 'Speed (mph)': d.speed_mph, 'Seeds per 3 ft': d.seeds_per_3ft };
    Object.entries(old).forEach(([k, x]) => { if (x != null && x !== '') settingVals[k] = String(x); });
  }
  const origKeys = Object.keys(settingVals);
  const captureSettings = () => $$('[data-setting]', dlg).forEach((i) => { settingVals[i.dataset.setting] = i.value.trim(); });
  const plateLabel = () => {
    captureSettings();
    const p = refs.equipment.find((e) => e.equipment_id === Number(el.equipment_id.value));
    // A line like "Seed box: Large | Small" becomes a choice; anything else is a text box.
    const lines = (p?.planting_settings ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const choices = {};
    let names = lines.map((l) => {
      const m = l.match(/^([^:]+):\s*(.+\|.+)$/);
      if (!m) return l;
      choices[m[1].trim()] = m[2].split('|').map((x) => x.trim()).filter(Boolean);
      return m[1].trim();
    });
    const extra = origKeys.filter((k) => settingVals[k] && !names.includes(k));   // only from the saved record
    if (!names.length && !extra.length) names = ['Settings'];
    $('#settings-title', dlg).textContent = p ? `${p.name} settings` : 'Planter settings';
    $('#settings-hint', dlg).textContent = p?.planting_settings ? '' : (p ? 'No setting list for this planter yet; add one in Setup → Equipment' : 'Pick a planter');
    $('#settings-box', dlg).innerHTML = [...names, ...extra].map((k) => `<label>${esc(k)}${extra.includes(k) ? ' <span class="muted small">(other planter)</span>' : ''}${choices[k]
      ? `<select data-setting="${esc(k)}"><option value="">—</option>${[...new Set([...choices[k], settingVals[k]].filter(Boolean))].map((o) => `<option ${o === settingVals[k] ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input data-setting="${esc(k)}" value="${esc(settingVals[k] ?? '')}">`}</label>`).join('');
  };
  const syncPattern = () => { $$('[data-heading]', dlg).forEach((x) => (x.hidden = el.pattern.value !== 'straight')); };
  el.pattern.onchange = syncPattern; syncPattern();
  const sync = () => {
    const planting = op() === 'planting';
    $$('[data-plant]', dlg).forEach((x) => (x.hidden = !planting));
    el.crop_year_id.required = planting;
    $$('[data-stagger]', dlg).forEach((x) => (x.hidden = !el.staggered.checked));
    fillEquip(); plateLabel();
  };
  const fieldChanged = () => {
    const f = fieldById(el.field_id.value);
    if (!ev && f?.acres != null && !el.acres.dataset.touched) el.acres.value = Number(f.acres);
    fillCropYears();
  };
  el.operation.onchange = sync;
  el.staggered.onchange = sync;
  el.field_id.onchange = fieldChanged;
  el.performed_on.onchange = fillCropYears;
  el.equipment_id.onchange = plateLabel;
  el.acres.oninput = () => { el.acres.dataset.touched = '1'; showRate(); };
  ['seed_used', 'target_rate'].forEach((k) => (el[k].oninput = showRate));
  ['seed_used_unit', 'target_unit'].forEach((k) => (el[k].onchange = showRate));
  sync(); await fillCropYears(); if (!ev) fieldChanged(); showRate();
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  const reopen = () => openWorkForm({ eventId: ev.event_id }, onDone);
  $('[data-act=band]', dlg)?.addEventListener('click', () => openChemForm({ fieldIds: [ev.field_id], date: ev.performed_on, method: 'planter_band', workEventId: ev.event_id }, () => { onDone?.(); reopen(); }));
  $$('[data-band]', dlg).forEach((b) => (b.onclick = async () => {
    const [cev] = await q(sb.from('chemical_events').select('*, chemical_event_products(*), crop_years(crop_id, variety)').eq('event_id', Number(b.dataset.band)));
    cev.chemical_event_products.sort((a, x) => a.position - x.position);
    openChemForm({ event: cev }, () => { onDone?.(); reopen(); });
  }));

  form.onsubmit = async (e) => {
    e.preventDefault();
    const val = (k) => (el[k] ? String(el[k].value).trim() : '');
    const numOrNull = (k) => (val(k) === '' ? null : Number(val(k)));
    const planting = op() === 'planting';
    if (val('end_date') && val('end_date') < val('performed_on')) return toast('End date is before the start date', true);
    const row = {
      operation: op(), field_id: Number(val('field_id')), performed_on: val('performed_on'), end_date: val('end_date') || null,
      tractor_id: numOrNull('tractor_id'), equipment_id: numOrNull('equipment_id'), performed_by: numOrNull('performed_by'),
      acres: numOrNull('acres'), notes: val('notes') || null, crop_year_id: planting ? numOrNull('crop_year_id') : null,
    };
    const det = {
      planting_label: el.staggered.checked ? val('planting_label') : null, row_spacing_in: numOrNull('row_spacing_in'),
      seed_lot: val('seed_lot') || null, target_rate: numOrNull('target_rate'), target_unit: val('target_unit'),
      seed_used: numOrNull('seed_used'), seed_used_unit: val('seed_used_unit'), crop_year_id: row.crop_year_id,
      pattern: val('pattern') || null, heading_deg: val('pattern') === 'straight' ? numOrNull('heading_deg') : null,
    };
    det.settings = Object.fromEntries($$('[data-setting]', dlg).map((i) => [i.dataset.setting, i.value.trim()]).filter(([, x]) => x));
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      let id = ev?.event_id;
      if (ev) await q(sb.from('work_events').update(row).eq('event_id', id));
      else id = (await q(sb.from('work_events').insert(row).select('event_id').single())).event_id;
      if (planting) {
        await q(sb.from('planting_details').upsert({ event_id: id, ...det }));
        await syncPlantingDate(row.crop_year_id);
        if (ev?.crop_year_id && ev.crop_year_id !== row.crop_year_id) await syncPlantingDate(ev.crop_year_id);
      } else if (ev) await q(sb.from('planting_details').delete().eq('event_id', id));
      dlg.close(); toast('Saved'); onDone?.();
    } catch { btn.disabled = false; }
  };
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete this ${workLabel(ev.operation).toLowerCase()} record?${bands.length ? ' Its planter band records stay in Chemical.' : ''}`)) return;
    try {
      await q(sb.from('work_events').delete().eq('event_id', ev.event_id));
      if (ev.crop_year_id) await syncPlantingDate(ev.crop_year_id);
      dlg.close(); toast('Deleted'); onDone?.();
    } catch { /* shown */ }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// The crop year's planting date = the earliest planting record's start date.
async function syncPlantingDate(cropYearId) {
  if (!cropYearId) return;
  const recs = await q(sb.from('work_events').select('performed_on').eq('crop_year_id', cropYearId).eq('operation', 'planting').order('performed_on').limit(1));
  if (!recs.length) return;
  const [cy] = await q(sb.from('crop_years').select('planting_date, status').eq('crop_year_id', cropYearId));
  const patch = { planting_date: recs[0].performed_on };
  if (cy?.status === 'planned') patch.status = 'planted';
  if (cy && (cy.planting_date !== patch.planting_date || patch.status)) await q(sb.from('crop_years').update(patch).eq('crop_year_id', cropYearId));
}

// Planting records for one crop year (shown inside the crop-year form)
async function plantingSection(box, cropYear, reopenCrop) {
  const { data, error } = await sb.from('work_events').select('*, planting_details(*)').eq('crop_year_id', cropYear.crop_year_id).eq('operation', 'planting').order('performed_on');
  if (error) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="plant-list"><div class="lines-head"><b>Planting records</b>
      <button type="button" class="small" data-act="add-plant">+ Add planting</button></div>
    ${data.length ? `<ul class="list">${data.map((r) => {
      const d = (Array.isArray(r.planting_details) ? r.planting_details[0] : r.planting_details) ?? {};
      const act = actualRate(d, r.acres);
      return `<li><span class="li-name"><b>${esc(dateRange(r.performed_on, r.end_date))}</b>${d.planting_label ? ` <span class="badge up">${esc(d.planting_label)}</span>` : ''}
        <span class="muted small">${esc([equipName(r.equipment_id), d.seed_lot && 'lot ' + d.seed_lot, act != null && rateFmt(act, (d.seed_used_unit ?? 'lb') + '/ac'), d.pattern === 'circle' ? 'circle' : d.heading_deg != null ? `heading ${Number(d.heading_deg)}°` : ''].filter(Boolean).join(' · '))}</span></span>
        <span class="li-value"><button type="button" class="small" data-plant="${r.event_id}">Open</button></span></li>`;
    }).join('')}</ul>` : '<p class="muted small">No planting records yet.</p>'}</div>`;
  $('[data-act=add-plant]', box).onclick = () => openWorkForm({ operation: 'planting', fieldId: cropYear.field_id, cropYearId: cropYear.crop_year_id }, reopenCrop);
  $$('[data-plant]', box).forEach((b) => (b.onclick = () => openWorkForm({ eventId: Number(b.dataset.plant) }, reopenCrop)));
}

// =====================================================================
// Chemical records: one record per field per pass, with product lines.
// Opened from the Chemical tab or from fields selected on the map.
// =====================================================================
const METHODS = [['spray', 'Spray'], ['chemigation', 'Chemigation'], ['spread', 'Spread'], ['aerial', 'Aerial'], ['worked_in', 'Worked in'], ['planter_band', 'Planter band']];
const methodName = (m) => METHODS.find(([k]) => k === m)?.[1] ?? '—';
const CHEM_TYPES = [['herbicide', 'Herbicide'], ['insecticide', 'Insecticide'], ['fungicide', 'Fungicide'], ['fertilizer', 'Fertilizer'],
  ['adjuvant', 'Adjuvant'], ['soil_amendment', 'Soil amendment'], ['growth_regulator', 'Growth regulator'], ['other', 'Other']];
const RATE_UNITS = ['oz', 'pt', 'qt', 'gal', 'lb', '%'];
const BASES = [['acre', '/acre'], ['100gal', '/100 gal'], ['tank', '/tank'], ['total', 'total'], ['volume', 'of volume']];
const chemById = (id) => refs.chemicals.find((c) => c.chemical_id === id);
const operatorName = (id) => refs.operators.find((o) => o.operator_id === id)?.name ?? '';

function rateText(l) {
  if (l.rate == null) return l.rate_text ?? '';
  const r = Number(l.rate);
  const amount = Number.isInteger(r) ? r : Number(r.toFixed(3));
  if (l.rate_basis === 'volume') return `${amount}%`;
  const basis = l.rate_basis === 'tank' ? `/${l.tank_gal ? Number(l.tank_gal) + ' gal ' : ''}tank`
    : l.rate_basis === '100gal' ? '/100 gal' : l.rate_basis === 'total' ? ' total' : '/a';
  return `${amount} ${l.rate_unit ?? ''}${basis}`;
}
function carrierText(e) {
  const out = [];
  if (e.carrier_gpa != null) out.push(`${Number(e.carrier_gpa)} gal/a water`);
  if (e.pivot_speed_pct != null) out.push(`pivot ${Number(e.pivot_speed_pct)}%`);
  if (e.water_in != null) out.push(`${Number(e.water_in)} in water`);
  if (e.runtime_hr != null) out.push(`${Number(e.runtime_hr)} hr run`);
  if (e.injection_gph != null) out.push(`${Number(e.injection_gph)} gal/hr injection`);
  return out.join(' · ');
}
const eventCrop = (e) => (e.crop_years ? cropName(e.crop_years.crop_id) : e.crop_label ?? '');

const chemState = { season: new Date().getFullYear(), q: '', method: '', type: '', status: '' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const NON_PESTICIDE = ['fertilizer', 'adjuvant', 'soil_amendment'];
const isPesticide = (c) => !!c && !NON_PESTICIDE.includes(c.type);
const pad2 = (n) => String(n).padStart(2, '0');
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
function wxText(e) {
  const out = [];
  if (e.started_at) out.push(`${clock(e.started_at)}${e.stopped_at ? '–' + clock(e.stopped_at) : ' →'}`);
  if (e.wind_mph != null) out.push(`wind ${e.wind_dir ?? ''} ${Number(e.wind_mph)}${e.wind_mph_max != null && Number(e.wind_mph_max) !== Number(e.wind_mph) ? '–' + Number(e.wind_mph_max) : ''} mph`.replace('  ', ' '));
  if (e.temp_f != null) out.push(`${Number(e.temp_f)}°F`);
  return out.join(' · ');
}

// Current weather at a field (weather service estimate, not a measurement).
async function weatherNow(fieldId) {
  const f = fieldById(fieldId);
  const pt = fieldPoint(f) ?? [FARM_LON, FARM_LAT];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${pt[1].toFixed(4)}&longitude=${pt[0].toFixed(4)}` +
    '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles';
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather ' + res.status);
  const c = (await res.json()).current;
  return { temp_f: Math.round(c.temperature_2m), wind_mph: Math.round(c.wind_speed_10m), gust_mph: Math.round(c.wind_gusts_10m), wind_dir: compass(c.wind_direction_10m) };
}

async function renderChem(el) {
  const s = chemState;
  const rows = await q(sb.from('chemical_events')
    .select('*, chemical_event_products(*), crop_years(crop_id, variety)')
    .gte('applied_on', `${s.season}-01-01`).lte('applied_on', `${s.season}-12-31`)
    .order('applied_on', { ascending: false }).order('event_id', { ascending: false }));
  rows.forEach((r) => r.chemical_event_products.sort((a, b) => a.position - b.position));
  const term = s.q.trim().toLowerCase();
  const shown = rows.filter((r) =>
    (!s.method || r.method === s.method) &&
    (!s.status || r.status === s.status) &&
    (!s.type || r.chemical_event_products.some((l) => chemById(l.chemical_id)?.type === s.type)) &&
    (!term || fieldName(r.field_id).toLowerCase().includes(term) ||
      r.chemical_event_products.some((l) => chemById(l.chemical_id)?.name.toLowerCase().includes(term))));
  const planned = rows.filter((r) => r.status === 'planned').length;
  // (tolerates the loads table not existing yet)
  const openLoads = (await sb.from('chemical_loads').select('*, chemical_events(event_id, status, started_at, stopped_at)').eq('status', 'open').order('created_at')).data ?? [];

  el.innerHTML = `
    <div class="section-head"><h2>Chemical records</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous year">‹</button>
        <strong class="season">${s.season}</strong>
        <button data-season="1" aria-label="Next year">›</button>
        <button data-act="load">Start a load</button>
        <button class="primary" data-act="add">Add record</button>
      </div></div>
    ${openLoads.length ? `<section class="card loads-card"><h3>Loads in progress</h3><ul class="list">${openLoads.map((l) => {
      const evs = l.chemical_events; const done = evs.filter((e) => e.status === 'done').length;
      const running = evs.some((e) => e.started_at && !e.stopped_at);
      return `<li><span class="li-name"><b>${esc(l.name || methodName(l.method) + ' load')}</b> <span class="muted small">${esc(fmtDate(l.applied_on))}</span></span>
        <span class="li-value">${running ? '<span class="badge new">Running</span> ' : ''}${done} of ${evs.length} done <button class="small primary" data-load="${l.load_id}">Open</button></span></li>`;
    }).join('')}</ul></section>` : ''}
    <div class="filters">
      <input type="search" data-f="q" placeholder="Search field or product…" value="${esc(s.q)}">
      <select data-f="method"><option value="">All methods</option>${METHODS.map(([k, t]) => `<option value="${k}" ${s.method === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select data-f="type"><option value="">All product types</option>${CHEM_TYPES.map(([k, t]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select data-f="status"><option value="">Done and planned</option><option value="done" ${s.status === 'done' ? 'selected' : ''}>Done</option>
        <option value="planned" ${s.status === 'planned' ? 'selected' : ''}>Planned${planned ? ` (${planned})` : ''}</option></select>
    </div>
    <p class="muted small">${shown.length} of ${rows.length} record(s) in ${s.season}.</p>
    ${shown.length ? `<div class="card table-wrap"><table class="chem-table">
      <thead><tr><th>Date</th><th>Field</th><th class="c-crop">Crop</th><th>Method</th><th>Products</th><th class="c-by">Applied by</th><th></th></tr></thead>
      <tbody>${shown.map((r) => `<tr class="${r.status === 'planned' ? 'is-planned' : ''}">
        <td class="nowrap">${esc(fmtDate(r.applied_on))}${r.status === 'planned' ? ' <span class="badge down">Plan</span>' : ''}</td>
        <td class="nowrap"><b>${esc(fieldName(r.field_id))}</b></td>
        <td class="c-crop">${esc(eventCrop(r))}</td>
        <td>${esc(methodName(r.method))}${r.sprayer_id ? ` <span class="muted small">· ${esc(equipName(r.sprayer_id))}</span>` : ''}${carrierText(r) ? `<div class="muted small">${esc(carrierText(r))}</div>` : ''}${wxText(r) ? `<div class="muted small">${esc(wxText(r))}</div>` : ''}</td>
        <td><div class="prod-list">${r.chemical_event_products.map((l) => {
          const c = chemById(l.chemical_id);
          return `<span class="prod"><span class="type-dot t-${esc(c?.type ?? 'other')}"></span>${esc(c?.name ?? '?')} <span class="muted">${esc(rateText(l))}</span></span>`;
        }).join('')}</div></td>
        <td class="c-by">${esc(operatorName(r.performed_by))}</td>
        <td class="r"><button class="small" data-edit="${r.event_id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">No chemical records${rows.length ? ' match these filters' : ` for ${s.season}`}.</div>`}`;

  const reload = () => renderChem(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $('[data-act=add]', el).onclick = () => openChemForm({ fieldIds: [] }, reload);
  $('[data-act=load]', el).onclick = () => openChemForm({ fieldIds: [], asLoad: true }, reload);
  $$('[data-load]', el).forEach((b) => (b.onclick = () => openLoad(Number(b.dataset.load), reload)));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => openChemForm({ event: rows.find((r) => r.event_id === Number(b.dataset.edit)) }, reload)));
  $$('[data-f]', el).forEach((inp) => {
    const apply = () => { s[inp.dataset.f] = inp.value; reload().then(() => { const x = $(`[data-f="${inp.dataset.f}"]`, el); if (x?.type === 'search') { x.focus(); x.setSelectionRange(x.value.length, x.value.length); } }); };
    if (inp.type === 'search') { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(apply, 300); }; } else inp.onchange = apply;
  });
}

// The crop on a field for a date, from crop history (same season, or a stand still in).
async function cropFor(fieldId, date) {
  const season = Number(date.slice(0, 4));
  const rows = (await q(sb.from('crop_years').select('crop_year_id, crop_id, variety, season, sequence, multi_year, end_season, status')
    .eq('field_id', fieldId).lte('season', season)))
    .filter((r) => r.season === season || (r.multi_year && (r.end_season == null || r.end_season >= season)))
    .sort((a, b) => b.season - a.season || a.sequence - b.sequence);
  return rows;
}

// opts: { event } to edit, or { fieldIds, date, status } for new records
async function openChemForm(opts, onDone) {
  const ev = opts.event;
  const asLoad = !!opts.asLoad;
  const v = ev ?? { applied_on: opts.date ?? localDate(), status: asLoad ? 'planned' : opts.status ?? 'done', method: opts.method ?? 'spray' };
  const lines = ev ? ev.chemical_event_products.map((l) => ({ ...l })) : [{ rate_unit: 'oz', rate_basis: 'acre' }];
  let selected = new Set(ev ? [ev.field_id] : opts.fieldIds ?? []);
  const fields = fieldsInOrder().filter((f) => f.active || selected.has(f.field_id));
  const chems = [...refs.chemicals].filter((c) => c.active !== false);

  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form chem-form">
    <div class="dialog-head"><h3>${asLoad ? 'New load' : `${ev ? 'Edit' : 'New'} chemical record`}</h3></div>
    ${asLoad ? '<p class="muted small">Set up the tank mix once, pick the fields to queue, then start and stop each field as you get to it.</p>' : ''}
    <div class="row2">
      <label>Date *<input type="date" name="applied_on" required value="${esc(v.applied_on)}"></label>
      ${asLoad ? `<label>Load name<input name="load_name" placeholder="e.g. Grass seed – Huskie mix"></label>`
        : `<label>Status<select name="status">
        <option value="done" ${v.status !== 'planned' ? 'selected' : ''}>Done</option>
        <option value="planned" ${v.status === 'planned' ? 'selected' : ''}>Planned</option></select></label>`}
    </div>
    ${ev ? `<label>Field<select name="field_id">${fields.map((f) => `<option value="${f.field_id}" ${f.field_id === ev.field_id ? 'selected' : ''}>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</option>`).join('')}</select></label>`
      : `<div class="field-pick"><div class="field-pick-head"><span>Fields * <span class="muted small" id="pick-count"></span></span>
          <input type="search" id="pick-search" placeholder="Filter…"></div>
          <div class="pick-list">${fields.map((f) => `<label class="pick" data-name="${esc(f.name.toLowerCase())}">
            <input type="checkbox" value="${f.field_id}" ${selected.has(f.field_id) ? 'checked' : ''}>
            <span>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</span>${f.acres != null ? `<span class="muted small">${num(f.acres, 0)} ac</span>` : ''}</label>`).join('')}</div>
          <p class="muted small">${asLoad ? (opts.keepOrder ? 'Fields are queued in the order you tapped them on the map; you can reorder them in the load.' : 'Fields are queued in the order shown; you can reorder them in the load.') : 'Saving makes one record for each field picked.'}</p></div>`}
    <p class="muted small" id="crop-line"></p>
    <div class="row2">
      <label>Method<select name="method">${METHODS.map(([k, t]) => `<option value="${k}" ${v.method === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Applied by<select name="performed_by"><option value="">—</option>
        ${refs.operators.filter((o) => o.active || o.operator_id === v.performed_by).map((o) =>
          `<option value="${o.operator_id}" ${o.operator_id === v.performed_by ? 'selected' : ''}>${esc(o.name)}${o.type === 'contractor' ? ' (contractor)' : ''}</option>`).join('')}
      </select></label>
    </div>
    <label data-for="spray">Sprayer<select name="sprayer_id"><option value="">—</option>
      ${refs.equipment.filter((e) => isSprayer(e) && (e.active || e.equipment_id === v.sprayer_id)).map((e) =>
        `<option value="${e.equipment_id}" ${e.equipment_id === (v.sprayer_id ?? (ev ? null : refs.equipment.filter((x) => isSprayer(x) && x.active).length === 1 ? e.equipment_id : null)) ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
    </select></label>
    <div class="row2" data-for="spray aerial">
      <label>Water (gal/acre)<input type="number" step="any" min="0" name="carrier_gpa" value="${esc(v.carrier_gpa ?? '')}"></label>
      <label>Hours to complete<input type="number" step="any" min="0" name="hours" value="${esc(v.hours ?? '')}"></label>
    </div>
    <div data-for="chemigation">
      <div class="row2">
        <label>Pivot speed (%)<input type="number" step="any" min="0" max="100" name="pivot_speed_pct" value="${esc(v.pivot_speed_pct ?? '')}" placeholder="100 = full speed"></label>
        <label>Water (inches)<input type="number" step="any" min="0" name="water_in" value="${esc(v.water_in ?? '')}"></label>
      </div>
      <div class="row2">
        <label>Run time (hours)<input type="number" step="any" min="0" name="runtime_hr" value="${esc(v.runtime_hr ?? '')}"></label>
        <label>Injection rate (gal/hr)<input type="number" step="any" min="0" name="injection_gph" value="${esc(v.injection_gph ?? '')}"></label>
      </div>
    </div>
    <div class="lines-head"><b>Products</b><span class="muted small">Start typing a product name</span></div>
    <div id="lines"></div>
    <button type="button" class="small" data-act="add-line">+ Add product</button>
    <datalist id="chem-options"></datalist>
    ${asLoad ? `<label class="check"><input type="checkbox" name="record_times" checked> Record start/stop times and weather for each field <span class="muted small">(required for pesticides; uncheck for fertilizer-only loads)</span></label>`
      : `<details class="wx-fields" ${ev?.started_at || ev?.wind_mph != null ? 'open' : ''}><summary>Times and weather <span class="muted small">(required for pesticides)</span></summary>
      <div class="row2">
        <label>Start<input type="datetime-local" name="started_at" value="${esc(toLocalInput(v.started_at))}"></label>
        <label>Stop<input type="datetime-local" name="stopped_at" value="${esc(toLocalInput(v.stopped_at))}"></label>
      </div>
      <div class="row4">
        <label>Wind from<select name="wind_dir"><option value="">—</option>${COMPASS.map((d) => `<option ${v.wind_dir === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label>Wind mph<input type="number" step="any" min="0" name="wind_mph" value="${esc(v.wind_mph ?? '')}"></label>
        <label>to mph<input type="number" step="any" min="0" name="wind_mph_max" value="${esc(v.wind_mph_max ?? '')}" placeholder="if it varied"></label>
        <label>Temp °F<input type="number" step="any" name="temp_f" value="${esc(v.temp_f ?? '')}"></label>
      </div>
      <div class="row2">
        <label>Gusts mph<input type="number" step="any" min="0" name="gust_mph" value="${esc(v.gust_mph ?? '')}"></label>
        <label>Weather from<select name="weather_source"><option value="">—</option>
          <option value="measured" ${v.weather_source === 'measured' ? 'selected' : ''}>Measured at the field</option>
          <option value="auto" ${v.weather_source === 'auto' ? 'selected' : ''}>Weather service estimate</option></select></label>
      </div>
      <label>People who applied it<input name="applied_by_names" value="${esc(v.applied_by_names ?? '')}" placeholder="Names, if not just the operator above"></label>
      </details>`}
    <label>Notes<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    ${ev?.base_solution ? `<p class="muted small">Original record: "${esc(ev.base_solution)}"${ev.crop_label ? `, crop "${esc(ev.crop_label)}"` : ''}</p>` : ''}
    <div class="actions">
      ${ev ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">${asLoad ? 'Create load' : 'Save'}</button>
    </div></form>`;

  const form = $('form', dlg);
  const el = form.elements;

  // Product suggestions: fertilizers first for chemigation
  const fillOptions = () => {
    const fertFirst = el.method.value === 'chemigation';
    const list = [...chems].sort((a, b) => (fertFirst ? Number(b.type === 'fertilizer') - Number(a.type === 'fertilizer') : 0) || a.name.localeCompare(b.name));
    $('#chem-options', dlg).innerHTML = list.map((c) => `<option value="${esc(c.name)}">${esc(CHEM_TYPES.find(([k]) => k === c.type)?.[1] ?? '')}</option>`).join('');
  };
  const drawLines = () => {
    $('#lines', dlg).innerHTML = lines.map((l, i) => `<div class="line" data-i="${i}">
      <input class="l-name" list="chem-options" placeholder="Product" value="${esc(chemById(l.chemical_id)?.name ?? l.name ?? '')}" autocomplete="off">
      <input class="l-rate" type="number" step="any" min="0" placeholder="Rate" value="${esc(l.rate ?? '')}">
      <select class="l-unit">${RATE_UNITS.map((u) => `<option ${l.rate_unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
      <select class="l-basis">${BASES.map(([k, t]) => `<option value="${k}" ${(l.rate_basis ?? 'acre') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input class="l-tank" type="number" step="any" min="0" placeholder="Tank gal" value="${esc(l.tank_gal ?? '')}" ${l.rate_basis === 'tank' ? '' : 'hidden'}>
      <button type="button" class="small ghost" data-rm="${i}" aria-label="Remove">✕</button>
      ${l.rate == null && l.rate_text ? `<span class="muted small l-orig">Recorded as "${esc(l.rate_text)}"</span>` : ''}
    </div>`).join('');
    $$('.line', dlg).forEach((row) => {
      const l = lines[Number(row.dataset.i)];
      $('.l-name', row).oninput = (e) => { l.name = e.target.value; l.chemical_id = chems.find((c) => c.name.toLowerCase() === e.target.value.trim().toLowerCase())?.chemical_id; };
      $('.l-rate', row).oninput = (e) => { l.rate = e.target.value === '' ? null : Number(e.target.value); };
      $('.l-unit', row).onchange = (e) => { l.rate_unit = e.target.value; };
      $('.l-basis', row).onchange = (e) => { l.rate_basis = e.target.value; $('.l-tank', row).hidden = e.target.value !== 'tank'; };
      $('.l-tank', row).oninput = (e) => { l.tank_gal = e.target.value === '' ? null : Number(e.target.value); };
    });
    $$('[data-rm]', dlg).forEach((b) => (b.onclick = () => { lines.splice(Number(b.dataset.rm), 1); drawLines(); }));
  };
  const syncMethod = () => {
    $$('[data-for]', dlg).forEach((x) => (x.hidden = !x.dataset.for.split(' ').includes(el.method.value)));
    fillOptions();
  };
  const pickedIds = () => (ev ? [Number(el.field_id.value)] : $$('.pick-list input:checked', dlg).map((c) => Number(c.value)));
  const showCrop = async () => {
    const ids = pickedIds();
    const line = $('#crop-line', dlg);
    if (ids.length !== 1 || !el.applied_on.value) { line.textContent = ''; return; }
    const crops = await cropFor(ids[0], el.applied_on.value);
    line.textContent = crops.length ? `Crop: ${crops.map((c) => cropName(c.crop_id) + (c.variety ? ` (${c.variety})` : '')).join(', ')}`
      : ev?.crop_label ? `Crop as recorded: ${ev.crop_label}` : 'No crop in this field\'s history for that season.';
  };
  if (!ev) {
    const count = () => { $('#pick-count', dlg).textContent = `${pickedIds().length} picked`; showCrop(); };
    $$('.pick-list input', dlg).forEach((c) => (c.onchange = count));
    $('#pick-search', dlg).oninput = (e) => {
      const t = e.target.value.toLowerCase();
      $$('.pick', dlg).forEach((p) => (p.hidden = t && !p.dataset.name.includes(t)));
    };
    count();
  } else el.field_id.onchange = showCrop;
  el.applied_on.onchange = showCrop;
  el.method.onchange = syncMethod;
  $('[data-act=add-line]', dlg).onclick = () => { lines.push({ rate_unit: 'oz', rate_basis: 'acre' }); drawLines(); $$('.l-name', dlg).at(-1)?.focus(); };
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  drawLines();
  syncMethod();
  showCrop();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const ids = pickedIds();
    if (!ids.length) return toast('Pick at least one field', true);
    const used = lines.filter((l) => (l.name ?? chemById(l.chemical_id)?.name ?? '').trim());
    // New product names: offer to add them to the list
    const unknown = [...new Set(used.filter((l) => !l.chemical_id).map((l) => l.name.trim()))];
    if (unknown.length) {
      if (!confirm(`Add ${unknown.length === 1 ? 'a new product' : 'new products'} to your list?\n\n${unknown.join('\n')}\n\nYou can set the type under Setup → Chemicals.`)) return;
      try {
        const added = await q(sb.from('chemicals').insert(unknown.map((name) => ({ name, type: 'other' }))).select());
        refs.chemicals.push(...added);
        used.forEach((l) => { if (!l.chemical_id) l.chemical_id = added.find((c) => c.name.toLowerCase() === l.name.trim().toLowerCase())?.chemical_id; });
      } catch { return; }
    }
    const val = (k) => (el[k] ? el[k].value.trim() : '');
    const numOrNull = (k) => (val(k) === '' ? null : Number(val(k)));
    const method = val('method');
    const status = asLoad ? 'planned' : val('status');
    const tsOrNull = (k) => (val(k) ? new Date(val(k)).toISOString() : null);
    const timesWx = asLoad ? {} : {
      started_at: tsOrNull('started_at'), stopped_at: tsOrNull('stopped_at'), wind_dir: val('wind_dir') || null,
      wind_mph: numOrNull('wind_mph'), wind_mph_max: numOrNull('wind_mph_max'), gust_mph: numOrNull('gust_mph'),
      temp_f: numOrNull('temp_f'), weather_source: val('weather_source') || null, applied_by_names: val('applied_by_names') || null,
    };
    const pesticide = used.some((l) => isPesticide(chemById(l.chemical_id)));
    if (asLoad && !el.record_times.checked && pesticide &&
      !confirm('This load has pesticide products. Washington requires start/stop times and weather for those. Skip them anyway?')) return;
    if (!asLoad && status === 'done' && pesticide && (!timesWx.started_at || timesWx.wind_mph == null || timesWx.temp_f == null) &&
      !confirm('This record has pesticide products but is missing start time, wind or temperature (required in Washington). Save anyway?')) return;
    let loadId = null;
    if (asLoad) {
      try {
        loadId = (await q(sb.from('chemical_loads').insert({
          name: val('load_name') || null, applied_on: val('applied_on'), method,
          performed_by: val('performed_by') ? Number(val('performed_by')) : null,
          carrier_gpa: ['spray', 'aerial'].includes(method) ? numOrNull('carrier_gpa') : null,
          sprayer_id: method === 'spray' && val('sprayer_id') ? Number(val('sprayer_id')) : null,
          record_times: el.record_times.checked, notes: val('notes') || null,
        }).select('load_id').single())).load_id;
      } catch { return; }
    }
    const base = {
      ...timesWx, load_id: loadId,
      sprayer_id: method === 'spray' && val('sprayer_id') ? Number(val('sprayer_id')) : null,
      ...(opts.workEventId ? { work_event_id: opts.workEventId } : {}),
      applied_on: val('applied_on'), status, method,
      performed_by: val('performed_by') ? Number(val('performed_by')) : null,
      carrier_gpa: ['spray', 'aerial'].includes(method) ? numOrNull('carrier_gpa') : null,
      hours: ['spray', 'aerial'].includes(method) ? numOrNull('hours') : null,
      pivot_speed_pct: method === 'chemigation' ? numOrNull('pivot_speed_pct') : null,
      water_in: method === 'chemigation' ? numOrNull('water_in') : null,
      runtime_hr: method === 'chemigation' ? numOrNull('runtime_hr') : null,
      injection_gph: method === 'chemigation' ? numOrNull('injection_gph') : null,
      notes: val('notes') || null,
    };
    const lineRows = (eventId) => used.map((l, i) => ({
      event_id: eventId, chemical_id: l.chemical_id, position: i + 1,
      rate: l.rate ?? null, rate_unit: l.rate == null ? null : l.rate_unit ?? 'oz', rate_basis: l.rate == null ? null : l.rate_basis ?? 'acre',
      tank_gal: l.rate_basis === 'tank' ? l.tank_gal ?? null : null,
      rate_text: l.rate == null ? l.rate_text ?? null : null,
    }));
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const tapped = (opts.fieldIds ?? []).filter((id) => ids.includes(id));
      const ordered = !asLoad ? ids : opts.keepOrder
        ? [...tapped, ...fieldsInOrder().map((f) => f.field_id).filter((id) => ids.includes(id) && !tapped.includes(id))]
        : fieldsInOrder().map((f) => f.field_id).filter((id) => ids.includes(id));
      for (const [n, fid] of ordered.entries()) {
        const crops = await cropFor(fid, base.applied_on);
        const keepLink = ev && ev.field_id === fid && ev.crop_year_id && crops.some((c) => c.crop_year_id === ev.crop_year_id);
        const row = { ...base, field_id: fid, crop_year_id: keepLink ? ev.crop_year_id : crops[0]?.crop_year_id ?? null };
        if (asLoad) { row.queue_pos = n + 1; row.acres_treated = fieldById(fid)?.acres ?? null; }
        if (ev) { delete row.load_id; }
        let eventId;
        if (ev) {
          await q(sb.from('chemical_events').update(row).eq('event_id', ev.event_id));
          await q(sb.from('chemical_event_products').delete().eq('event_id', ev.event_id));
          eventId = ev.event_id;
        } else {
          eventId = (await q(sb.from('chemical_events').insert(row).select('event_id').single())).event_id;
        }
        if (used.length) await q(sb.from('chemical_event_products').insert(lineRows(eventId)));
      }
      rotationCache.at = 0;
      dlg.close();
      toast(asLoad ? `Load created with ${ids.length} field(s)` : ids.length > 1 ? `Saved ${ids.length} records` : 'Saved');
      onDone?.();
      if (asLoad) openLoad(loadId, onDone);
    } catch {
      btn.disabled = false;
    }
  };
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm('Delete this chemical record?')) return;
    try {
      await q(sb.from('chemical_events').delete().eq('event_id', ev.event_id));
      dlg.close();
      toast('Deleted');
      onDone?.();
    } catch { /* shown */ }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// =====================================================================
// Loads: one tank mix, a queue of fields. Start/Stop stamps the times and
// pulls the weather at that field; each field becomes its own record.
// =====================================================================
let loadTimer = null;
async function openLoad(loadId, onChange) {
  const [load] = await q(sb.from('chemical_loads').select('*').eq('load_id', loadId));
  if (!load) return toast('Load not found', true);
  const evs = await q(sb.from('chemical_events').select('*, chemical_event_products(*)').eq('load_id', loadId)
    .order('queue_pos', { nullsFirst: false }).order('event_id'));
  const mix = evs[0]?.chemical_event_products.sort((a, b) => a.position - b.position) ?? [];
  const times = load.record_times;
  const running = evs.find((e) => e.started_at && !e.stopped_at);
  const done = evs.filter((e) => e.status === 'done');
  const acresDone = done.reduce((n, e) => n + Number(e.acres_treated || 0), 0);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  const elapsed = (e) => { const m = Math.round((Date.now() - new Date(e.started_at)) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const row = (e, i) => {
    const f = fieldById(e.field_id);
    const isRun = e === running, isDone = e.status === 'done';
    const state = isDone ? `<span class="badge new">Done</span>` : isRun ? `<span class="badge up">Running</span>` : `<span class="badge off">Queued</span>`;
    const info = isDone ? wxText(e) || (times ? '' : 'Done') : isRun ? `Started ${clock(e.started_at)} · <span data-elapsed="${e.started_at}">${elapsed(e)}</span>${e.wind_mph != null ? ' · ' + esc(wxText({ ...e, started_at: null })) : ''}` : '';
    let btns = '';
    if (isRun) btns = `<button class="danger" data-stop="${e.event_id}">Stop</button>`;
    else if (!isDone) btns = times
      ? `<button class="primary" data-start="${e.event_id}" ${running ? 'disabled title="Stop the running field first"' : ''}>Start</button>`
      : `<button class="primary" data-done="${e.event_id}">Done</button>`;
    else btns = `<button class="small ghost" data-edit-ev="${e.event_id}">Edit</button>`;
    const move = !isDone && !isRun ? `<span class="move"><button class="icon" data-mv="${i}:-1" aria-label="Move up">↑</button><button class="icon" data-mv="${i}:1" aria-label="Move down">↓</button></span>` : '';
    return `<li class="load-row ${isRun ? 'running' : ''} ${isDone ? 'done' : ''}">
      <div class="lr-main"><b>${esc(f?.name ?? '?')}</b> <span class="muted small">${e.acres_treated != null ? num(e.acres_treated, 0) + ' ac' : ''}</span> ${state}
        ${info ? `<div class="muted small">${info}</div>` : ''}</div>
      <div class="lr-act">${move}${!isDone && !isRun ? `<button class="small ghost" data-rm-ev="${e.event_id}" aria-label="Remove from load">✕</button>` : ''}${btns}</div></li>`;
  };
  dlg.innerHTML = `<div class="form load-view">
    <div class="dialog-head"><div><h3>${esc(load.name || methodName(load.method) + ' load')}</h3>
      <p class="muted small">${esc(fmtDate(load.applied_on))} · ${esc(methodName(load.method))}${load.carrier_gpa != null ? ` · ${Number(load.carrier_gpa)} gal/a water` : ''}${load.performed_by ? ` · ${esc(operatorName(load.performed_by))}` : ''}${load.sprayer_id ? ` · ${esc(equipName(load.sprayer_id))}` : ''}</p></div>
      <button data-act="close">Close</button></div>
    <div class="prod-list">${mix.map((l) => { const c = chemById(l.chemical_id); return `<span class="prod"><span class="type-dot t-${esc(c?.type ?? 'other')}"></span>${esc(c?.name ?? '?')} <span class="muted">${esc(rateText(l))}</span></span>`; }).join('')}</div>
    <p class="muted small">${done.length} of ${evs.length} fields done · ${num(acresDone, 0)} acres${times ? ' · Start stamps the time and pulls the weather at that field; Stop stamps the end time.' : ''}</p>
    <ul class="load-list">${evs.map(row).join('')}</ul>
    <div class="actions">
      <button data-act="add-fields">+ Add fields</button>
      <span class="spacer"></span>
      <button class="primary" data-act="finish">${done.length === evs.length ? 'Close out load' : 'Finish load'}</button>
    </div>
    ${times ? '<p class="muted small">Weather is a weather-service estimate for the field. If you take a reading with a meter, edit the record and set "Weather from" to measured.</p>' : ''}
  </div>`;
  const reopen = () => { onChange?.(); return openLoad(loadId, onChange); };
  clearInterval(loadTimer);
  loadTimer = setInterval(() => $$('[data-elapsed]', dlg).forEach((x) => (x.textContent = elapsed({ started_at: x.dataset.elapsed }))), 30000);
  dlg.onclose = () => { clearInterval(loadTimer); dlg.classList.remove('wide'); };
  $('[data-act=close]', dlg).onclick = () => dlg.close();
  const evById = (id) => evs.find((e) => e.event_id === Number(id));
  const busy = (b) => { b.disabled = true; b.textContent = '…'; };
  $$('[data-start]', dlg).forEach((b) => (b.onclick = async () => {
    busy(b);
    const e = evById(b.dataset.start);
    const patch = { started_at: new Date().toISOString(), applied_on: localDate() };
    try { Object.assign(patch, await weatherNow(e.field_id), { weather_source: 'auto' }); }
    catch { toast('Started. Weather couldn\'t load - add it when you stop or edit the record.', true); }
    try { await q(sb.from('chemical_events').update(patch).eq('event_id', e.event_id)); } catch { /* shown */ }
    reopen();
  }));
  $$('[data-stop]', dlg).forEach((b) => (b.onclick = async () => {
    busy(b);
    const e = evById(b.dataset.stop);
    const patch = { stopped_at: new Date().toISOString(), status: 'done' };
    try {
      const w = await weatherNow(e.field_id);
      if (e.wind_mph == null) Object.assign(patch, w, { weather_source: 'auto' });
      else {
        const lo = Math.min(Number(e.wind_mph), w.wind_mph), hi = Math.max(Number(e.wind_mph_max ?? e.wind_mph), w.wind_mph);
        Object.assign(patch, { wind_mph: lo, wind_mph_max: hi > lo ? hi : null, gust_mph: Math.max(Number(e.gust_mph ?? 0), w.gust_mph) });
      }
    } catch { /* keep start-time weather */ }
    try { await q(sb.from('chemical_events').update(patch).eq('event_id', e.event_id)); rotationCache.at = 0; } catch { /* shown */ }
    reopen();
  }));
  $$('[data-done]', dlg).forEach((b) => (b.onclick = async () => {
    busy(b);
    try { await q(sb.from('chemical_events').update({ status: 'done', applied_on: localDate() }).eq('event_id', Number(b.dataset.done))); rotationCache.at = 0; } catch { /* shown */ }
    reopen();
  }));
  $$('[data-rm-ev]', dlg).forEach((b) => (b.onclick = async () => {
    if (!confirm(`Take ${fieldName(evById(b.dataset.rmEv).field_id)} out of this load?`)) return;
    try { await q(sb.from('chemical_events').delete().eq('event_id', Number(b.dataset.rmEv))); } catch { /* shown */ }
    reopen();
  }));
  $$('[data-mv]', dlg).forEach((b) => (b.onclick = async () => {
    const [i, d] = b.dataset.mv.split(':').map(Number);
    const j = i + d;
    if (j < 0 || j >= evs.length || evs[j].status === 'done' || evs[j] === running) return;
    const list = [...evs]; [list[i], list[j]] = [list[j], list[i]];
    try { await Promise.all(list.map((e, n) => q(sb.from('chemical_events').update({ queue_pos: n + 1 }).eq('event_id', e.event_id)))); } catch { /* shown */ }
    reopen();
  }));
  $$('[data-edit-ev]', dlg).forEach((b) => (b.onclick = () => openChemForm({ event: evById(b.dataset.editEv) }, reopen)));
  $('[data-act=add-fields]', dlg).onclick = () => addFieldsToLoad(load, evs, mix, reopen);
  $('[data-act=finish]', dlg).onclick = async () => {
    if (running) return toast('Stop the running field first', true);
    const left = evs.filter((e) => e.status !== 'done');
    if (left.length && !confirm(`${left.length} field(s) weren't done. They'll be removed from this load. Finish anyway?`)) return;
    try {
      if (left.length) await q(sb.from('chemical_events').delete().in('event_id', left.map((e) => e.event_id)));
      await q(sb.from('chemical_loads').update({ status: 'closed' }).eq('load_id', loadId));
      dlg.close(); toast('Load finished'); onChange?.();
    } catch { /* shown */ }
  };
  if (!dlg.open) dlg.showModal();
}

function addFieldsToLoad(load, evs, mix, onDone) {
  const inLoad = new Set(evs.map((e) => e.field_id));
  const fields = fieldsInOrder().filter((f) => f.active && !inLoad.has(f.field_id));
  const dlg = $('#dialog');
  dlg.innerHTML = `<form class="form"><h3>Add fields to the load</h3>
    <input type="search" id="pick-search" placeholder="Filter…">
    <div class="pick-list">${fields.map((f) => `<label class="pick" data-name="${esc(f.name.toLowerCase())}"><input type="checkbox" value="${f.field_id}">
      <span>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</span>${f.acres != null ? `<span class="muted small">${num(f.acres, 0)} ac</span>` : ''}</label>`).join('')}</div>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="back">Back</button><button class="primary">Add</button></div></form>`;
  $('#pick-search', dlg).oninput = (e) => { const t = e.target.value.toLowerCase(); $$('.pick', dlg).forEach((p) => (p.hidden = t && !p.dataset.name.includes(t))); };
  $('[data-act=back]', dlg).onclick = onDone;
  $('form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const ids = $$('.pick-list input:checked', dlg).map((c) => Number(c.value));
    if (!ids.length) return onDone();
    const tmpl = evs[0] ?? {};
    let pos = Math.max(0, ...evs.map((x) => x.queue_pos ?? 0));
    try {
      for (const fid of ids) {
        const crops = await cropFor(fid, load.applied_on);
        const ev = (await q(sb.from('chemical_events').insert({
          field_id: fid, load_id: load.load_id, queue_pos: ++pos, status: 'planned', applied_on: load.applied_on,
          method: load.method, performed_by: load.performed_by, carrier_gpa: load.carrier_gpa, notes: load.notes, sprayer_id: load.sprayer_id ?? null,
          hours: null, pivot_speed_pct: tmpl.pivot_speed_pct ?? null, water_in: tmpl.water_in ?? null,
          acres_treated: fieldById(fid)?.acres ?? null, crop_year_id: crops[0]?.crop_year_id ?? null,
        }).select('event_id').single())).event_id;
        if (mix.length) await q(sb.from('chemical_event_products').insert(mix.map((l) => ({
          event_id: ev, chemical_id: l.chemical_id, position: l.position, rate: l.rate, rate_unit: l.rate_unit,
          rate_basis: l.rate_basis, tank_gal: l.tank_gal, rate_text: l.rate_text }))));
      }
    } catch { /* shown */ }
    onDone();
  };
}

// Recent records for one field (map side panel)
async function recentChem(fieldId, limit = 5) {
  const rows = await q(sb.from('chemical_events').select('*, chemical_event_products(*)')
    .eq('field_id', fieldId).order('applied_on', { ascending: false }).limit(limit));
  rows.forEach((r) => r.chemical_event_products.sort((a, b) => a.position - b.position));
  return rows;
}

// =====================================================================
// Chemical labels: label facts, PDF, and rotation (plant-back) rules.
// Rotation conflicts warn when a crop is planned or planted too soon
// after a product on the same field. They never block saving.
// =====================================================================
const ruleWait = (r) => (r.seasons_after != null ? `not until ${r.seasons_after === 1 ? 'the next season' : `${r.seasons_after} seasons later`}`
  : Number(r.months) === 0 ? 'anytime' : `${Number(r.months)} month${Number(r.months) === 1 ? '' : 's'}`);

// EPA's label page for a product (distributor numbers like 100-497-5905 use the base 100-497).
function epaLabelUrl(reg) {
  const parts = String(reg ?? '').trim().split('-');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return `https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:${parts[0]}-${parts[1]}`;
}

async function openLabelDialog(chem, onDone, unlocked = false) {
  const rules = await q(sb.from('chemical_rotation_rules').select('*').eq('chemical_id', chem.chemical_id));
  const named = rules.filter((r) => r.crop_id != null).sort((a, b) => cropName(a.crop_id).localeCompare(cropName(b.crop_id)));
  const other = rules.find((r) => r.crop_id == null);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  const fact = (label, value) => (value ? `<div><span class="muted small">${label}</span><b>${esc(value)}</b></div>` : '');
  dlg.innerHTML = `<div class="form">
    <div class="dialog-head"><div><h3>${esc(chem.name)}</h3>
      <p class="muted small">${esc(CHEM_TYPES.find(([k]) => k === chem.type)?.[1] ?? '')}${chem.manufacturer ? ' · ' + esc(chem.manufacturer) : ''}</p></div>
      <span class="badge ${chem.label_checked ? 'new' : 'down'}">${chem.label_checked ? 'Checked' : 'Not checked yet'}</span></div>
    <div class="facts">
      ${fact('EPA reg. no.', chem.epa_reg_no)}${fact('Active ingredient', chem.active_ingredient)}
      ${fact('Signal word', chem.signal_word)}${fact('Re-entry (REI)', chem.rei_hours != null ? `${Number(chem.rei_hours)} hours` : '')}
      ${chem.restricted_use ? '<div><span class="muted small">Restricted use</span><b>Yes, certified applicator</b></div>' : ''}
      ${fact('Label version', chem.label_version)}${fact('Checked on', chem.label_checked_on ? fmtDate(chem.label_checked_on) + ' ' + chem.label_checked_on.slice(0, 4) : '')}
    </div>
    ${chem.chemigation ? `<p class="small"><b>Chemigation:</b> ${esc(chem.chemigation)}</p>` : ''}
    ${chem.label_notes ? `<p class="small">${esc(chem.label_notes)}</p>` : ''}
    ${chem.label_source ? `<p class="muted small">From: ${esc(chem.label_source)}</p>` : ''}

    <div class="label-file">
      ${epaLabelUrl(chem.epa_reg_no) ? `<a class="button-like primary-link" href="${esc(epaLabelUrl(chem.epa_reg_no))}" target="_blank" rel="noopener">Current label at EPA ↗</a>` : '<span class="muted small">Add the EPA reg. no. (Edit) to link EPA\'s label.</span>'}
      ${chem.label_url ? `<a class="button-like" href="${esc(chem.label_url)}" target="_blank" rel="noopener">Saved link ↗</a>` : ''}
      <a class="button-like" href="https://picol.cahnrs.wsu.edu/" target="_blank" rel="noopener">PICOL (WA/OR) ↗</a>
    </div>
    <div class="label-file">
      ${chem.label_path ? `<button type="button" class="primary" data-act="view">View label PDF</button>` : '<span class="muted">No label PDF attached.</span>'}
      <label class="button-like">${chem.label_path ? 'Replace PDF' : 'Upload label PDF'}<input type="file" accept="application/pdf" data-act="upload" hidden></label>
    </div>

    <h4>Plant-back intervals</h4>
    ${rules.length ? `<div class="table-wrap"><table class="rules">
      <thead><tr><th>Crop</th><th>Wait</th><th>Conditions</th><th>Page</th><th></th></tr></thead>
      <tbody>${[...named, ...(other ? [other] : [])].map((r) => `<tr>
        <td class="nowrap"><b>${r.crop_id ? esc(cropName(r.crop_id)) : 'All other crops'}</b></td>
        <td class="nowrap">${esc(ruleWait(r))}</td>
        <td class="small">${esc(r.conditions ?? '')}</td>
        <td class="nowrap muted small">${esc(r.label_page ?? '')}</td>
        <td class="r">${unlocked ? `<button type="button" class="small" data-rule="${r.rule_id}">Edit</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small">No plant-back intervals recorded for this product.</p>'}
    <div class="row wrap">${unlocked
      ? `<button type="button" class="small" data-act="add-rule">+ Add interval</button>
         <button type="button" class="small ghost" data-act="lock">🔒 Done editing</button>
         <span class="muted small">Every change asks you to confirm.</span>`
      : `<button type="button" class="small" data-act="unlock">🔓 Edit intervals</button>`}</div>

    <div class="actions">
      <label class="check small"><input type="checkbox" data-act="checked" ${chem.label_checked ? 'checked' : ''}> I've checked this against the label</label>
      <span class="spacer"></span>
      <button type="button" data-act="close">Close</button>
    </div></div>`;

  const reopen = async (keepUnlocked = unlocked) => { await loadRefs(); openLabelDialog(chemById(chem.chemical_id), onDone, keepUnlocked); };
  const unlock = $('[data-act=unlock]', dlg);
  if (unlock) unlock.onclick = () => {
    if (chem.label_checked && !confirm(`${chem.name} has been checked against its label. Edit its plant-back intervals anyway?`)) return;
    openLabelDialog(chem, onDone, true);
  };
  const lock = $('[data-act=lock]', dlg);
  if (lock) lock.onclick = () => openLabelDialog(chem, onDone, false);
  $('[data-act=close]', dlg).onclick = () => { dlg.close(); onDone?.(); };
  $('[data-act=checked]', dlg).onchange = async (e) => {
    if (!e.target.checked && !confirm(`Mark ${chem.name} as NOT checked against its label?`)) { e.target.checked = true; return; }
    try { await q(sb.from('chemicals').update({ label_checked: e.target.checked, label_checked_on: e.target.checked ? localDate() : null }).eq('chemical_id', chem.chemical_id)); toast(e.target.checked ? 'Marked as checked' : 'Marked as not checked'); reopen(); }
    catch { e.target.checked = !e.target.checked; }
  };
  const view = $('[data-act=view]', dlg);
  if (view) view.onclick = async () => {
    const win = window.open('', '_blank');
    const { data, error } = await sb.storage.from('labels').createSignedUrl(chem.label_path, 3600);
    if (error) { win?.close(); return toast(error.message, true); }
    if (win) win.location = data.signedUrl; else window.location.href = data.signedUrl;
  };
  $('[data-act=upload]', dlg).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast('That file is over 25 MB', true);
    const path = `${chem.chemical_id}/${file.name.replace(/[^\w.-]+/g, '_')}`;
    toast('Uploading…');
    const { error } = await sb.storage.from('labels').upload(path, file, { upsert: true, contentType: 'application/pdf' });
    if (error) return toast(error.message, true);
    try {
      await q(sb.from('chemicals').update({ label_path: path }).eq('chemical_id', chem.chemical_id));
      toast('Label uploaded');
      reopen();
    } catch { /* shown */ }
  };
  const add = $('[data-act=add-rule]', dlg);
  if (add) add.onclick = () => openRuleForm(chem, null, reopen);
  $$('[data-rule]', dlg).forEach((b) => (b.onclick = () => openRuleForm(chem, rules.find((r) => r.rule_id === Number(b.dataset.rule)), reopen)));
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

function openRuleForm(chem, rule, onDone) {
  const r = rule ?? { months: '', seasons_after: null };
  const dlg = $('#dialog');
  dlg.classList.remove('wide');
  dlg.innerHTML = `<form class="form">
    <h3>${rule ? 'Edit' : 'Add'} plant-back interval</h3>
    <p class="muted small">${esc(chem.name)}</p>
    <label>Crop<select name="crop_id"><option value="">All other crops on the label</option>
      ${refs.crops.map((c) => `<option value="${c.crop_id}" ${c.crop_id === r.crop_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <div class="row2">
      <label>Wait type<select name="kind">
        <option value="months" ${r.seasons_after == null ? 'selected' : ''}>Months after application</option>
        <option value="seasons" ${r.seasons_after != null ? 'selected' : ''}>Whole seasons later</option></select></label>
      <label id="amount-wrap">Months<input type="number" name="amount" step="0.5" min="0" required
        value="${esc(r.seasons_after != null ? r.seasons_after : r.months ?? '')}"></label>
    </div>
    <p class="muted small" id="kind-hint"></p>
    <label>Conditions<textarea name="conditions" rows="3" placeholder="Rate limits, rainfall + irrigation, pH, tillage, bioassay…">${esc(r.conditions ?? '')}</textarea></label>
    <label>Label page<input name="label_page" value="${esc(r.label_page ?? '')}" placeholder="e.g. p22"></label>
    <div class="actions">
      ${rule ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button></div></form>`;
  const form = $('form', dlg);
  const el = form.elements;
  const sync = () => {
    const seasons = el.kind.value === 'seasons';
    $('#amount-wrap', dlg).firstChild.textContent = seasons ? 'Seasons' : 'Months';
    $('#kind-hint', dlg).textContent = seasons ? '1 = not until next season, 2 = skip a season (e.g. applied 2025, earliest 2027).' : '0 = anytime.';
  };
  el.kind.onchange = sync;
  sync();
  $('[data-act=cancel]', dlg).onclick = onDone;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const n = Number(el.amount.value);
    const data = {
      chemical_id: chem.chemical_id, crop_id: el.crop_id.value ? Number(el.crop_id.value) : null,
      months: el.kind.value === 'months' ? n : null, seasons_after: el.kind.value === 'seasons' ? Math.round(n) : null,
      conditions: el.conditions.value.trim() || null, label_page: el.label_page.value.trim() || null,
    };
    const cropLabel = (id) => (id ? cropName(id) : 'All other crops');
    const describe = (x) => `${cropLabel(x.crop_id)}: ${ruleWait(x)}${x.label_page ? ` (${x.label_page})` : ''}`;
    if (rule) {
      const changed = ['crop_id', 'months', 'seasons_after', 'conditions', 'label_page']
        .some((k) => String(rule[k] ?? '') !== String(data[k] ?? '') && !(k === 'months' && Number(rule[k]) === Number(data[k])));
      if (!changed) return onDone();
      const condNote = (rule.conditions ?? '') !== (data.conditions ?? '') ? '\n\nThe conditions text also changed.' : '';
      if (!confirm(`Change this plant-back interval for ${chem.name}?\n\nBefore: ${describe(rule)}\nAfter:  ${describe(data)}${condNote}`)) return;
    } else if (!confirm(`Add this plant-back interval for ${chem.name}?\n\n${describe(data)}`)) return;
    try {
      if (rule) await q(sb.from('chemical_rotation_rules').update(data).eq('rule_id', rule.rule_id));
      else await q(sb.from('chemical_rotation_rules').insert(data));
      rotationCache.at = 0;
      onDone();
    } catch { /* shown */ }
  };
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete this plant-back interval for ${chem.name}?\n\n${rule.crop_id ? cropName(rule.crop_id) : 'All other crops'}: ${ruleWait(rule)}\n\nWarnings for this crop will fall back to the "All other crops" interval, if there is one.`)) return;
    try { await q(sb.from('chemical_rotation_rules').delete().eq('rule_id', rule.rule_id)); rotationCache.at = 0; onDone(); } catch { /* shown */ }
  };
}

// ---------- Rotation conflict check ----------
// Loads every application of a product that has rotation rules (cached for a few minutes).
const rotationCache = { at: 0, rules: [], apps: [] };
async function loadRotationData() {
  if (Date.now() - rotationCache.at < 5 * 60 * 1000) return rotationCache;
  const rules = await q(sb.from('chemical_rotation_rules').select('*'));
  const ids = [...new Set(rules.map((r) => r.chemical_id))];
  const apps = [];
  if (ids.length) {
    const since = `${new Date().getFullYear() - 5}-01-01`;
    for (let from = 0; ; from += 1000) {
      const page = await q(sb.from('chemical_event_products')
        .select('chemical_id, rate, rate_unit, rate_basis, rate_text, chemical_events!inner(field_id, applied_on, status)')
        .in('chemical_id', ids).gte('chemical_events.applied_on', since).range(from, from + 999));
      apps.push(...page);
      if (page.length < 1000) break;
    }
  }
  Object.assign(rotationCache, { at: Date.now(), rules, apps });
  return rotationCache;
}

// Fields whose chemical history affects this field: itself, its parent, and its split halves.
const relatedFieldIds = (fieldId) => {
  const f = fieldById(fieldId);
  return [fieldId, f?.parent_field_id, ...refs.fields.filter((x) => x.parent_field_id === fieldId).map((x) => x.field_id)].filter(Boolean);
};

// plantDate: 'YYYY-MM-DD' (if no planting date yet, March 1 of the season is assumed)
function rotationConflicts(data, fieldId, cropId, plantDate) {
  const out = [];
  const ids = relatedFieldIds(fieldId);
  const plant = new Date(plantDate + 'T12:00:00');
  for (const a of data.apps) {
    const ev = a.chemical_events;
    if (!ids.includes(ev.field_id) || ev.status === 'planned') continue;
    const applied = new Date(ev.applied_on + 'T12:00:00');
    if (applied > plant) continue;
    const forChem = data.rules.filter((r) => r.chemical_id === a.chemical_id);
    const rule = forChem.find((r) => r.crop_id === cropId) ?? forChem.find((r) => r.crop_id == null);
    if (!rule) continue;
    let earliest;
    if (rule.seasons_after != null) earliest = new Date(applied.getFullYear() + rule.seasons_after, 0, 1);
    else { earliest = new Date(applied); earliest.setMonth(earliest.getMonth() + Math.floor(Number(rule.months))); earliest.setDate(earliest.getDate() + Math.round((Number(rule.months) % 1) * 30)); }
    if (plant < earliest) out.push({ app: a, rule, applied: ev.applied_on, fieldId: ev.field_id, earliest: localDate(earliest) });
  }
  // keep the latest-clearing conflict per product
  const best = new Map();
  for (const c of out) { const k = c.app.chemical_id; if (!best.has(k) || c.earliest > best.get(k).earliest) best.set(k, c); }
  return [...best.values()].sort((a, b) => b.earliest.localeCompare(a.earliest));
}

function conflictHtml(list, assumedDate) {
  if (!list.length) return '';
  return `<div class="rot-warn"><b>⚠ Plant-back conflict${list.length > 1 ? 's' : ''}</b>
    ${assumedDate ? '<p class="small muted">No planting date yet, so March 1 of the season is assumed.</p>' : ''}
    <ul>${list.map((c) => {
      const chem = chemById(c.app.chemical_id);
      return `<li><b>${esc(chem?.name ?? '?')}</b> applied ${esc(fmtDate(c.applied))} ${new Date(c.applied + 'T12:00').getFullYear()}${c.fieldId !== undefined && fieldName(c.fieldId) ? ` on ${esc(fieldName(c.fieldId))}` : ''}:
        ${esc(ruleWait(c.rule))} for ${c.rule.crop_id ? esc(cropName(c.rule.crop_id)) : 'this crop'}, so not before <b>${esc(fmtDate(c.earliest))} ${c.earliest.slice(0, 4)}</b>.
        ${c.rule.conditions ? `<div class="small muted">${esc(c.rule.conditions)}${c.rule.label_page ? ` (${esc(c.rule.label_page)})` : ''}</div>` : ''}
        ${chem && !chem.label_checked ? '<div class="small muted">This product\'s label data hasn\'t been checked yet.</div>' : ''}</li>`;
    }).join('')}</ul>
    <p class="small muted">A warning only. The label is the final word, including any bioassay or rate exceptions.</p></div>`;
}

// ---------- Share a field's location ----------
function fieldPoint(f) {
  if (!f?.boundary) return null;
  const p = f.boundary.properties ?? {};
  if (p.shape === 'pivot') {
    const span = spanOf(p);
    if (span >= 360) return p.center;
    return atBearing(p, p.start + span / 2, p.radius * 0.5);   // middle of a half pivot
  }
  const ring = f.boundary.geometry.coordinates[0].slice(0, -1);
  return ring.reduce((a, x) => [a[0] + x[0] / ring.length, a[1] + x[1] / ring.length], [0, 0]);
}
async function shareFields(fields) {
  const withPts = fields.map((f) => ({ f, pt: fieldPoint(f) }));
  const missing = withPts.filter((x) => !x.pt).map((x) => x.f.name);
  const lines = withPts.filter((x) => x.pt).map(({ f, pt }) =>
    `${f.name}${f.acres != null ? ` (${num(f.acres, 0)} ac)` : ''}: https://www.google.com/maps/search/?api=1&query=${pt[1].toFixed(6)},${pt[0].toFixed(6)}`);
  if (!lines.length) return toast(`${missing.join(', ')} ${missing.length > 1 ? 'aren\'t' : 'isn\'t'} on the map yet`, true);
  const text = lines.join('\n');
  try {
    if (navigator.share) { await navigator.share({ title: lines.length > 1 ? 'Field locations' : `Field ${fields[0].name}`, text }); }
    else { await navigator.clipboard.writeText(text); toast(lines.length > 1 ? 'Links copied' : 'Link copied'); }
  } catch (e) {
    if (e?.name !== 'AbortError') { try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast('Couldn\'t share — try again', true); } }
  }
  if (missing.length) toast(`Not on the map yet: ${missing.join(', ')}`, true);
}

// =====================================================================
// Setup: reference lists
// =====================================================================
let setupTab = 'riders';
// ---- "Used for" tags: which work types a machine can do. Saved as you tap.
async function equipmentWorkTags(form, row) {
  const box = document.createElement('div');
  box.className = 'eq-work';
  form.querySelector('.actions').before(box);
  const types = refs.workTypes.filter((w) => w.active);
  if (!types.length) { box.innerHTML = ''; return; }
  if (!row) { box.innerHTML = '<p class="muted small">Save first, then pick which work it\'s used for.</p>'; return; }
  const have = new Set((await q(sb.from('equipment_work_types').select('operation').eq('equipment_id', row.equipment_id))).map((x) => x.operation));
  box.innerHTML = `<div class="lines-head"><b>Used for</b><span class="muted small">Filters the equipment list when you log work</span></div>
    <div class="chips">${types.map((w) => `<label class="chip-toggle"><input type="checkbox" value="${esc(w.operation)}" ${have.has(w.operation) ? 'checked' : ''}><span>${esc(workLabel(w.operation))}</span></label>`).join('')}</div>`;
  $$('input', box).forEach((c) => (c.onchange = async () => {
    try {
      if (c.checked) await q(sb.from('equipment_work_types').insert({ equipment_id: row.equipment_id, operation: c.value }));
      else await q(sb.from('equipment_work_types').delete().eq('equipment_id', row.equipment_id).eq('operation', c.value));
    } catch { c.checked = !c.checked; }
  }));
}

// ---- Equipment photos (private 'equipment' storage bucket)
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b ?? file), 'image/jpeg', 0.85));
  } catch { return file; }   // browser can't read it (e.g. HEIC on a PC): upload as-is
}

async function equipmentPhotos(form, row) {
  const box = document.createElement('div');
  box.className = 'eq-photos';
  form.querySelector('.actions').before(box);
  if (!row) { box.innerHTML = '<p class="muted small">Save first, then you can add photos.</p>'; return; }
  const draw = async () => {
    const photos = await q(sb.from('equipment_photos').select('*').eq('equipment_id', row.equipment_id).order('taken_at'));
    const urls = photos.length ? (await sb.storage.from('equipment').createSignedUrls(photos.map((p) => p.path), 3600)).data ?? [] : [];
    box.innerHTML = `<div class="lines-head"><b>Photos</b><span class="muted small">${photos.length ? 'Tap a photo to open it full size' : 'None yet'}</span></div>
      <div class="eq-grid">${photos.map((p, i) => `<div class="eq-thumb">
          <a href="${esc(urls[i]?.signedUrl ?? '#')}" target="_blank" rel="noopener"><img src="${esc(urls[i]?.signedUrl ?? '')}" alt="${esc(row.name)} photo"></a>
          <span class="muted small">${esc(new Date(p.taken_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
          <button type="button" class="icon" data-rm-photo="${p.photo_id}" aria-label="Delete photo">✕</button></div>`).join('')}
        <label class="eq-add"><input type="file" accept="image/*" multiple hidden><span>＋ Add photo</span></label>
      </div>
      <div class="row"><button type="button" class="small" data-act="checked">Mark checked today</button></div>`;
    $('.eq-add input', box).onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      $('.eq-add span', box).textContent = 'Uploading…';
      try {
        for (const f of files) {
          const blob = await shrinkImage(f);
          const ext = blob.type === 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() || 'img').toLowerCase();
          const path = `${row.equipment_id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
          const { error } = await sb.storage.from('equipment').upload(path, blob, { contentType: blob.type || f.type || 'application/octet-stream' });
          if (error) throw error;
          await q(sb.from('equipment_photos').insert({ equipment_id: row.equipment_id, path }));
        }
        await q(sb.from('equipment').update({ verified_on: localDate() }).eq('equipment_id', row.equipment_id));
        if (form.elements.verified_on) form.elements.verified_on.value = localDate();
        toast(files.length > 1 ? `${files.length} photos added` : 'Photo added');
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, true); }
      draw();
    };
    $('[data-act=checked]', box).onclick = async () => {
      try {
        await q(sb.from('equipment').update({ verified_on: localDate() }).eq('equipment_id', row.equipment_id));
        if (form.elements.verified_on) form.elements.verified_on.value = localDate();
        toast('Marked checked today');
      } catch { /* shown */ }
    };
    $$('[data-rm-photo]', box).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      const p = photos.find((x) => x.photo_id === Number(b.dataset.rmPhoto));
      try {
        await sb.storage.from('equipment').remove([p.path]);
        await q(sb.from('equipment_photos').delete().eq('photo_id', p.photo_id));
      } catch { /* shown */ }
      draw();
    }));
  };
  draw();
}

async function renderSetup(el) {
  const tabs = ['riders', 'turnouts', 'crops', 'operators', 'chemicals', 'equipment', 'worktypes', 'leases'];
  el.innerHTML = `<div class="subtabs">${tabs.map((t) =>
    `<button data-tab="${t}" class="${t === setupTab ? 'active' : ''}">${esc(CRUD[t].title)}</button>`).join('')}</div>
    <div id="setup-body"><p class="muted">Loading…</p></div>`;
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { setupTab = b.dataset.tab; renderSetup(el); }));
  await renderCrud(CRUD[setupTab], $('#setup-body', el));
}

// =====================================================================
// Tools: specialized calculators.
// =====================================================================
const G_PER_LB = 453.592;
let toolOpen = 'gp-cal';
const TOOLS = [
  { id: 'gp-cal', title: 'Great Plains drill calibration', blurb: 'Grams from one seed tube over 0.1 acre → lb/acre', render: renderGpCal },
  { id: 'ss-cal', title: 'Seed Spider calibration', blurb: 'Grams from one bin over a timed run → lb/acre at your speed', render: renderSsCal },
];

function renderTools(el) {
  el.innerHTML = `<div class="section-head"><h2>Tools</h2></div>
    <div class="subtabs">${TOOLS.map((t) => `<button data-tool="${t.id}" class="${t.id === toolOpen ? 'active' : ''}">${esc(t.title)}</button>`).join('')}</div>
    <div class="card tool-card" id="tool-box"></div>`;
  $$('[data-tool]', el).forEach((b) => (b.onclick = () => { toolOpen = b.dataset.tool; renderTools(el); }));
  (TOOLS.find((t) => t.id === toolOpen) ?? TOOLS[0]).render($('#tool-box', el));
}

const norm = (v) => String(v ?? '').trim().toLowerCase();
// Least-squares line through (exposed %, grams per tire turn). One distinct setting → through zero.
function calFit(pts) {
  const p = pts.filter((t) => t.x > 0 && t.y > 0);
  if (!p.length) return null;
  const xs = new Set(p.map((t) => Math.round(t.x * 100)));
  if (xs.size >= 2) {
    const n = p.length, mx = p.reduce((a, t) => a + t.x, 0) / n, my = p.reduce((a, t) => a + t.y, 0) / n;
    const sxx = p.reduce((a, t) => a + (t.x - mx) ** 2, 0), sxy = p.reduce((a, t) => a + (t.x - mx) * (t.y - my), 0);
    const b = sxy / sxx;
    if (b > 0) return { a: my - b * mx, b, line: true, n };
  }
  return { a: 0, b: p.reduce((a, t) => a + t.y, 0) / p.reduce((a, t) => a + t.x, 0), line: false, n: p.length };
}

async function renderGpCal(box) {
  box.innerHTML = '<p class="muted">Loading…</p>';
  let tests = [], noTable = false;
  const loadTests = async () => {
    const r = await sb.from('planter_cal_tests').select('*').order('created_at', { ascending: false }).limit(1000);
    noTable = !!r.error; tests = (r.data ?? []).filter((t) => (t.calc_type ?? 'great_plains') === 'great_plains');
  };
  await loadTests();
  const drills = refs.equipment.filter((e) => e.active !== false && /great plains/i.test(`${e.make ?? ''} ${e.name ?? ''}`));
  let st = { spacing: 12, target: '', tubes: [''], acre: 0.1, turns: 28.3, box: 'Large', full: { Large: '', Small: '' }, mm: { Large: '', Small: '' },
    drill: drills.length === 1 ? drills[0].equipment_id : '', crop: '', variety: '', lot: '' };
  try { const saved = JSON.parse(localStorage.getItem('gp-cal2') || '{}'); st = { ...st, ...saved }; } catch { /* storage unavailable */ }
  if (Number(st.turns) === 24.33 && Number(st.acre) === 0.1) st.turns = 28.3; // corrected figure
  const units = () => (Number(st.spacing) === 6 ? 40 : 20);
  const save = () => { try { localStorage.setItem('gp-cal2', JSON.stringify(st)); } catch { /* ignore */ } };
  const sameSeed = (t, level) => t.crop_id === Number(st.crop) && (level === 'crop' || norm(t.variety) === norm(st.variety)) && (level !== 'lot' || norm(t.seed_lot) === norm(st.lot));
  const sameRig = (t) => (!st.drill || t.equipment_id === Number(st.drill)) && t.seed_box === st.box;
  const fullMm = () => {
    if (Number(st.full[st.box]) > 0) return Number(st.full[st.box]);
    const t = tests.find((x) => sameRig(x) && x.full_mm > 0);
    return t ? Number(t.full_mm) : 0;
  };
  const daysAgo = (d) => (Date.now() - new Date(d + 'T12:00').getTime()) / 864e5;
  const fmtMm = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const draw = () => {
    const turnsWhole = Math.floor(st.turns);
    const frac = st.turns - turnsWhole;
    const full = fullMm();
    const varieties = [...new Set(tests.filter((t) => t.crop_id === Number(st.crop) && t.variety).map((t) => t.variety))];
    box.innerHTML = `
      <h3>Great Plains drill calibration</h3>
      ${noTable ? '<p class="form-hint">Tests can’t be saved yet. Run <b>planter_cal_tests.sql</b> in Supabase to turn on the test log. The calculator still works.</p>' : ''}
      <div class="cal-grid">
        <div class="cal-inputs">
          <label>Drill<select data-f="drill"><option value="">—</option>${(drills.length ? drills : refs.equipment.filter((e) => doesWork(e, 'planting'))).map((e) => `<option value="${e.equipment_id}" ${Number(st.drill) === e.equipment_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          <div class="row2">
            <label>Crop<select data-f="crop"><option value="">—</option>${refs.crops.filter((c) => c.active !== false || c.crop_id === Number(st.crop)).map((c) => `<option value="${c.crop_id}" ${Number(st.crop) === c.crop_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
            <label>Variety<input data-f="variety" list="cal-varieties" value="${esc(st.variety)}"><datalist id="cal-varieties">${varieties.map((v) => `<option value="${esc(v)}">`).join('')}</datalist></label>
          </div>
          <label>Seed lot <span class="muted small">(optional)</span><input data-f="lot" value="${esc(st.lot)}"></label>
          <div class="seg" role="group" aria-label="Row spacing">
            <button type="button" data-sp="12" class="${Number(st.spacing) === 12 ? 'on' : ''}">12" spacing<small>20 units</small></button>
            <button type="button" data-sp="6" class="${Number(st.spacing) === 6 ? 'on' : ''}">6" spacing<small>40 units</small></button>
          </div>
          <div class="seg" role="group" aria-label="Seed box">
            <button type="button" data-box="Large" class="${st.box === 'Large' ? 'on' : ''}">Large seed box</button>
            <button type="button" data-box="Small" class="${st.box === 'Small' ? 'on' : ''}">Small seed box</button>
          </div>
          <div class="row2">
            <label>Fully open (mm)<input type="number" inputmode="decimal" step="any" min="0" data-mm="full" value="${esc(full || '')}"></label>
            <label>Exposed now (mm)<input type="number" inputmode="decimal" step="any" min="0" data-mm="cur" value="${esc(st.mm[st.box] ?? '')}"></label>
          </div>
          <div class="muted small" id="cal-pct"></div>
          <label>Target rate (lb/acre)<input type="number" inputmode="decimal" step="any" min="0" data-k="target" value="${esc(st.target)}"></label>
          <div class="cal-turns">Turn the drive tire <b>${st.turns} revolutions</b> <span class="muted small">(${st.acre} acre)</span></div>
          <div class="lines-head"><b>Seed caught (grams)</b><span class="muted small">One tube; add more to average them</span></div>
          ${st.tubes.map((g, i) => `<div class="tube-row"><label>Tube ${i + 1}<input type="number" inputmode="decimal" step="any" min="0" data-tube="${i}" value="${esc(g)}"></label>
            ${st.tubes.length > 1 ? `<button type="button" class="icon" data-rm-tube="${i}" aria-label="Remove tube">✕</button>` : ''}</div>`).join('')}
          <button type="button" class="small" data-act="add-tube">+ Another tube</button>
          <details class="cal-adv"><summary>Test distance</summary>
            <div class="row2"><label>Area per test (acres)<input type="number" step="any" min="0" data-k="acre" value="${esc(st.acre)}"></label>
            <label>Drive tire turns for that area<input type="number" step="any" min="0" data-k="turns" value="${esc(st.turns)}"></label></div>
          </details>
          <button type="button" class="ghost small" data-act="clear">Clear grams and target</button>
        </div>
        <div class="cal-out" id="cal-out"></div>
      </div>
      <div class="cal-steps"><h4>How to run the test</h4><ol>
        <li>Set the drill to <b>${Number(st.spacing)}" spacing</b> (${units()} units running). Measure the exposed seed cup on side 1 with calipers and enter it as <b>Exposed now</b>. Measure a fully open cup once per box and enter it as <b>Fully open</b>.</li>
        <li>Put a catch bag or cup on <b>one seed tube</b>.</li>
        <li>Mark the drive tire, then turn it <b>${st.turns} revolutions</b>: ${turnsWhole} full turns${frac > 0.01 ? ` plus <b>${Math.round(frac * 100) / 100} of a turn</b> (about ${Math.round(frac * 360)}° — roughly ${Math.abs(frac - 1 / 3) < 0.03 ? 'a third' : Math.abs(frac - 0.5) < 0.03 ? 'half' : Math.abs(frac - 0.25) < 0.03 ? 'a quarter' : Math.abs(frac - 0.75) < 0.03 ? 'three quarters' : Math.round(frac * 8) + '/8'} of a turn)` : ''}. That's ${st.acre} acre of travel.</li>
        <li>Weigh the seed in <b>grams</b> and enter it. Catch more tubes and enter each for a better average.</li>
        <li>Tap <b>Save test</b>, set side 1 to the suggested measurement, and test again. Each saved test sharpens the next suggestion.</li>
        <li>When it's on target, match side 2 to the same caliper measurement.</li>
      </ol></div>
      <div id="cal-log"></div>`;
    drawLog();
    calc();
    wire();
  };

  const drawLog = () => {
    const el = $('#cal-log', box);
    if (noTable) { el.innerHTML = ''; return; }
    const mine = st.crop ? tests.filter((t) => sameSeed(t, 'variety')) : tests;
    const rows = mine.slice(0, 15);
    el.innerHTML = `<div class="cal-steps"><h4>${st.crop ? `Saved tests: ${esc(cropName(Number(st.crop)))}${st.variety ? ' ' + esc(st.variety) : ''}` : 'Recent saved tests'}</h4>
      ${rows.length ? `<div class="table-wrap"><table class="cal-log"><thead><tr><th>Date</th><th>Box</th><th>Spacing</th><th>Exposed</th><th>Caught</th><th>Rate</th><th>Target</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td>${esc(t.tested_on)}</td><td>${esc(t.seed_box ?? '')}</td><td>${t.spacing_in ?? ''}"</td>
        <td>${t.exposed_mm ?? '—'} mm${t.exposed_pct != null ? ` <span class="muted">(${Number(t.exposed_pct).toFixed(1)}%)</span>` : ''}</td>
        <td>${t.grams_avg ?? ''} g</td><td><b>${t.actual_lb_ac ?? ''}</b></td><td>${t.target_lb_ac ?? ''}</td>
        <td><button type="button" class="icon" data-del-test="${t.test_id}" aria-label="Delete test">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small">None yet.</p>'}</div>`;
    $$('[data-del-test]', el).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this test?')) return;
      await q(sb.from('planter_cal_tests').delete().eq('test_id', Number(b.dataset.delTest)));
      await loadTests(); drawLog(); calc();
    }));
  };

  let pending = null; // what Save would write
  const calc = () => {
    const tgt = Number(st.target);
    const full = fullMm();
    const cur = Number(st.mm[st.box]);
    const pct = full > 0 && cur >= 0 && st.mm[st.box] !== '' ? (cur / full) * 100 : null;
    $('#cal-pct', box).innerHTML = pct != null ? `Side 1 is <b>${pct.toFixed(1)}%</b> open${cur > full ? ' — <b>more than fully open; check the readings</b>' : ''}` : (full ? '' : 'Measure a fully open cup once for this box.');
    const grams = st.tubes.map(Number).filter((g) => g > 0);
    const avg = grams.length ? grams.reduce((a, b) => a + b, 0) / grams.length : null;
    const expected = tgt > 0 ? (tgt * st.acre * G_PER_LB) / units() : null;
    const actual = avg != null && st.acre > 0 ? (avg * units()) / G_PER_LB / st.acre : null;
    const diff = actual != null && tgt > 0 ? ((actual - tgt) / tgt) * 100 : null;
    const tone = diff == null ? '' : Math.abs(diff) <= 3 ? 'ok' : Math.abs(diff) <= 10 ? 'warn' : 'bad';

    // Points for the fit: this seed + drill + box, saved in the last 14 days, plus the reading on screen.
    const recent = st.crop ? tests.filter((t) => sameSeed(t, 'variety') && sameRig(t) && daysAgo(t.tested_on) <= 14 && t.exposed_pct > 0 && t.grams_avg > 0 && t.turns > 0) : [];
    const pts = recent.map((t) => ({ x: Number(t.exposed_pct), y: Number(t.grams_avg) / Number(t.turns) }));
    if (pct > 0 && avg) pts.push({ x: pct, y: avg / st.turns });
    let fit = calFit(pts), how = '';
    if (fit) {
      how = fit.line ? `Line through ${fit.n} tests of this seed on this box (last 14 days).`
        : fit.n === 1 ? 'Assumes 0 mm exposed drops no seed, so seed is proportional to exposure. Save this test and the next one will use both.'
        : 'Proportional to exposure, from tests at this setting.';
    } else if (st.crop && expected) {
      // Starting point from older history: same lot, then same variety, then same crop.
      for (const [level, label] of [['lot', 'this seed lot'], ['variety', 'this variety'], ['crop', 'this crop (other varieties — rough only)']]) {
        if (level === 'lot' && !st.lot) continue;
        if (level !== 'crop' && !st.variety) continue;
        const h = tests.filter((t) => sameSeed(t, level) && t.seed_box === st.box && t.exposed_pct > 0 && t.grams_avg > 0 && t.turns > 0);
        if (!h.length) continue;
        const ks = h.map((t) => Number(t.grams_avg) / Number(t.turns) / Number(t.exposed_pct)).sort((a, b) => a - b);
        fit = { a: 0, b: ks[Math.floor(ks.length / 2)], start: true };
        how = `Starting point from ${h.length} past test${h.length > 1 ? 's' : ''} of ${label}, last on ${h[0].tested_on}. Run a test to confirm.`;
        break;
      }
    }
    let sugg = null;
    if (fit && expected) {
      const sPct = (expected / st.turns - fit.a) / fit.b;
      sugg = { pct: sPct, mm: full > 0 ? (sPct / 100) * full : null };
    }
    const close = diff != null && Math.abs(diff) <= 3;
    pending = actual != null && pct != null ? { avg, actual, pct, full, cur, grams, tgt, nextMm: !close && sugg?.mm != null && sugg.pct >= 0 && sugg.pct <= 100 ? Math.round(sugg.mm * 10) / 10 : null } : null;

    const suggCard = !sugg ? (expected && !st.crop ? '<p class="muted small">Pick the crop (and variety) to get a suggested setting and use past tests.</p>'
        : expected && !(full > 0) ? '<p class="muted small">Enter the fully open measurement to get a suggested setting in mm.</p>' : '')
      : `<div class="cal-stat ${close ? 'ok' : ''}"><span class="stat-label">${fit.start ? 'Suggested starting setting' : 'Suggested setting'} · ${st.box} box</span>
          <span class="cal-settings">${pct != null && !fit.start && !close ? `<span>Now <b>${fmtMm(cur)} mm</b></span><span class="cal-arrow">→</span>` : ''}
          <span><b class="stat-value">${close ? fmtMm(cur) : sugg.mm != null ? fmtMm(sugg.mm) : '—'}</b> mm</span>
          <span class="muted">${(close ? pct : sugg.pct).toFixed(1)}% open</span></span>
          <span class="muted small">${close ? 'Within 3% of target. Leave it here and set side 2 to the same measurement.' : how}${sugg.pct > 100 || sugg.pct < 0 ? ' <b>That is past fully open/closed. Check the spacing, box, or readings.</b>' : ''}</span></div>`;

    $('#cal-out', box).innerHTML = `
      <div class="cal-stat"><span class="stat-label">Target per tube</span><span class="stat-value">${expected != null ? expected.toFixed(1) : '—'}<small> g</small></span>
        <span class="muted small">What one tube should catch at ${tgt > 0 ? tgt : '—'} lb/ac</span></div>
      <div class="cal-stat ${tone}"><span class="stat-label">Actual rate${grams.length > 1 ? ` (avg of ${grams.length} tubes)` : ''}</span><span class="stat-value">${actual != null ? actual.toFixed(1) : '—'}<small> lb/ac</small></span>
        ${diff != null ? `<span class="cal-diff">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% ${diff >= 0 ? 'over' : 'under'} target${close ? ' · close enough' : ''}</span>` : '<span class="muted small">Enter grams caught</span>'}</div>
      ${suggCard}
      ${pending && !noTable ? `<button type="button" class="primary" data-act="save-test" ${st.crop ? '' : 'disabled'}>Save test${pending.nextMm != null ? ` and set to ${fmtMm(pending.nextMm)} mm` : ''}</button>${st.crop ? '' : '<span class="muted small">Pick a crop to save.</span>'}` : ''}`;
    const sv = $('[data-act=save-test]', box);
    if (sv) sv.onclick = async () => {
      const p = pending; sv.disabled = true;
      const row = { equipment_id: st.drill ? Number(st.drill) : null, seed_box: st.box, spacing_in: Number(st.spacing), units: units(),
        crop_id: Number(st.crop), variety: st.variety.trim() || null, seed_lot: st.lot.trim() || null, target_lb_ac: p.tgt || null,
        full_mm: p.full, exposed_mm: p.cur, exposed_pct: Math.round(p.pct * 100) / 100, acre: st.acre, turns: st.turns,
        grams: p.grams, grams_avg: Math.round(p.avg * 100) / 100, actual_lb_ac: Math.round(p.actual * 100) / 100, tested_on: localDate() };
      try { await q(sb.from('planter_cal_tests').insert(row)); } catch { sv.disabled = false; return; }
      toast('Test saved');
      if (p.nextMm != null) st.mm[st.box] = String(p.nextMm);
      st.tubes = ['']; save();
      await loadTests(); draw();
    };
  };

  const wire = () => {
    $$('[data-f]', box).forEach((i) => (i.onchange = i.oninput = () => {
      st[i.dataset.f] = i.value; save();
      if (i.tagName === 'SELECT') draw(); else { drawLog(); calc(); }
    }));
    $$('[data-mm]', box).forEach((i) => (i.oninput = () => {
      if (i.dataset.mm === 'full') st.full[st.box] = i.value; else st.mm[st.box] = i.value;
      save(); calc();
    }));
    $$('[data-k]', box).forEach((i) => (i.oninput = () => { st[i.dataset.k] = i.dataset.k === 'target' ? i.value : Number(i.value) || 0; save(); if (i.dataset.k === 'target') calc(); }));
    $$('[data-k=acre], [data-k=turns]', box).forEach((i) => (i.onchange = () => draw()));
    $$('[data-tube]', box).forEach((i) => (i.oninput = () => { st.tubes[Number(i.dataset.tube)] = i.value; save(); calc(); }));
    $$('[data-sp]', box).forEach((b) => (b.onclick = () => { st.spacing = Number(b.dataset.sp); save(); draw(); }));
    $$('[data-box]', box).forEach((b) => (b.onclick = () => { st.box = b.dataset.box; save(); draw(); }));
    $$('[data-rm-tube]', box).forEach((b) => (b.onclick = () => { st.tubes.splice(Number(b.dataset.rmTube), 1); save(); draw(); }));
    $('[data-act=add-tube]', box).onclick = () => { st.tubes.push(''); save(); draw(); $$('[data-tube]', box).at(-1)?.focus(); };
    $('[data-act=clear]', box).onclick = () => { st.target = ''; st.tubes = ['']; save(); draw(); };
  };
  draw();
}

// Seed Spider: 4 bins, each feeding 2 rows; controller sets bin RPM. Catch seed for a timed run, standing still.
async function renderSsCal(box) {
  box.innerHTML = '<p class="muted">Loading…</p>';
  let tests = [], noTable = false, noCols = false;
  const loadTests = async () => {
    const r = await sb.from('planter_cal_tests').select('*').eq('calc_type', 'seed_spider').order('created_at', { ascending: false }).limit(1000);
    if (r.error) {
      const t = await sb.from('planter_cal_tests').select('test_id').limit(1);
      noTable = !!t.error; noCols = !t.error; tests = [];
    } else { noTable = noCols = false; tests = r.data ?? []; }
  };
  await loadTests();
  const rigs = refs.equipment.filter((e) => e.active !== false && /seed ?spider/i.test(`${e.make ?? ''} ${e.name ?? ''} ${e.model ?? ''}`));
  let st = { rows: 8, spacing: 22, sec: 60, speed: '', rpm: '', target: '', rowG: Array(8).fill(''), sponge: '',
    drill: rigs.length === 1 ? rigs[0].equipment_id : '', crop: '', variety: '', lot: '' };
  try { st = { ...st, ...JSON.parse(localStorage.getItem('ss-cal') || '{}') }; } catch { /* storage unavailable */ }
  if (!Array.isArray(st.rowG) || st.rowG.length !== 8) st.rowG = Array(8).fill('');
  // Stopwatch: survives redraws; Stop writes the measured time into the catch time.
  const tm = (renderSsCal.timer ??= { start: null, beeped: false, iv: null, ac: null });
  const save = () => { try { localStorage.setItem('ss-cal', JSON.stringify(st)); } catch { /* ignore */ } };
  const RPM_MIN = 0.3, RPM_MAX = 32;
  const sameSeed = (t, level) => t.crop_id === Number(st.crop) && (level === 'crop' || norm(t.variety) === norm(st.variety)) && (level !== 'lot' || norm(t.seed_lot) === norm(st.lot));
  const sameSponge = (t) => norm(t.sponge_set) === norm(st.sponge);
  const daysAgo = (d) => (Date.now() - new Date(d + 'T12:00').getTime()) / 864e5;
  // Acres one row covers per minute at a speed (mph × 88 = ft/min).
  const acPerRowMin = (mph) => (mph * 88 * (Number(st.spacing) / 12)) / 43560;
  const fmtRpm = (v) => (Math.round(v * 10) / 10).toFixed(1);

  const draw = () => {
    const varieties = [...new Set(tests.filter((t) => t.crop_id === Number(st.crop) && t.variety).map((t) => t.variety))];
    const sponges = [...new Set(tests.map((t) => t.sponge_set).filter(Boolean))];
    box.innerHTML = `
      <h3>Seed Spider calibration</h3>
      ${noTable ? '<p class="form-hint">Tests can’t be saved yet. Run <b>planter_cal_tests.sql</b> and then <b>seed_spider_cal.sql</b> in Supabase. The calculator still works.</p>'
        : noCols ? '<p class="form-hint">Tests can’t be saved yet. Run <b>seed_spider_cal.sql</b> in Supabase. The calculator still works.</p>' : ''}
      <div class="cal-grid">
        <div class="cal-inputs">
          <label>Planter<select data-f="drill"><option value="">—</option>${(rigs.length ? rigs : refs.equipment.filter((e) => doesWork(e, 'planting'))).map((e) => `<option value="${e.equipment_id}" ${Number(st.drill) === e.equipment_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          <div class="row2">
            <label>Crop<select data-f="crop"><option value="">—</option>${refs.crops.filter((c) => c.active !== false || c.crop_id === Number(st.crop)).map((c) => `<option value="${c.crop_id}" ${Number(st.crop) === c.crop_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
            <label>Variety<input data-f="variety" list="ss-varieties" value="${esc(st.variety)}"><datalist id="ss-varieties">${varieties.map((v) => `<option value="${esc(v)}">`).join('')}</datalist></label>
          </div>
          <div class="row2">
            <label>Seed lot <span class="muted small">(optional)</span><input data-f="lot" value="${esc(st.lot)}"></label>
            <label>Sponge set<input data-f="sponge" list="ss-sponges" value="${esc(st.sponge)}"><datalist id="ss-sponges">${sponges.map((v) => `<option value="${esc(v)}">`).join('')}</datalist></label>
          </div>
          <div class="row2">
            <label>Planting speed (mph)<input type="number" inputmode="decimal" step="any" min="0" data-k="speed" value="${esc(st.speed)}"></label>
            <label>Target rate (lb/acre)<input type="number" inputmode="decimal" step="any" min="0" data-k="target" value="${esc(st.target)}"></label>
          </div>
          <div class="row2">
            <label>Controller RPM now<input type="number" inputmode="decimal" step="any" min="0" data-k="rpm" value="${esc(st.rpm)}"></label>
            <label>Catch time (seconds)<input type="number" inputmode="decimal" step="any" min="1" data-k="sec" value="${esc(st.sec)}"></label>
          </div>
          <div class="cal-timer" id="ss-timer">
            <div class="cal-clock"><span id="ss-clock">0:00.0</span><span class="muted small" id="ss-clock-sub">target ${st.sec || '—'} s</span></div>
            <div class="cal-timer-btns"><button type="button" class="primary" data-tm="start">Start</button><button type="button" data-tm="stop">Stop</button><button type="button" class="ghost" data-tm="reset">Reset</button></div>
          </div>
          <div class="cal-turns" id="ss-run"></div>
          <div class="lines-head"><b>Seed caught (grams)</b><span class="muted small">One bag per row; leave blank any row you didn't catch</span></div>
          <div class="ss-rows">${st.rowG.map((g, i) => `<label class="${i % 2 ? 'bin-b' : 'bin-a'}">Row ${i + 1}<small>bin ${Math.floor(i / 2) + 1}</small><input type="number" inputmode="decimal" step="any" min="0" data-row="${i}" value="${esc(g)}"></label>`).join('')}</div>
          <details class="cal-adv"><summary>Planter setup</summary>
            <div class="row2"><label>Row spacing (in)<input type="number" step="any" min="0" data-k="spacing" value="${esc(st.spacing)}"></label></div>
          </details>
          <button type="button" class="ghost small" data-act="clear">Clear grams and target</button>
        </div>
        <div class="cal-out" id="cal-out"></div>
      </div>
      <div class="cal-steps"><h4>How to run the test</h4><ol>
        <li>Put a catch bag on <b>every seed tube</b> (or just the rows you want to check).</li>
        <li>Set the controller to the RPM you want to check and enter it above.</li>
        <li>Turn the meters on. When seed starts falling, tap <b>Start</b>. At about <b>${st.sec} seconds</b> the phone buzzes and beeps. Turn the meters off, and tap <b>Stop</b> when seed stops falling. The measured time is used for the math.</li>
        <li>Weigh each bag in <b>grams</b> and enter it by row.</li>
        <li>Tap <b>Save test</b>, set the controller to the suggested RPM, and test again. Each saved test sharpens the suggestion.</li>
        <li>The RPM is set from the average of every row you caught. Rows or pairs flagged as off can't be fixed with RPM, since one setting drives them all. Check that row's sponge, tube and drop, or that bin's feeder.</li>
        <li>In the field, hold the speed you entered. The RPM is fixed, so faster means less seed and slower means more.</li>
      </ol></div>
      <div id="cal-log"></div>`;
    drawLog(); calc(); wire();
  };

  const drawLog = () => {
    const el = $('#cal-log', box);
    if (noTable || noCols) { el.innerHTML = ''; return; }
    const rows = (st.crop ? tests.filter((t) => sameSeed(t, 'variety')) : tests).slice(0, 15);
    el.innerHTML = `<div class="cal-steps"><h4>${st.crop ? `Saved tests: ${esc(cropName(Number(st.crop)))}${st.variety ? ' ' + esc(st.variety) : ''}` : 'Recent saved tests'}</h4>
      ${rows.length ? `<div class="table-wrap"><table class="cal-log"><thead><tr><th>Date</th><th>Rows</th><th>Sponge</th><th>RPM</th><th>Avg per row</th><th>Rate</th><th>Target</th><th></th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td>${esc(t.tested_on)}</td><td>${(t.grams ?? []).filter((g) => g != null).length || (t.bin ? `bin ${t.bin}` : '')}</td><td>${esc(t.sponge_set ?? '')}</td><td>${t.rpm ?? ''}</td>
        <td>${t.grams_avg != null ? Math.round(t.grams_avg / (t.rows_caught || 1) * 10) / 10 : ''} g / ${t.catch_sec ?? ''} s</td><td><b>${t.actual_lb_ac ?? ''}</b> <span class="muted">@ ${t.speed_mph ?? ''} mph</span></td><td>${t.target_lb_ac ?? ''}</td>
        <td><button type="button" class="icon" data-del-test="${t.test_id}" aria-label="Delete test">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small">None yet.</p>'}</div>`;
    $$('[data-del-test]', el).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this test?')) return;
      await q(sb.from('planter_cal_tests').delete().eq('test_id', Number(b.dataset.delTest)));
      await loadTests(); drawLog(); calc();
    }));
  };

  let pending = null;
  const calc = () => {
    const tgt = Number(st.target), mph = Number(st.speed), rpm = Number(st.rpm), sec = Number(st.sec), n = 1;
    const acr = mph > 0 ? acPerRowMin(mph) : 0;
    const rowsIn = st.rowG.map((g, i) => ({ row: i + 1, bin: Math.floor(i / 2) + 1, g: Number(g) })).filter((r) => r.g > 0);
    const grams = rowsIn.map((r) => r.g);
    const avg = grams.length ? grams.reduce((a, b) => a + b, 0) / grams.length : null; // per row
    const perRowMin = avg != null && sec > 0 ? avg / (sec / 60) : null;                    // g per row per minute
    const rateOf = (g) => (sec > 0 && acr ? g / (sec / 60) / acr / G_PER_LB : null);
    const targetPerRowMin = tgt > 0 && acr ? tgt * acr * G_PER_LB : null;
    const expected = targetPerRowMin != null && sec > 0 ? targetPerRowMin * n * (sec / 60) : null;
    const actual = perRowMin != null && acr ? perRowMin / acr / G_PER_LB : null;
    const diff = actual != null && tgt > 0 ? ((actual - tgt) / tgt) * 100 : null;
    const tone = diff == null ? '' : Math.abs(diff) <= 3 ? 'ok' : Math.abs(diff) <= 10 ? 'warn' : 'bad';
    $('#ss-run', box).innerHTML = `Run the meters for about <b>${sec || '—'} seconds</b> at <b>${rpm > 0 ? rpm : '—'} RPM</b>${rpm && (rpm < RPM_MIN || rpm > RPM_MAX) ? ` <b>(outside ${RPM_MIN}–${RPM_MAX})</b>` : ''}`;

    // Fit grams per row-minute against RPM. Speed doesn't matter here, so tests at any speed count.
    const recent = st.crop ? tests.filter((t) => sameSeed(t, 'variety') && sameSponge(t) && (!st.drill || t.equipment_id === Number(st.drill))
      && daysAgo(t.tested_on) <= 14 && t.rpm > 0 && t.grams_avg > 0 && t.catch_sec > 0) : [];
    const pts = recent.map((t) => ({ x: Number(t.rpm), y: Number(t.grams_avg) / (Number(t.rows_caught) || 2) / (Number(t.catch_sec) / 60) }));
    if (rpm > 0 && perRowMin) pts.push({ x: rpm, y: perRowMin });
    let fit = calFit(pts), how = '';
    if (fit) {
      how = fit.line ? `Line through ${fit.n} tests of this seed${st.sponge ? ` with ${esc(st.sponge)} sponges` : ''} (last 14 days).`
        : fit.n === 1 ? 'Assumes seed is proportional to RPM. Save this test and the next one will use both.' : 'Proportional to RPM, from tests at this RPM.';
    } else if (st.crop) {
      for (const [level, label] of [['lot', 'this seed lot'], ['variety', 'this variety'], ['crop', 'this crop (other varieties — rough only)']]) {
        if (level === 'lot' && !st.lot) continue;
        if (level !== 'crop' && !st.variety) continue;
        const h = tests.filter((t) => sameSeed(t, level) && t.rpm > 0 && t.grams_avg > 0 && t.catch_sec > 0);
        if (!h.length) continue;
        const ks = h.map((t) => Number(t.grams_avg) / (Number(t.rows_caught) || 2) / (Number(t.catch_sec) / 60) / Number(t.rpm)).sort((a, b) => a - b);
        fit = { a: 0, b: ks[Math.floor(ks.length / 2)], start: true };
        const sp = [...new Set(h.map((t) => t.sponge_set).filter(Boolean))];
        how = `Starting point from ${h.length} past test${h.length > 1 ? 's' : ''} of ${label}${sp.length ? ` (sponges: ${sp.map(esc).join(', ')})` : ''}, last on ${h[0].tested_on}. Run a test to confirm.`;
        break;
      }
    }
    const rpmFor = (m) => (fit && tgt > 0 && m > 0 ? (tgt * acPerRowMin(m) * G_PER_LB - fit.a) / fit.b : null);
    const sugg = rpmFor(mph);
    const close = diff != null && Math.abs(diff) <= 3;
    const okRange = (r) => r != null && r >= RPM_MIN && r <= RPM_MAX;
    pending = actual != null && rpm > 0 ? { avg, actual, grams, tgt, nextRpm: !close && okRange(sugg) ? Math.round(sugg * 10) / 10 : null } : null;
    // Each row vs the average; each bin's own RPM if the controller can set bins separately.
    const rowTable = () => {
      if (rowsIn.length < 2 || !avg) return '';
      const bins = [1, 2, 3, 4].map((b) => { const r = rowsIn.filter((x) => x.bin === b); return r.length ? { b, n: r.length, rows: r.map((x) => x.row).join(), avg: r.reduce((a, x) => a + x.g, 0) / r.length } : null; }).filter(Boolean);
      return `<div class="cal-stat"><span class="stat-label">By row (vs the average of ${rowsIn.length} rows)</span>
        <table class="cal-rows"><thead><tr><th>Row</th><th>g</th><th>lb/ac</th><th>vs avg</th></tr></thead><tbody>
        ${rowsIn.map((r) => { const d = (r.g / avg - 1) * 100, rt = rateOf(r.g); return `<tr class="${Math.abs(d) > 5 ? 'off' : ''}"><td>${r.row} <span class="muted">bin ${r.bin}</span></td><td>${r.g}</td><td>${rt != null ? rt.toFixed(1) : '—'}</td><td>${d >= 0 ? '+' : ''}${d.toFixed(1)}%${Math.abs(d) > 5 ? ' ⚠' : ''}</td></tr>`; }).join('')}
        </tbody></table>
        ${rowsIn.some((r) => Math.abs(r.g / avg - 1) > 0.05) ? '<span class="muted small">⚠ More than 5% off the other rows. Check that row’s sponge, tube and drop; the one RPM setting moves every row together.</span>' : ''}
        ${bins.length > 1 ? `<span class="stat-label" style="margin-top:.4rem">By pair (bin) vs the average</span>
        <table class="cal-rows"><thead><tr><th>Bin</th><th>Rows</th><th>Avg g</th><th>vs avg</th></tr></thead><tbody>
        ${bins.map((x) => { const d = (x.avg / avg - 1) * 100; return `<tr class="${Math.abs(d) > 5 ? 'off' : ''}"><td>${x.b}</td><td>${x.n === 2 ? `${x.b * 2 - 1}–${x.b * 2}` : x.rows}</td><td>${x.avg.toFixed(1)}</td><td>${d >= 0 ? '+' : ''}${d.toFixed(1)}%${Math.abs(d) > 5 ? ' ⚠' : ''}</td></tr>`; }).join('')}
        </tbody></table>
        ${bins.some((x) => Math.abs(x.avg / avg - 1) > 0.05) ? '<span class="muted small">⚠ A whole pair off together points at that bin (feeder, sponge set, drive) rather than one row’s tube.</span>' : ''}` : ''}</div>`;
    };
    const speeds = mph > 0 && fit && tgt > 0 ? [-1, -0.5, 0, 0.5, 1].map((d) => mph + d).filter((m) => m > 0) : [];

    const suggCard = sugg == null ? (tgt > 0 && !(mph > 0) ? '<p class="muted small">Enter the planting speed. Without a drive wheel, the rate depends on it.</p>'
        : tgt > 0 && !st.crop ? '<p class="muted small">Pick the crop (and variety) to get a suggested RPM and use past tests.</p>' : '')
      : `<div class="cal-stat ${close ? 'ok' : ''}"><span class="stat-label">${fit.start ? 'Suggested starting RPM' : 'Suggested RPM'} · averaged over ${rowsIn.length || 'all'} rows at ${mph} mph</span>
          <span class="cal-settings">${rpm > 0 && !fit.start && !close ? `<span>Now <b>${fmtRpm(rpm)}</b></span><span class="cal-arrow">→</span>` : ''}
          <span><b class="stat-value">${close ? fmtRpm(rpm) : fmtRpm(sugg)}</b> RPM</span></span>
          <span class="muted small">${close ? 'Within 3% of target. Leave it here.' : how}${!okRange(sugg) ? ` <b>That's outside the controller's ${RPM_MIN}–${RPM_MAX} RPM range. Change the sponge set or the speed.</b>` : ''}</span>
          ${speeds.length ? `<table class="cal-speeds"><thead><tr><th>Speed</th>${speeds.map((m) => `<th class="${m === mph ? 'on' : ''}">${m} mph</th>`).join('')}</tr></thead>
            <tbody><tr><td>RPM</td>${speeds.map((m) => { const r = close && rpmFor(mph) ? rpmFor(m) * (rpm / rpmFor(mph)) : rpmFor(m); return `<td class="${m === mph ? 'on' : ''}">${r != null && r > 0 ? fmtRpm(r) : '—'}</td>`; }).join('')}</tr></tbody></table>` : ''}</div>`;

    $('#cal-out', box).innerHTML = `
      <div class="cal-stat"><span class="stat-label">Target catch</span><span class="stat-value">${expected != null ? expected.toFixed(1) : '—'}<small> g</small></span>
        <span class="muted small">Per row for ${sec || '—'} s at ${tgt > 0 ? tgt : '—'} lb/ac and ${mph > 0 ? mph : '—'} mph</span></div>
      <div class="cal-stat ${tone}"><span class="stat-label">Actual rate at ${mph > 0 ? mph : '—'} mph${grams.length > 1 ? ` (avg of ${grams.length} rows)` : ''}</span><span class="stat-value">${actual != null ? actual.toFixed(1) : '—'}<small> lb/ac</small></span>
        ${diff != null ? `<span class="cal-diff">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}% ${diff >= 0 ? 'over' : 'under'} target${close ? ' · close enough' : ''}</span>` : `<span class="muted small">${mph > 0 ? 'Enter grams caught' : 'Enter speed and grams caught'}</span>`}</div>
      ${suggCard}
      ${rowTable()}
      ${pending && !noTable && !noCols ? `<button type="button" class="primary" data-act="save-test" ${st.crop ? '' : 'disabled'}>Save test${pending.nextRpm != null ? ` and set to ${fmtRpm(pending.nextRpm)} RPM` : ''}</button>${st.crop ? '' : '<span class="muted small">Pick a crop to save.</span>'}` : ''}`;
    const sv = $('[data-act=save-test]', box);
    if (sv) sv.onclick = async () => {
      const p = pending; sv.disabled = true;
      const row = { calc_type: 'seed_spider', equipment_id: st.drill ? Number(st.drill) : null, bin: null, sponge_set: st.sponge.trim() || null,
        spacing_in: Number(st.spacing), units: Number(st.rows), rows_caught: 1, crop_id: Number(st.crop), variety: st.variety.trim() || null, seed_lot: st.lot.trim() || null,
        target_lb_ac: p.tgt || null, rpm, catch_sec: sec, speed_mph: mph, grams: st.rowG.map((g) => (Number(g) > 0 ? Number(g) : null)), grams_avg: Math.round(p.avg * 100) / 100,
        actual_lb_ac: Math.round(p.actual * 100) / 100, tested_on: localDate() };
      try { await q(sb.from('planter_cal_tests').insert(row)); } catch { sv.disabled = false; return; }
      toast('Test saved');
      if (p.nextRpm != null) st.rpm = String(p.nextRpm);
      st.rowG = Array(8).fill(''); save();
      await loadTests(); draw();
    };
  };

  const fmtClock = (ms) => { const t = ms / 1000; return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`; };
  const beep = () => {
    try { navigator.vibrate?.([400, 150, 400, 150, 400]); } catch { /* not supported */ }
    try {
      const ac = tm.ac; if (!ac) return;
      [0, 0.25, 0.5].forEach((d) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.4, ac.currentTime + d); o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.18); });
    } catch { /* no audio */ }
  };
  const wireTimer = () => {
    const clock = $('#ss-clock', box), sub = $('#ss-clock-sub', box), wrap = $('#ss-timer', box);
    if (!clock) return;
    const tick = () => {
      if (!document.body.contains(clock)) { clearInterval(tm.iv); tm.iv = null; return; }
      const ms = tm.start ? Date.now() - tm.start : 0, target = Number(st.sec) * 1000;
      clock.textContent = fmtClock(ms);
      const done = tm.start && target > 0 && ms >= target;
      wrap.classList.toggle('running', !!tm.start && !done); wrap.classList.toggle('done', !!done);
      sub.textContent = !tm.start ? `target ${st.sec || '—'} s` : done ? 'Time! Shut off the meters, then tap Stop' : `${((target - ms) / 1000).toFixed(0)} s to go`;
      if (done && !tm.beeped) { tm.beeped = true; beep(); }
    };
    if (tm.start && !tm.iv) tm.iv = setInterval(tick, 100);
    tick();
    $('[data-tm=start]', box).onclick = async () => {
      if (tm.start) return;
      try { tm.ac ??= new (window.AudioContext || window.webkitAudioContext)(); await tm.ac.resume(); } catch { /* no audio */ }
      try { tm.lock = await navigator.wakeLock?.request('screen'); } catch { /* keep-awake not available */ }
      tm.start = Date.now(); tm.beeped = false; clearInterval(tm.iv); tm.iv = setInterval(tick, 100); tick();
    };
    $('[data-tm=stop]', box).onclick = () => {
      if (!tm.start) return;
      const secs = Math.round((Date.now() - tm.start) / 100) / 10;
      tm.start = null; clearInterval(tm.iv); tm.iv = null; try { tm.lock?.release(); } catch { /* ignore */ }
      st.sec = String(secs); save(); draw();
      $('#ss-clock', box).textContent = fmtClock(secs * 1000); $('#ss-clock-sub', box).textContent = `measured ${secs} s · used as catch time`;
    };
    $('[data-tm=reset]', box).onclick = () => { tm.start = null; clearInterval(tm.iv); tm.iv = null; try { tm.lock?.release(); } catch { /* ignore */ } tick(); };
  };

  const wire = () => {
    $$('[data-f]', box).forEach((i) => (i.onchange = i.oninput = () => { st[i.dataset.f] = i.value; save(); if (i.tagName === 'SELECT') draw(); else { drawLog(); calc(); } }));
    $$('[data-k]', box).forEach((i) => (i.oninput = () => { st[i.dataset.k] = i.value; save(); calc(); }));
    $$('[data-k=sec], [data-k=spacing]', box).forEach((i) => (i.onchange = () => draw()));
    $$('[data-row]', box).forEach((i) => (i.oninput = () => { st.rowG[Number(i.dataset.row)] = i.value; save(); calc(); }));
    $('[data-act=clear]', box).onclick = () => { st.target = ''; st.rowG = Array(8).fill(''); save(); draw(); };
    wireTimer();
  };
  draw();
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
  chem: renderChem,
  work: renderWork,
  setup: renderSetup,
  tools: renderTools,
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
$('#account').onclick = async () => {
  const { data: { user } } = await sb.auth.getUser();
  const dlg = $('#dialog');
  dlg.classList.remove('wide');
  dlg.innerHTML = `<form class="form">
    <h3>Account</h3>
    <p class="muted small">Signed in as <b>${esc(user?.email ?? '')}</b></p>
    <label>New password<input type="password" name="pw" autocomplete="new-password" minlength="8" required></label>
    <label>Type it again<input type="password" name="pw2" autocomplete="new-password" minlength="8" required></label>
    <p class="muted small">At least 8 characters.</p>
    <div class="actions"><span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Change password</button></div></form>`;
  const form = $('form', dlg);
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const pw = form.elements.pw.value;
    if (pw !== form.elements.pw2.value) return toast('The two passwords don\'t match', true);
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw });
    btn.disabled = false;
    if (error) return toast(error.message, true);
    dlg.close();
    toast('Password changed');
  };
  dlg.showModal();
};
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
