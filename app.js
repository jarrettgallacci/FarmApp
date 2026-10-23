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
const refs = { riders: [], turnouts: [], fields: [], leases: [], crops: [], chemicals: [], operators: [], workTypes: [], equipment: [], appRates: [], customers: [] };

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
  const eqRes = await sb.from('equipment').select('*, equipment_work_types(operation), equipment_fields(field_id)').order('name');
  refs.equipment = (eqRes.error ? (await sb.from('equipment').select('*, equipment_work_types(operation)').order('name')).data : eqRes.data) ?? [];
  refs.appRates = (await sb.from('application_rates').select('*')).data ?? [];
  refs.customers = (await sb.from('customers').select('*').order('name')).data ?? [];
}
// ---- Cost rates ($/acre). Machine override first, then the work type's / application method's rate.
const money = (v, d = 2) => (v == null || v === '' ? '' : '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
function workRate(operation, equipmentId) {
  const m = refs.equipment.find((e) => e.equipment_id === Number(equipmentId));
  if (m?.cost_per_acre != null) return { rate: Number(m.cost_per_acre), basis: m.name };
  const w = refs.workTypes.find((x) => x.operation === operation);
  if (w?.cost_per_acre != null) return { rate: Number(w.cost_per_acre), basis: `${workLabel(operation)} rate` };
  return { rate: null, basis: null };
}
function appRate(method, sprayerId) {
  const m = method === 'spray' ? refs.equipment.find((e) => e.equipment_id === Number(sprayerId)) : null;
  if (m?.cost_per_acre != null) return { rate: Number(m.cost_per_acre), basis: m.name };
  const r = refs.appRates.find((x) => x.method === method);
  if (r?.cost_per_acre != null) return { rate: Number(r.cost_per_acre), basis: `${methodName(method)} rate` };
  return { rate: null, basis: null };
}
// Which crop a work pass is charged to. Tillage prepares the NEXT crop; everything else belongs to the crop standing in the field.
const cyKey = (c) => c.planting_date ?? `${c.season}-12-31`;
function autoCropYear(operation, date, cys) {
  if (!date) return null;
  if (operation === 'tillage') return [...cys].sort((a, b) => cyKey(a).localeCompare(cyKey(b)) || a.sequence - b.sequence).find((c) => cyKey(c) >= date) ?? null;
  const yr = Number(date.slice(0, 4));
  const live = cys.filter((c) => c.season === yr || (c.multi_year && c.season <= yr && (c.end_season == null || c.end_season >= yr)));
  const planted = live.filter((c) => c.planting_date && c.planting_date <= date).sort((a, b) => b.planting_date.localeCompare(a.planting_date));
  return planted[0] ?? live.sort((a, b) => b.season - a.season || a.sequence - b.sequence)[0] ?? null;
}
const cyName = (c) => (c ? `${cropName(c.crop_id)}${c.variety ? ' · ' + c.variety : ''} (${c.season})` : '');
const equipName = (id) => refs.equipment.find((e) => e.equipment_id === id)?.name ?? '';
// ---- Equipment numbers: 3 digits, the hundreds say the category. Unnumbered gear falls back to its type.
const EQ_BANDS = [['tractor', 'Tractors & self-propelled', 100], ['pickup', 'Pickups', 200], ['truck', 'Heavy trucks & trailers', 300], ['construction', 'Construction', 400],
  ['implement', 'Implements', 500], ['other', 'Other', 600], ['irrigation', 'Irrigation', 700], ['building', 'Buildings & shop', 900]];
const EQ_SUBS = {
  implement: [['Tillage', 500, 519], ['Planting', 520, 539], ['Cultivation & bedding', 540, 559], ['Harvest', 560, 579], ['Application', 580, 599]],
  irrigation: [['Pivots', 700, 739], ['Solid sets', 740, 759], ['Pump stations', 760, 779], ['Mainlines & wells', 780, 799]],
};
const TYPE_BAND = [[/tractor|combine|swather|windrower|sprayer/i, 100], [/pickup/i, 200], [/truck|trailer/i, 300], [/loader|forklift|scraper|blade|excavat|backhoe|skid/i, 400],
  [/disk|ripper|plough|plow|rototill|packer|skewtread|shredder|harrow/i, 500], [/planter|drill/i, 520], [/cultivat|corrugat|dammer|toolbar|bedder|marker/i, 540],
  [/bean cutter|header|digger/i, 560], [/pivot/i, 700], [/solid ?set|handline|hand line|wheel ?line/i, 740], [/pump/i, 760], [/well|mainline/i, 780],
  [/building|shop|shed|\bbin/i, 900]];
const eqNum = (e) => (/^\d{3}$/.test(String(e?.unit_no ?? '').trim()) ? Number(e.unit_no) : null);
const eqBandStart = (e) => { const n = eqNum(e); return n != null ? n : TYPE_BAND.find(([re]) => re.test(e?.type ?? ''))?.[1] ?? 600; };
const eqCat = (e) => EQ_BANDS.find(([, , b]) => Math.floor(eqBandStart(e) / 100) * 100 === b)?.[0] ?? 'other';
const eqSub = (e) => (EQ_SUBS[eqCat(e)] ?? []).find(([, lo, hi]) => eqBandStart(e) >= lo && eqBandStart(e) <= hi)?.[0] ?? null;
const eqFields = (e) => (e?.equipment_fields ?? []).map((x) => fieldById(x.field_id)?.name).filter(Boolean);
const eqLabel = (e) => `${eqNum(e) != null ? `#${eqNum(e)} ` : ''}${e.name}${eqCat(e) === 'irrigation' && eqFields(e).length ? ` · field ${eqFields(e).join(', ')}` : ''}`;
const eqSort = (a, b) => (eqNum(a) ?? 1e4) - (eqNum(b) ?? 1e4) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
function nextFreeNumber(start) {
  const band = Object.values(EQ_SUBS).flat().find(([, lo]) => lo === start) ?? [null, start, Math.floor(start / 100) * 100 + 99];
  const used = new Set(refs.equipment.map(eqNum).filter((n) => n != null));
  for (let n = band[1]; n <= band[2]; n++) if (!used.has(n)) return n;
  return null;
}
// Category first, then the equipment in it. Returns HTML; wire with wireEquipPicker.
function equipPickerHtml(name, cur, { required = true, label = 'Equipment' } = {}) {
  const e0 = refs.equipment.find((e) => e.equipment_id === cur);
  const cat = e0 ? eqCat(e0) : '';
  return `<div class="row2 eq-picker" data-eqpick="${name}">
    <label>Category<select data-eqcat><option value="">All categories</option>${EQ_BANDS.filter(([k]) => refs.equipment.some((e) => eqCat(e) === k)).map(([k, l, b]) => `<option value="${k}" ${k === cat ? 'selected' : ''}>${b}s · ${esc(l)}</option>`).join('')}</select></label>
    <label>${label}${required ? ' *' : ''}<select name="${name}" ${required ? 'required' : ''}></select></label></div>`;
}
function wireEquipPicker(root, name, onChange) {
  const box = $(`[data-eqpick="${name}"]`, root), catSel = $('[data-eqcat]', box), sel = $(`select[name="${name}"]`, box);
  let cur = Number(sel.dataset.cur || 0) || null;
  const fill = () => {
    const cat = catSel.value;
    const list = refs.equipment.filter((e) => (e.active || e.equipment_id === cur) && (!cat || eqCat(e) === cat)).sort(eqSort);
    const groups = new Map();
    list.forEach((e) => { const g = cat ? eqSub(e) ?? '' : EQ_BANDS.find(([k]) => k === eqCat(e))?.[1]; groups.set(g, [...(groups.get(g) ?? []), e]); });
    sel.innerHTML = '<option value="">Choose…</option>' + [...groups].map(([g, es]) => {
      const opts = es.map((e) => `<option value="${e.equipment_id}" ${e.equipment_id === cur ? 'selected' : ''}>${esc(eqLabel(e))}</option>`).join('');
      return g ? `<optgroup label="${esc(g)}">${opts}</optgroup>` : opts;
    }).join('');
  };
  catSel.onchange = () => { fill(); onChange?.(); };
  sel.addEventListener('change', () => { cur = Number(sel.value) || null; onChange?.(); });
  return { set(id) { cur = id; const e = refs.equipment.find((x) => x.equipment_id === id); if (e) catSel.value = eqCat(e); fill(); }, fill };
}
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
const customerName = (id) => refs.customers.find((c) => c.customer_id === id)?.name ?? '';
// Where a work record happened: one of our fields, or a customer's ground.
const workWhere = (r) => (r.customer_id ? `${customerName(r.customer_id)}${r.location ? ' · ' + r.location : ''}` : fieldName(r.field_id));

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
      { key: 'login_email', label: 'App sign-in email (so "My tasks" shows their tasks)', listLabel: 'Login', type: 'text', list: true },
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
    filters: [{ key: 'cat', all: 'All categories', options: () => EQ_BANDS.map(([k, l, b]) => [k, `${b}s · ${l}`]), test: (r, v) => eqCat(r) === v },
      { key: 'work', all: 'All work', options: () => refs.workTypes.filter((w) => w.active).map((w) => [w.operation, workLabel(w.operation)]),
      test: (r, v) => (r.equipment_work_types ?? []).some((x) => x.operation === v) },
      { key: 'type', all: 'All types', options: () => typesInCategory(CRUD.equipment.state?.f?.cat).map((t) => [t, t]), test: (r, v) => (r.type ?? '').toLowerCase() === v.toLowerCase() }],
    columns: [
      { key: 'num_list', label: 'No.', list: true, form: false, compute: (r) => (eqNum(r) != null ? `#${eqNum(r)}` : '') },
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'type', label: 'Type', listLabel: 'Type', type: 'select', list: true, required: true, options: () => equipTypeOptions() },
      { key: 'fields_list', label: 'Fields', list: true, form: false, compute: (r) => eqFields(r).join(', ') },
      { key: 'make', label: 'Make', type: 'text', list: true },
      { key: 'model', label: 'Model', type: 'text', list: true },
      { key: 'model_year', label: 'Model year', listLabel: 'Year', type: 'number', step: '1', list: true },
      { key: 'serial_no', label: 'Serial number / PIN', listLabel: 'Serial / PIN', type: 'text', list: true },
      { key: 'unit_no', label: 'Equipment # (100s tractors & self-propelled, 200s pickups, 300s trucks & trailers, 400s construction, 500s implements, 600s other, 700s irrigation, 900s buildings)', listLabel: 'No.', type: 'text' },
      { key: 'engine_serial', label: 'Engine serial', type: 'text' },
      { key: 'hp', label: 'Horsepower (pumps)', type: 'number', step: '0.1' },
      { key: 'frame_size', label: 'Frame size (pumps)', type: 'text' },
      { key: 'meter_no', label: 'Meter number (pumps)', type: 'text' },
      { key: 'vfd', label: 'Has a VFD (pumps)', type: 'checkbox' },
      { key: 'hours', label: 'Hours', type: 'number', step: '0.1', list: true },
      { key: 'hours_date', label: 'Hours as of', type: 'date' },
      { key: 'purchase_date', label: 'Purchase date', type: 'date' },
      { key: 'purchase_price', label: 'Purchase price', type: 'number', step: '0.01' },
      { key: 'license_plate', label: 'License plate', type: 'text' },
      { key: 'cost_per_acre', label: 'Cost per acre when this machine is used ($/ac, optional; overrides the work type or application rate)', listLabel: '$/ac', type: 'number', step: '0.01', list: true },
      { key: 'planting_settings', label: 'Planting settings to record (planters only, one per line; for a choice write "Name: Option A | Option B")', type: 'textarea' },
      { key: 'work', label: 'Used for', list: true, form: false, compute: (r) => (r.equipment_work_types ?? []).map((x) => workLabel(x.operation)).join(', ') },
      { key: 'verified_on', label: 'Last checked (seen on the farm)', listLabel: 'Checked', type: 'date', list: true },
      { key: 'photos', label: 'Photos', list: true, form: false, compute: (r) => (r.equipment_photos?.[0]?.count ? `📷 ${r.equipment_photos[0].count}` : '') },
      { key: 'active', label: 'Active', type: 'checkbox', default: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    tabs: [{ key: 'active', label: 'Active', test: (r) => r.active }, { key: 'inactive', label: 'Sold / inactive', test: (r) => !r.active }],
    select: '*, equipment_photos(count), equipment_work_types(operation), equipment_fields(field_id)',
    sorts: [['number', 'Equipment #', eqSort], ['name', 'Name', (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })],
      ['type', 'Type', (a, b) => String(a.type ?? '').localeCompare(String(b.type ?? ''))],
      ['checked', 'Not checked first', (a, b) => String(a.verified_on ?? '').localeCompare(String(b.verified_on ?? ''))]],
    reopenAfterCreate: 'Saved. You can add photos now.',
    headExtra: '<button data-act="scan">Scan QR</button><button data-act="qr">Print QR labels</button>',
    wireHead: (el, rows) => {
      $('[data-act=scan]', el).onclick = () => openScanner(); $('[data-act=qr]', el).onclick = () => openQrLabels(rows);
      // Picking a category narrows the type list to that category's types.
      const catSel = $('[data-filter=cat]', el), typeSel = $('[data-filter=type]', el), st = CRUD.equipment.state;
      catSel?.addEventListener('change', () => {
        const types = typesInCategory(catSel.value);
        typeSel.innerHTML = `<option value="">All types</option>${types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}`;
        if (st.f.type && types.some((t) => t.toLowerCase() === st.f.type.toLowerCase())) typeSel.value = types.find((t) => t.toLowerCase() === st.f.type.toLowerCase());
        else if (st.f.type) { st.f.type = ''; typeSel.value = ''; typeSel.dispatchEvent(new Event('change')); }
      });
    },
    afterRender: (form, row) => { narrowTypeChoices(form, row); equipmentNumberHint(form, row); equipmentWorkTags(form, row); equipmentFieldLinks(form, row).then(() => syncType()); equipmentService(form, row); equipmentPhotos(form, row); const syncType = typeOnlyFields(form, row); },
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
  customers: {
    table: 'customers', pk: 'customer_id', title: 'Customers', singular: 'customer', order: 'name',
    allowDelete: true, refreshRefs: true, search: true,
    columns: [
      { key: 'name', label: 'Name', type: 'text', required: true, list: true },
      { key: 'phone', label: 'Phone', type: 'text', list: true },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'default_rate', label: 'Usual rate ($/acre)', listLabel: '$/ac', type: 'number', step: '0.01', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'active', label: 'Active', type: 'checkbox', default: true, list: true },
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
      <div class="row">${cfg.headExtra ?? ''}<button class="primary" data-act="add">Add ${esc(cfg.singular)}</button></div></div>
    ${cfg.tabs ? `<div class="subtabs">${cfg.tabs.map((t) => `<button class="${t.key === st.tab ? 'active' : ''}" data-tab="${t.key}">
      ${esc(t.label)} <span class="muted">${rows.filter(t.test).length}</span></button>`).join('')}</div>` : ''}
    ${cfg.search || filters.length || cfg.sorts ? `<div class="filters">
      ${cfg.search ? `<input type="search" class="search" placeholder="Search ${esc(cfg.title.toLowerCase())}…" value="${esc(st.q)}">` : ''}
      ${filters.map((f) => `<select data-filter="${f.key}"><option value="">${esc(f.all)}</option>${f.options().map(([v, t]) =>
        `<option value="${esc(v)}" ${st.f[f.key] === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`).join('')}
      ${cfg.sorts ? `<select data-sort>${cfg.sorts.map(([k, t]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>Sort: ${esc(t)}</option>`).join('')}</select>` : ''}
    </div><p class="muted small" data-count></p>` : ''}
    <div class="card table-wrap crud-wrap"><table class="crud m-cards">
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
  cfg.wireHead?.(el, rows);
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
  // Changes already made in the field (shared across everyone).
  const checks = changedToday ? ((await sb.from('water_change_checks').select('field_id').eq('order_id', current.order_id)).data ?? null) : [];
  const checked = new Set((checks ?? []).map((c) => c.field_id));
  const changeLine = ({ f, a, b }) => {
    let value, badge, name = b.on ? b.name : a.name;
    if (!b.on) { value = 'Off'; badge = '<span class="badge off">Off</span>'; }
    else if (!a.on) { value = `On ${num(b.cfs)} CFS`; badge = '<span class="badge new">On</span>'; }
    else if (a.halfKey !== b.halfKey && Math.abs(a.cfs - b.cfs) < 0.001) { name = b.name; value = `Moved from ${esc(a.name)}`; badge = '<span class="badge up">Move</span>'; }
    else { value = `${num(a.cfs)} → ${num(b.cfs)} CFS`; badge = b.cfs > a.cfs ? '<span class="badge up">Up</span>' : '<span class="badge down">Down</span>'; }
    const tick = checks ? `<label class="done-tick" title="Mark done"><input type="checkbox" data-wdone="${f.field_id}" ${checked.has(f.field_id) ? 'checked' : ''}><span>Done</span></label>` : '';
    return `<li class="${checked.has(f.field_id) ? 'is-done' : ''}"><span class="li-name">${esc(name)}</span><span class="li-value">${value} ${badge}${tick}</span></li>`;
  };
  const groupHtml = (gs, line) => gs.map((g) => `<div class="group"><h4>${esc(g.rider.name)}</h4>
    <ul class="list">${g.rows.map(line).join('')}</ul></div>`).join('');

  let changesHtml;
  if (changedToday) {
    const todo = changeGroups.map((g) => ({ ...g, rows: g.rows.filter((r) => !checked.has(r.f.field_id)) })).filter((g) => g.rows.length);
    const doneRows = changeGroups.flatMap((g) => g.rows.filter((r) => checked.has(r.f.field_id)));
    changesHtml = changeGroups.length
      ? (todo.length ? groupHtml(todo, changeLine) : '<p class="muted">All of today\'s changes are done.</p>')
        + (doneRows.length ? `<details class="done-list"><summary>${doneRows.length} done</summary><ul class="list">${doneRows.map(changeLine).join('')}</ul></details>` : '')
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
      <div><p class="eyebrow">${esc(fmtLong(today))}</p>
      <h2>Today on the farm</h2></div>
      <button class="scan-btn" data-act="scan">📷 Scan QR</button>
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
        <section class="card"><h3>Work schedule</h3><div id="dash-sched"><p class="muted small">Loading…</p></div></section>
      </div>
    </div>`;

  $$('[data-act=tomorrow]', el).forEach((b) => (b.onclick = () => { orderState.date = tomorrow; show('order'); }));
  drawSchedule($('#dash-sched', el), () => renderHome(el));
  $('[data-act=scan]', el).onclick = () => openScanner();
  $$('[data-wdone]', el).forEach((c) => (c.onchange = async () => {
    const fid = Number(c.dataset.wdone);
    try {
      if (c.checked) await q(sb.from('water_change_checks').upsert({ order_id: current.order_id, field_id: fid }));
      else await q(sb.from('water_change_checks').delete().eq('order_id', current.order_id).eq('field_id', fid));
    } catch { /* shown */ }
    renderHome(el);
  }));
  drawForecast($('#forecast', el));
}

// ---- Dashboard: planned work and chemical, overdue first, then the next 14 days.
async function drawSchedule(box, reload) {
  if (!box) return;
  const today = localDate(), until = addDays(today, 14);
  const [wRes, cRes] = await Promise.all([
    sb.from('work_events').select('*').eq('status', 'planned').lte('performed_on', until).order('performed_on'),
    sb.from('chemical_events').select('event_id, field_id, applied_on, method, chemical_event_products(chemical_id)').eq('status', 'planned').lte('applied_on', until).order('applied_on'),
  ]);
  const items = [
    ...(wRes.data ?? []).map((w) => ({ date: w.performed_on, kind: 'work', id: w.event_id, field: w.field_id, where: workWhere(w), custom: !!w.customer_id,
      what: `${workLabel(w.operation)}${w.harvest_stage ? ' · ' + stageName(w.harvest_stage) : ''}`, sub: [equipName(w.tractor_id), equipName(w.equipment_id)].filter(Boolean).join(' + ') })),
    ...(cRes.data ?? []).map((c) => ({ date: c.applied_on, kind: 'chem', id: c.event_id, field: c.field_id,
      what: methodName(c.method), sub: c.chemical_event_products.map((l) => chemById(l.chemical_id)?.name).filter(Boolean).join(', ') })),
  ].sort((a, b) => a.date.localeCompare(b.date) || fieldName(a.field).localeCompare(fieldName(b.field), undefined, { numeric: true }));
  if (wRes.error && cRes.error) { box.innerHTML = '<p class="muted small">Planned work shows here once work_plan.sql is run.</p>'; return; }
  if (!items.length) { box.innerHTML = '<p class="muted">Nothing planned for the next two weeks. Plan work from a field on the map, or from the Work tab.</p>'; return; }
  const day = (d) => (d < today ? 'Overdue' : d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDay(d));
  const groups = [];
  items.forEach((it) => { const k = it.date < today ? 'Overdue' : it.date; const g = groups.find((x) => x.k === k); if (g) g.items.push(it); else groups.push({ k, label: day(it.date), items: [it] }); });
  box.innerHTML = groups.map((g) => `<div class="group"><h4 class="${g.k === 'Overdue' ? 'overdue' : ''}">${esc(g.label)}</h4><ul class="list">${g.items.map((it) => `<li>
    <span class="li-name"><b>${esc(it.where ?? fieldName(it.field))}</b> ${esc(it.what)}${it.kind === 'chem' ? ' <span class="badge up">Chem</span>' : ''}${it.custom ? ' <span class="badge up">Custom</span>' : ''}${it.sub ? `<span class="muted small">${esc(it.sub)}${g.k === 'Overdue' ? ' · ' + esc(fmtDay(it.date)) : ''}</span>` : ''}</span>
    <span class="li-value"><button class="small" data-sched="${it.kind}:${it.id}">Open</button></span></li>`).join('')}</ul></div>`).join('');
  $$('[data-sched]', box).forEach((b) => (b.onclick = async () => {
    const [kind, id] = b.dataset.sched.split(':');
    if (kind === 'work') return openWorkForm({ eventId: Number(id) }, reload);
    const [cev] = await q(sb.from('chemical_events').select('*, chemical_event_products(*), crop_years(crop_id, variety)').eq('event_id', Number(id)));
    cev.chemical_event_products.sort((a, x) => a.position - x.position);
    openChemForm({ event: cev }, reload);
  }));
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
    ${rows.length ? `<div class="table-wrap"><table class="m-cards">
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

const mapState = { map: null, view: null, season: new Date().getFullYear(), editMode: false, layers: [], ed: null, irrMode: false, irr: null };
// Irrigation status from the latest startup/shutdown round each pivot was in.
const IRR_STATES = { on: ['#2563eb', 'Water on'], progress: ['#facc15', 'In progress'], winterized: ['#16a34a', 'Winterized'] };
// Each system's state comes from the latest startup or shutdown round it's in (a pivot on a pump station's
// checklist counts through the station). A field is green only when every system on it is winterized,
// blue when all are on, yellow otherwise. No round yet = water on.
async function loadIrrStatus() {
  const res = await sb.from('procedure_runs').select('run_id, started_on, procedures(kind), procedure_tasks(equipment_id, status)').order('started_on', { ascending: false }).order('run_id', { ascending: false }).limit(200);
  if (res.error) return null;
  const byEq = new Map();
  for (const r of res.data) {
    const kind = r.procedures?.kind;
    if (kind !== 'startup' && kind !== 'shutdown') continue;
    for (const t of r.procedure_tasks) {
      if (byEq.has(t.equipment_id)) continue;
      byEq.set(t.equipment_id, t.status === 'in_progress' ? 'progress'
        : kind === 'shutdown' ? (t.status === 'done' ? 'winterized' : 'on') : (t.status === 'done' ? 'on' : 'winterized'));
    }
  }
  const links = (await sb.from('equipment_fields').select('equipment_id, field_id')).data ?? [];
  const perField = new Map(), irrigated = new Set();
  for (const e of refs.equipment.filter((x) => x.active && ['pivots', 'pumps', 'solid_sets'].includes(sysType(x)))) {
    links.filter((x) => x.equipment_id === e.equipment_id).forEach((l) => irrigated.add(l.field_id));
    const st = byEq.get(e.equipment_id);
    if (!st) continue;   // not in any round (e.g. a pivot on its pump station's checklist)
    for (const l of links.filter((x) => x.equipment_id === e.equipment_id)) perField.set(l.field_id, [...(perField.get(l.field_id) ?? []), st]);
  }
  const byField = new Map();
  for (const f of refs.fields) {
    if (!irrigated.has(f.field_id)) continue;   // no pivot, pump or solid set on it: not colored
    const sts = perField.get(f.field_id);
    byField.set(f.field_id, !sts ? 'on' : sts.every((x) => x === 'winterized') ? 'winterized' : sts.every((x) => x === 'on') ? 'on' : 'progress');
  }
  return byField;
}

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
  mapState.irr = mapState.irrMode ? await loadIrrStatus() : null;

  el.innerHTML = `
    <div class="section-head"><h2>Farm map</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous season">‹</button>
        <strong class="season">${season}</strong>
        <button data-season="1" aria-label="Next season">›</button>
        ${mapState.editMode ? '' : `<button class="${mapState.selecting ? 'primary' : ''}" data-act="select">${mapState.selecting ? 'Done selecting' : 'Select fields'}</button>`}
        ${mapState.editMode ? '' : `<button class="${mapState.irrMode ? 'primary' : ''}" data-act="irr">${mapState.irrMode ? 'Show crops' : 'Irrigation status'}</button>`}
        <button class="${mapState.editMode ? 'primary' : ''}" data-act="edit">${mapState.editMode ? 'Done editing' : 'Edit shapes'}</button>
      </div></div>
    ${mapState.irrMode ? (mapState.irr ? `<div class="irr-legend">${Object.values(IRR_STATES).map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`
      : '<p class="notice">Irrigation status needs <b>irrigation_procedures.sql</b> run in Supabase.</p>') : ''}
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
  const irrBtn = $('[data-act=irr]', el);
  if (irrBtn) irrBtn.onclick = () => { mapState.irrMode = !mapState.irrMode; renderMap(el); };
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
    const irrSt = mapState.irrMode && mapState.irr && !mapState.editMode ? mapState.irr.get(f.field_id) ?? null : undefined;
    if (irrSt !== undefined) {
      const c = irrSt ? IRR_STATES[irrSt][0] : '#ffffff';
      const layer = L.polygon(f.boundary.geometry.coordinates[0].map(toLL), { color: irrSt ? c : '#ffffff', weight: irrSt ? 2 : 1, dashArray: irrSt ? null : '3 5', fillColor: c, fillOpacity: irrSt ? 0.6 : 0.08 }).addTo(map);
      layer.bindTooltip(esc(f.name), { permanent: true, direction: 'center', className: 'field-label' });
      layer.on('click', (e) => { L.DomEvent.stopPropagation(e); if (mapState.selecting) toggleSelect(f); else showFieldInfo(f); });
      if (mapState.selected?.has(f.field_id)) layer.setStyle({ color: '#ffd400', weight: 4, dashArray: null });
      mapState.layers.push({ field: f, layer });
      continue;
    }
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
        <button data-act="log-work">Log work</button>
        <button data-act="plan-work">Plan work</button>
        <button data-act="share">Share locations</button>
        <button class="ghost small" data-act="clear">Clear selection</button>
      </div>` : '<p class="muted">Nothing selected yet.</p>'}`;
  const go = (status) => openChemForm({ fieldIds: ids, status }, () => { mapState.selected = new Set(); drawFields(); drawSide(); });
  const b = (n, fn) => { const x = $(`[data-act=${n}]`, side); if (x) x.onclick = fn; };
  b('log-chem', () => go('done'));
  b('plan-chem', () => go('planned'));
  const goWork = (status) => openWorkForm({ fieldIds: ids, status }, () => { mapState.selected = new Set(); drawFields(); drawSide(); });
  b('log-work', () => goWork('done'));
  b('plan-work', () => goWork('planned'));
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
      <button class="primary" data-act="log-chem">Log chemical</button>
      <button data-act="log-work">Log work</button><button data-act="plan-work">Plan work</button></div>
    <h4>Recent chemical</h4><div id="recent-chem"><p class="muted small">Loading…</p></div>`;
  $('[data-act=log-chem]').onclick = () => openChemForm({ fieldIds: [f.field_id] }, () => showFieldInfo(f));
  $('#map-side [data-act=log-work]').onclick = () => openWorkForm({ fieldIds: [f.field_id], status: 'done' }, () => showFieldInfo(f));
  $('#map-side [data-act=plan-work]').onclick = () => openWorkForm({ fieldIds: [f.field_id], status: 'planned' }, () => showFieldInfo(f));
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
const workState = { season: new Date().getFullYear(), op: '', q: '', view: 'records', status: '', ground: '' };
const HARVEST_STAGES = [['swath', 'Swath / cut'], ['merge', 'Merge / lift'], ['thresh', 'Combine / thresh'], ['other', 'Other']];
const stageName = (k) => HARVEST_STAGES.find(([x]) => x === k)?.[1] ?? '';
const PLANT_LABELS = ['Female', 'Male 1', 'Male 2', 'Male 3'];
const dateRange = (a, b) => (b && b !== a ? `${fmtDate(a)}–${fmtDate(b)}` : fmtDate(a));
const actualRate = (d, acres) => (d?.seed_used != null && Number(acres) > 0 ? Number(d.seed_used) / Number(acres) : null);
const rateFmt = (n, unit) => (n == null ? '' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 })} ${unit ?? ''}`.trim());

async function renderWork(el) {
  const s = workState;
  if (s.view === 'harvest') return renderHarvest(el);
  const { data, error } = await sb.from('work_events')
    .select('*, planting_details(*), crop_years(crop_id, variety)')
    .gte('performed_on', `${s.season}-01-01`).lte('performed_on', `${s.season}-12-31`)
    .order('performed_on', { ascending: false }).order('event_id', { ascending: false });
  if (error) { el.innerHTML = `<div class="empty">Work records aren't set up yet. Run <b>work_records.sql</b> in Supabase first.</div>`; return; }
  const term = s.q.trim().toLowerCase();
  // Crops for automatic charging (tillage can land on next year's crop).
  const cys = (await sb.from('crop_years').select('crop_year_id, field_id, crop_id, variety, season, sequence, planting_date, multi_year, end_season')
    .gte('season', s.season - 2).lte('season', s.season + 1)).data ?? [];
  const chargedTo = (r) => {
    if (r.crop_year_id) return { cy: cys.find((c) => c.crop_year_id === r.crop_year_id) ?? (r.crop_years ? { ...r.crop_years, season: '' } : null), auto: false };
    return { cy: autoCropYear(r.operation, r.performed_on, cys.filter((c) => c.field_id === r.field_id)), auto: true };
  };
  const rows = data.filter((r) => (!s.op || r.operation === s.op) && (!s.status || (r.status ?? 'done') === s.status)
    && (!s.ground || (s.ground === 'custom') === !!r.customer_id) &&
    (!term || workWhere(r).toLowerCase().includes(term) || equipName(r.equipment_id).toLowerCase().includes(term)));
  el.innerHTML = `
    ${workViewTabs()}
    <div class="section-head"><h2>Work records</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous year">‹</button>
        <strong class="season">${s.season}</strong>
        <button data-season="1" aria-label="Next year">›</button>
        <button class="primary" data-act="add">Log work</button>
      </div></div>
    <div class="filters">
      <input type="search" data-f="q" placeholder="Search field or equipment…" value="${esc(s.q)}">
      <select data-f="status"><option value="">Planned and done</option><option value="planned" ${s.status === 'planned' ? 'selected' : ''}>Planned</option><option value="done" ${s.status === 'done' ? 'selected' : ''}>Done</option></select>
      <select data-f="ground"><option value="">Our fields and custom</option><option value="ours" ${s.ground === 'ours' ? 'selected' : ''}>Our fields</option><option value="custom" ${s.ground === 'custom' ? 'selected' : ''}>Custom work</option></select>
      <select data-f="op"><option value="">All work</option>${refs.workTypes.map((w) => `<option value="${esc(w.operation)}" ${s.op === w.operation ? 'selected' : ''}>${esc(workLabel(w.operation))}</option>`).join('')}</select>
    </div>
    <p class="muted small">${rows.length} of ${data.length} record(s) in ${s.season}.${rows.some((r) => r.cost_total != null) ? ` Work cost shown: <b>${money(rows.reduce((n, r) => n + Number(r.cost_total || 0), 0), 0)}</b>.` : ''}${rows.some((r) => r.custom_total != null) ? ` Custom work charged: <b>${money(rows.reduce((n, r) => n + Number(r.custom_total || 0), 0), 0)}</b>.` : ''}</p>
    ${rows.length ? `<div class="card table-wrap"><table class="m-cards">
      <thead><tr><th>Date</th><th>Field</th><th>Work</th><th>Equipment</th><th class="r">Acres</th><th>By</th><th></th></tr></thead>
      <tbody>${rows.map((r) => {
        const d = r.planting_details?.[0] ?? r.planting_details;
        const ch = r.customer_id ? { cy: null } : chargedTo(r);
        const crop = ch.cy ? `${cropName(ch.cy.crop_id)}${ch.cy.variety ? ' · ' + ch.cy.variety : ''}${ch.auto && ch.cy.season ? ` ${ch.cy.season}` : ''}${ch.auto ? ' (auto)' : ''}` : r.operation === 'tillage' && !r.customer_id ? 'next crop not entered' : '';
        return `<tr><td class="nowrap">${esc(dateRange(r.performed_on, r.end_date))}</td>
          <td>${r.customer_id ? `<b>${esc(customerName(r.customer_id))}</b> <span class="badge up">Custom</span>${r.location ? `<div class="muted small">${esc(r.location)}</div>` : ''}` : `<b>${esc(fieldName(r.field_id))}</b>`}</td>
          <td>${r.status === 'planned' ? `<span class="badge ${r.performed_on < localDate() ? 'bad' : 'down'}">${r.performed_on < localDate() ? 'Overdue' : 'Planned'}</span> ` : ''}${esc(workLabel(r.operation))}${r.harvest_stage ? ` · ${esc(stageName(r.harvest_stage))}` : ''}${d?.planting_label ? ` <span class="badge up">${esc(d.planting_label)}</span>` : ''}${crop ? `<div class="muted small">${esc(crop)}</div>` : ''}${patText(r, d) ? `<div class="muted small">${esc(patText(r, d))}</div>` : ''}</td>
          <td>${esc([equipName(r.tractor_id), equipName(r.equipment_id)].filter(Boolean).join(' + '))}</td>
          <td class="r">${r.acres != null ? num(r.acres, 1) : ''}${r.cost_total != null ? `<div class="muted small">${money(r.cost_total, 0)}</div>` : ''}${r.custom_total != null ? `<div class="small charge">charge ${money(r.custom_total, 0)}</div>` : ''}</td>
          <td>${esc(operatorName(r.performed_by))}</td>
          <td class="r nowrap">${r.status === 'planned' ? `<button class="small primary" data-done="${r.event_id}">Done</button> ` : ''}<button class="small" data-edit="${r.event_id}">Edit</button></td></tr>`;
      }).join('')}</tbody></table></div>` : `<div class="empty">No work records${data.length ? ' match' : ` for ${s.season}`}.</div>`}`;
  const reload = () => renderWork(el);
  wireWorkViewTabs(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $('[data-act=add]', el).onclick = () => openWorkForm({ custom: s.ground === 'custom' }, reload);
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => openWorkForm({ eventId: Number(b.dataset.edit) }, reload)));
  $$('[data-done]', el).forEach((b) => (b.onclick = () => openWorkForm({ eventId: Number(b.dataset.done), markDone: true }, reload)));
  $$('[data-f]', el).forEach((inp) => {
    const apply = () => { s[inp.dataset.f] = inp.value; reload(); };
    if (inp.type === 'search') { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(apply, 300); }; } else inp.onchange = apply;
  });
}

const patText = (r, d) => {
  const p = r.pattern ?? d?.pattern, h = r.heading_deg ?? d?.heading_deg;
  return p === 'circle' ? 'circle' : h != null ? `heading ${Number(h)}°` : p === 'straight' ? 'straight lines' : '';
};

// opts: { eventId } to edit, or { operation, fieldId, cropYearId } for a new record
async function openWorkForm(opts, onDone) {
  let ev = null;
  if (opts.eventId) [ev] = await q(sb.from('work_events').select('*, planting_details(*)').eq('event_id', opts.eventId));
  const d = (Array.isArray(ev?.planting_details) ? ev.planting_details[0] : ev?.planting_details) ?? {};
  const multi = !ev && (opts.fieldIds?.length ?? 0) > 1;   // several fields from the map: one record each
  const v = ev ? { ...ev } : { operation: opts.operation ?? (multi || opts.fieldIds ? 'tillage' : 'planting'), performed_on: localDate(), field_id: opts.fieldId ?? opts.fieldIds?.[0] ?? null,
    crop_year_id: opts.cropYearId ?? null, harvest_stage: opts.stage ?? null, status: opts.status ?? 'done' };
  if (opts.markDone) { v.status = 'done'; v.performed_on = localDate(); }
  let custom = !!v.customer_id || !!opts.custom;
  v.status ??= 'done';
  const bands = ev ? await q(sb.from('chemical_events').select('*, chemical_event_products(*)').eq('work_event_id', ev.event_id)) : [];
  const types = refs.workTypes.filter((w) => (w.active || w.operation === v.operation) && !(multi && w.operation === 'planting'));
  const pat = v.pattern ?? d.pattern ?? '';           // older planting records kept these on planting_details
  const head = v.heading_deg ?? d.heading_deg;
  const fields = fieldsInOrder().filter((f) => f.active || f.field_id === v.field_id);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form work-form">
    <div class="dialog-head"><h3>${ev ? 'Edit' : v.status === 'planned' ? 'Plan' : 'Log'} work</h3></div>
    <div class="seg" role="group" aria-label="Status">
      <button type="button" data-status="done" class="${v.status === 'done' ? 'on' : ''}">Done<small>work that happened</small></button>
      <button type="button" data-status="planned" class="${v.status === 'planned' ? 'on' : ''}">Planned<small>schedule it</small></button>
    </div>
    ${multi ? '' : `<div class="seg" role="group" aria-label="Whose ground">
      <button type="button" data-ground="ours" class="${custom ? '' : 'on'}">Our field</button>
      <button type="button" data-ground="custom" class="${custom ? 'on' : ''}">Custom work<small>for another farmer</small></button></div>`}
    <div class="custom-box" data-custom>
      <div class="row2">
        <label>Customer *<select name="customer_id"><option value="">Choose…</option>${refs.customers.filter((c) => c.active || c.customer_id === v.customer_id).map((c) => `<option value="${c.customer_id}" ${c.customer_id === v.customer_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}<option value="new">+ New customer…</option></select></label>
        <label data-newcust hidden>New customer name<input name="new_customer"></label>
      </div>
      <label>Location (their field)<input name="location" value="${esc(v.location ?? '')}" placeholder="e.g. Rd 7 & M, north circle"></label>
      <div class="row gps-row"><button type="button" class="small" data-act="gps">📍 Use my location</button><span class="muted small" id="gps-text">${v.lat != null ? `${Number(v.lat).toFixed(5)}, ${Number(v.lng).toFixed(5)}` : ''}</span></div>
      <div class="row2">
        <label>Acres *<input type="number" inputmode="decimal" step="any" min="0" name="c_acres" value="${esc(v.acres ?? '')}"></label>
        <label>Rate charged ($/acre)<input type="number" inputmode="decimal" step="0.01" min="0" name="custom_rate" value="${esc(v.custom_rate ?? '')}"></label>
      </div>
      <p class="cost-line" id="custom-total"></p>
    </div>
    <div class="row2">
      <label>Work *<select name="operation" required>${types.map((w) => `<option value="${esc(w.operation)}" ${w.operation === v.operation ? 'selected' : ''}>${esc(workLabel(w.operation))}</option>`).join('')}</select></label>
      ${multi ? `<div class="ro-field"><span>Fields (${opts.fieldIds.length}, one record each)</span><b>${opts.fieldIds.map((id) => esc(fieldName(id))).join(', ')}</b><input type="hidden" name="field_id" value="${opts.fieldIds[0]}"></div>`
        : `<label data-ours>Field *<select name="field_id" required><option value="">Choose…</option>${fields.map((f) => `<option value="${f.field_id}" ${f.field_id === v.field_id ? 'selected' : ''}>${f.parent_field_id ? '↳ ' : ''}${esc(f.name)}</option>`).join('')}</select></label>`}
    </div>
    <label data-harvest>Harvest pass<select name="harvest_stage"><option value="">—</option>${HARVEST_STAGES.map(([k, l]) => `<option value="${k}" ${v.harvest_stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="row2">
      <label><span id="date-label">Start date *</span><input type="date" name="performed_on" required value="${esc(v.performed_on)}"></label>
      <label>End date<input type="date" name="end_date" value="${esc(v.end_date ?? '')}"></label>
    </div>
    <p class="muted small form-hint">Leave the end date blank if it was done in one day.</p>
    <label ${multi ? 'hidden' : ''} data-ours><span id="cy-label">Crop and variety *</span><select name="crop_year_id"></select></label>
    <p class="muted small" id="cy-hint" ${multi ? 'hidden' : ''} data-ours></p>
    <div class="row2">
      <label>Tractor<select name="tractor_id"></select></label>
      <label><span id="impl-label">Implement</span><select name="equipment_id"></select></label>
    </div>
    <div class="row2">
      <label>Operator<select name="performed_by"><option value="">—</option>${refs.operators.filter((o) => o.active || o.operator_id === v.performed_by).map((o) => `<option value="${o.operator_id}" ${o.operator_id === v.performed_by ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>
      <label ${multi ? 'hidden' : ''} data-ours>Acres<input type="number" step="any" min="0" name="acres" value="${esc(v.acres ?? '')}"></label>
    </div>
    <p class="cost-line" id="cost-line"></p>
    <div class="row2 pattern-row">
      <label>Pattern<select name="pattern"><option value="">—</option>
        <option value="straight" ${pat === 'straight' ? 'selected' : ''}>Straight lines</option>
        <option value="circle" ${pat === 'circle' ? 'selected' : ''}>Circle</option></select></label>
      <label data-heading>GPS heading (°)<input type="number" step="any" min="0" max="360" name="heading_deg" value="${esc(head ?? '')}" placeholder="0–359"></label>
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
  let status = v.status;
  const syncStatus = () => {
    $$('[data-status]', dlg).forEach((b) => b.classList.toggle('on', b.dataset.status === status));
    $('#date-label', dlg).textContent = status === 'planned' ? 'Planned date *' : 'Start date *';
    $('.dialog-head h3', dlg).textContent = ev ? (status === 'planned' ? 'Edit planned work' : 'Edit work') : status === 'planned' ? 'Plan work' : 'Log work';
  };
  $$('[data-status]', dlg).forEach((b) => (b.onclick = () => { status = b.dataset.status; if (status === 'done' && v.status === 'planned' && el.performed_on.value > localDate()) el.performed_on.value = localDate(); syncStatus(); }));
  syncStatus();
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
  let cyCache = { fid: null, rows: [] };
  let cyPicked = v.crop_year_id ?? null;   // planting: the crop planted; other work: a manual choice (blank = automatic)
  const fillCropYears = async () => {
    const fid = Number(el.field_id.value);
    const date = el.performed_on.value || localDate();
    const yr = Number(date.slice(0, 4));
    if (el.crop_year_id.options.length) cyPicked = Number(el.crop_year_id.value) || null;
    if (op() === 'planting') {
      const list = fid ? await cropFor(fid, date) : [];
      el.crop_year_id.innerHTML = `<option value="">Choose…</option>` + list.map((c) => `<option value="${c.crop_year_id}" ${c.crop_year_id === cyPicked ? 'selected' : ''}>${esc(cropName(c.crop_id))}${c.variety ? ' · ' + esc(c.variety) : ''} (${c.season})</option>`).join('');
      if (!el.crop_year_id.value && list.length === 1) el.crop_year_id.value = list[0].crop_year_id;
      $('#cy-label', dlg).textContent = 'Crop and variety *';
      $('#cy-hint', dlg).textContent = fid && !list.length ? `No crop entered for this field in ${yr}. Add it under Crops first.` : '';
      return;
    }
    if (fid && cyCache.fid !== fid) {
      cyCache = { fid, rows: (await sb.from('crop_years').select('crop_year_id, crop_id, variety, season, sequence, planting_date, multi_year, end_season')
        .eq('field_id', fid).gte('season', yr - 2).lte('season', yr + 2)).data ?? [] };
    }
    const rows = fid ? cyCache.rows : [];
    const auto = autoCropYear(op(), date, rows);
    $('#cy-label', dlg).textContent = 'Charged to crop';
    el.crop_year_id.innerHTML = `<option value="">Automatic${auto ? `: ${esc(cyName(auto))}` : op() === 'tillage' ? ' (next crop, not entered yet)' : ' (no crop in the field)'}</option>`
      + [...rows].sort((a, b) => cyKey(a).localeCompare(cyKey(b))).map((c) => `<option value="${c.crop_year_id}" ${c.crop_year_id === cyPicked ? 'selected' : ''}>${esc(cyName(c))}</option>`).join('');
    $('#cy-hint', dlg).textContent = !fid ? '' : op() === 'tillage'
      ? 'Tillage is charged to the next crop planted in this field. If it isn\'t entered yet, the record attaches once it is.'
      : 'Charged to the crop in the field on this date.';
  };
  const showCost = () => {
    const r = workRate(op(), el.equipment_id.value);
    const ac = multi ? opts.fieldIds.reduce((n, id) => n + Number(fieldById(id)?.acres || 0), 0) : custom ? Number(el.c_acres.value) : Number(el.acres.value);
    $('#cost-line', dlg).innerHTML = r.rate == null ? '<span class="muted small">No cost rate for this work. Set one under Setup → Cost rates.</span>'
      : `Cost <b>${money(r.rate)}/ac</b>${ac > 0 ? ` × ${num(ac, 1)} ac = <b>${money(r.rate * ac)}</b>` : ''} <span class="muted small">(${esc(r.basis)})</span>`;
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
    const old = { 'Seed plate': d.seed_plate, 'Driver A (upper)': d.sprocket_1, 'Driver B (lower)': d.sprocket_2, 'Depth (in)': d.depth_in, 'Speed (mph)': d.speed_mph, 'Seeds per 3 ft': d.seeds_per_3ft };
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
    $$('[data-plant]', dlg).forEach((x) => (x.hidden = !planting || custom));
    $$('[data-harvest]', dlg).forEach((x) => (x.hidden = op() !== 'harvest'));
    $$('[data-custom]', dlg).forEach((x) => (x.hidden = !custom));
    $$('[data-ours]', dlg).forEach((x) => (x.hidden = custom || multi));
    if (!multi) el.field_id.required = !custom;
    el.crop_year_id.required = planting && !custom;
    el.c_acres.required = custom;
    showCustom();
    $$('[data-stagger]', dlg).forEach((x) => (x.hidden = !el.staggered.checked));
    fillEquip(); plateLabel(); showCost();
  };
  const showCustom = () => {
    if (!custom) return;
    const ac = Number(el.c_acres.value), rate = Number(el.custom_rate.value);
    $('#custom-total', dlg).innerHTML = ac > 0 && rate > 0 ? `Charge <b>${money(rate * ac)}</b> <span class="muted small">(${money(rate)}/ac × ${num(ac, 1)} ac)</span>` : '<span class="muted small">Enter acres and the rate to see the charge.</span>';
  };
  $$('[data-ground]', dlg).forEach((b) => (b.onclick = () => { custom = b.dataset.ground === 'custom'; $$('[data-ground]', dlg).forEach((x) => x.classList.toggle('on', x === b)); sync(); }));
  el.customer_id.onchange = () => {
    $('[data-newcust]', dlg).hidden = el.customer_id.value !== 'new';
    const c = refs.customers.find((x) => x.customer_id === Number(el.customer_id.value));
    if (c?.default_rate != null && !el.custom_rate.value) { el.custom_rate.value = c.default_rate; showCustom(); }
    if (el.customer_id.value === 'new') el.new_customer.focus();
  };
  el.c_acres.oninput = () => { showCustom(); showCost(); };
  el.custom_rate.oninput = showCustom;
  let gps = v.lat != null ? { lat: Number(v.lat), lng: Number(v.lng) } : null;
  $('[data-act=gps]', dlg).onclick = () => {
    if (!navigator.geolocation) return toast('Location isn’t available on this device', true);
    $('#gps-text', dlg).textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition((p) => { gps = { lat: p.coords.latitude, lng: p.coords.longitude }; $('#gps-text', dlg).textContent = `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (±${Math.round(p.coords.accuracy)} m)`; },
      () => { $('#gps-text', dlg).textContent = 'Couldn’t get your location.'; }, { enableHighAccuracy: true, timeout: 15000 });
  };
  const fieldChanged = () => {
    const f = fieldById(el.field_id.value);
    if (!ev && f?.acres != null && !el.acres.dataset.touched) el.acres.value = Number(f.acres);
    showCost(); fillCropYears();
  };
  el.operation.onchange = () => { sync(); fillCropYears(); };
  el.staggered.onchange = sync;
  el.field_id.onchange = fieldChanged;
  el.performed_on.onchange = fillCropYears;
  el.equipment_id.onchange = () => { plateLabel(); showCost(); };
  el.acres.oninput = () => { el.acres.dataset.touched = '1'; showRate(); showCost(); };
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

  // Several fields from the map: one record per field, each with its own acres and cost.
  const saveMany = async () => {
    const g = (k) => (el[k] ? String(el[k].value).trim() : '');
    const n = (k) => (g(k) === '' ? null : Number(g(k)));
    const cr = workRate(op(), n('equipment_id'));
    const rows = opts.fieldIds.map((fid) => {
      const ac = fieldById(fid)?.acres != null ? Number(fieldById(fid).acres) : null;
      return { operation: op(), field_id: fid, performed_on: g('performed_on'), end_date: g('end_date') || null, status,
        tractor_id: n('tractor_id'), equipment_id: n('equipment_id'), performed_by: n('performed_by'), acres: ac, notes: g('notes') || null,
        pattern: g('pattern') || null, heading_deg: g('pattern') === 'straight' ? n('heading_deg') : null,
        ...(op() === 'harvest' ? { harvest_stage: g('harvest_stage') || null } : {}),
        cost_per_acre: cr.rate, cost_basis: cr.basis, cost_total: cr.rate != null && ac != null ? Math.round(cr.rate * ac * 100) / 100 : null };
    });
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      await q(sb.from('work_events').insert(rows));
      dlg.close(); toast(`${status === 'planned' ? 'Planned' : 'Logged'} ${rows.length} field(s)`); onDone?.();
    } catch { btn.disabled = false; }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const val = (k) => (el[k] ? String(el[k].value).trim() : '');
    const numOrNull = (k) => (val(k) === '' ? null : Number(val(k)));
    const planting = op() === 'planting';
    if (val('end_date') && val('end_date') < val('performed_on')) return toast('End date is before the start date', true);
    if (multi) return saveMany();
    if (custom) {
      if (el.customer_id.value === 'new') {
        const nm = el.new_customer.value.trim();
        if (!nm) return toast('Enter the new customer’s name', true);
        try {
          const [c] = await q(sb.from('customers').insert({ name: nm }).select('*'));
          refs.customers.push(c); el.customer_id.insertAdjacentHTML('afterbegin', `<option value="${c.customer_id}">${esc(c.name)}</option>`); el.customer_id.value = c.customer_id;
        } catch { return; }
      }
      if (!el.customer_id.value) return toast('Pick the customer', true);
    }
    const row = {
      operation: op(), field_id: custom ? null : Number(val('field_id')), performed_on: val('performed_on'), end_date: val('end_date') || null,
      tractor_id: numOrNull('tractor_id'), equipment_id: numOrNull('equipment_id'), performed_by: numOrNull('performed_by'),
      acres: custom ? numOrNull('c_acres') : numOrNull('acres'), notes: val('notes') || null, crop_year_id: custom ? null : numOrNull('crop_year_id'),
      pattern: val('pattern') || null, heading_deg: val('pattern') === 'straight' ? numOrNull('heading_deg') : null,
      ...(op() === 'harvest' || ev?.harvest_stage ? { harvest_stage: op() === 'harvest' ? val('harvest_stage') || null : null } : {}),
      status,
      ...(custom ? { field_id: null, customer_id: Number(val('customer_id')), location: val('location') || null, lat: gps?.lat ?? null, lng: gps?.lng ?? null,
        custom_rate: numOrNull('custom_rate'), custom_total: numOrNull('custom_rate') != null && numOrNull('c_acres') != null ? Math.round(numOrNull('custom_rate') * numOrNull('c_acres') * 100) / 100 : null }
        : (ev?.customer_id ? { customer_id: null, location: null, lat: null, lng: null, custom_rate: null, custom_total: null } : {})),
    };
    // Freeze the cost with today's rate.
    const cr = workRate(row.operation, row.equipment_id);
    Object.assign(row, { cost_per_acre: cr.rate, cost_basis: cr.basis, cost_total: cr.rate != null && row.acres != null ? Math.round(cr.rate * row.acres * 100) / 100 : null });
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
      // Until the newer SQL files are run, save without those columns rather than failing.
      const write = (r) => (ev ? sb.from('work_events').update(r).eq('event_id', id) : sb.from('work_events').insert(r).select('event_id').single());
      let res = await write(row);
      if (res.error && custom && /customer_id|location|custom_|lat|lng|null value in column "field_id"/.test(res.error.message ?? '')) { toast('Custom work needs custom_work.sql run in Supabase first', true); throw res.error; }
      if (res.error && /status/.test(res.error.message ?? '') && !/check constraint/.test(res.error.message ?? '')) {
        if (status === 'planned') { toast('Planning needs work_plan.sql run in Supabase first', true); throw res.error; }
        delete row.status; res = await write(row);
      }
      if (res.error && /harvest_stage/.test(res.error.message ?? '')) {
        delete row.harvest_stage; res = await write(row);
        if (!res.error) toast('Saved, but the harvest pass needs harvest.sql run in Supabase', true);
      }
      if (res.error && /cost_per_acre|cost_total|cost_basis/.test(res.error.message ?? '')) {
        const { cost_per_acre, cost_total, cost_basis, ...rest } = row;
        res = await write(rest);
      }
      if (res.error && /pattern|heading_deg/.test(res.error.message ?? '')) {
        const { pattern, heading_deg, cost_per_acre, cost_total, cost_basis, ...rest } = row;
        res = await write(rest);
        if (!res.error && !planting && pattern) toast('Saved, but the heading needs work_pattern.sql run in Supabase', true);
      }
      if (res.error) { toast(res.error.message, true); throw res.error; }
      if (!ev) id = res.data.event_id;
      if (planting && !custom) {
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

// ---- Work tab: Records | Harvest
function workViewTabs() {
  return `<div class="subtabs">${[['records', 'Work records'], ['harvest', 'Harvest & yield']].map(([k, l]) =>
    `<button data-wview="${k}" class="${workState.view === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
}
function wireWorkViewTabs(el) {
  $$('[data-wview]', el).forEach((b) => (b.onclick = () => { workState.view = b.dataset.wview; renderWork(el); }));
}
const lbFmt = (v) => (v == null ? '—' : Math.round(v).toLocaleString());
const sumTickets = (cy) => (cy.harvest_records ?? []).reduce((n, t) => n + Number(t.yield || 0), 0);
const cyAcres = (cy) => (cy.acres != null ? Number(cy.acres) : fieldById(cy.field_id)?.acres != null ? Number(fieldById(cy.field_id).acres) : null);
// Average actual clean-out from settled crops: same variety first, then same crop.
function cleanoutHistory(hist, cropId, variety, exceptId) {
  const settled = hist.filter((h) => h.crop_year_id !== exceptId && h.clean_lb != null && sumTickets(h) > 0 && h.crop_id === cropId);
  const avg = (list) => (list.length ? (list.reduce((n, h) => n + Number(h.clean_lb) / sumTickets(h), 0) / list.length) * 100 : null);
  const sameVar = variety ? settled.filter((h) => norm(h.variety) === norm(variety)) : [];
  if (sameVar.length) return { pct: avg(sameVar), n: sameVar.length, of: variety };
  if (settled.length) return { pct: avg(settled), n: settled.length, of: cropName(cropId) };
  return null;
}
const yieldOf = (cy, hist) => {
  const dirt = sumTickets(cy);
  const h = cleanoutHistory(hist, cy.crop_id, cy.variety, cy.crop_year_id);
  const estPct = cy.est_cleanout_pct != null ? Number(cy.est_cleanout_pct) : h?.pct ?? null;
  const actualPct = cy.clean_lb != null && dirt > 0 ? (Number(cy.clean_lb) / dirt) * 100 : null;
  const clean = cy.clean_lb != null ? Number(cy.clean_lb) : estPct != null && dirt > 0 ? dirt * estPct / 100 : null;
  return { dirt, estPct, estFromHistory: cy.est_cleanout_pct == null && h != null, actualPct, clean, settled: cy.clean_lb != null, hist: h };
};

async function renderHarvest(el) {
  const s = workState;
  const sel = 'crop_year_id, field_id, crop_id, variety, season, sequence, acres, status, grown_by, planting_date, multi_year, end_season, est_cleanout_pct, clean_lb, settled_on, settlement_ref, harvest_notes, harvest_records(*)';
  const [{ data, error }, histRes, passRes] = await Promise.all([
    sb.from('crop_years').select(sel).eq('season', s.season),
    sb.from('crop_years').select('crop_year_id, crop_id, variety, clean_lb, harvest_records(yield)').not('clean_lb', 'is', null),
    sb.from('work_events').select('event_id, field_id, crop_year_id, performed_on, harvest_stage, operation').eq('operation', 'harvest').gte('performed_on', `${s.season}-01-01`).lte('performed_on', `${s.season + 1}-06-30`),
  ]);
  if (error) {
    el.innerHTML = `${workViewTabs()}<div class="empty">Harvest isn't set up yet. Run <b>harvest.sql</b> in Supabase first.</div>`;
    wireWorkViewTabs(el); return;
  }
  const hist = histRes.data ?? [];
  const passes = passRes.data ?? [];
  const term = s.q.trim().toLowerCase();
  const crops = data.filter((c) => !c.grown_by && (!term || fieldName(c.field_id).toLowerCase().includes(term) || cropName(c.crop_id).toLowerCase().includes(term)))
    .sort((a, b) => fieldsInOrder().findIndex((f) => f.field_id === a.field_id) - fieldsInOrder().findIndex((f) => f.field_id === b.field_id) || a.sequence - b.sequence);
  const passesFor = (cy) => passes.filter((p) => p.crop_year_id === cy.crop_year_id || (!p.crop_year_id && p.field_id === cy.field_id && autoCropYear('harvest', p.performed_on, data.filter((c) => c.field_id === cy.field_id))?.crop_year_id === cy.crop_year_id));
  el.innerHTML = `
    ${workViewTabs()}
    <div class="section-head"><h2>Harvest & yield</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous year">‹</button>
        <strong class="season">${s.season}</strong>
        <button data-season="1" aria-label="Next year">›</button>
      </div></div>
    <div class="filters"><input type="search" data-f="q" placeholder="Search field or crop…" value="${esc(s.q)}"></div>
    <p class="muted small">Dirt = scale tickets. Clean = settlement, or an estimate (<i>est.</i>) from the clean-out % until the settlement comes in.</p>
    ${crops.length ? `<div class="card table-wrap"><table class="harvest-table m-cards">
      <thead><tr><th>Field</th><th>Crop</th><th>Passes</th><th class="r">Dirt lb</th><th class="r">Clean-out</th><th class="r">Clean lb</th><th class="r">Clean lb/ac</th><th></th></tr></thead>
      <tbody>${crops.map((cy) => {
        const y = yieldOf(cy, hist), ac = cyAcres(cy), ps = passesFor(cy);
        const tickets = (cy.harvest_records ?? []).length;
        return `<tr><td><b>${esc(fieldName(cy.field_id))}</b></td>
          <td>${esc(cropName(cy.crop_id))}${cy.variety ? `<div class="muted small">${esc(cy.variety)}</div>` : ''}</td>
          <td class="small">${ps.length ? esc([...new Set(ps.map((p) => stageName(p.harvest_stage) || 'Harvest'))].join(', ')) : '<span class="muted">—</span>'}</td>
          <td class="r">${y.dirt ? lbFmt(y.dirt) : '—'}${tickets ? `<div class="muted small">${tickets} ticket${tickets > 1 ? 's' : ''}</div>` : ''}</td>
          <td class="r">${y.actualPct != null ? `<b>${y.actualPct.toFixed(1)}%</b>` : y.estPct != null ? `${y.estPct.toFixed(1)}% <i class="muted">est.</i>` : '—'}</td>
          <td class="r">${y.clean != null ? (y.settled ? `<b>${lbFmt(y.clean)}</b>` : `${lbFmt(y.clean)} <i class="muted">est.</i>`) : '—'}</td>
          <td class="r">${y.clean != null && ac ? `${lbFmt(y.clean / ac)}${y.settled ? '' : ' <i class="muted">est.</i>'}` : '—'}</td>
          <td class="r"><button class="small" data-open="${cy.crop_year_id}">Open</button></td></tr>`;
      }).join('')}</tbody></table></div>` : `<div class="empty">No crops entered for ${s.season}.</div>`}`;
  const reload = () => renderHarvest(el);
  wireWorkViewTabs(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $$('[data-f]', el).forEach((inp) => { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { s.q = inp.value; reload(); }, 300); }; });
  $$('[data-open]', el).forEach((b) => (b.onclick = () => openHarvest(Number(b.dataset.open), reload)));
}

async function openHarvest(cropYearId, onDone) {
  const sel = 'crop_year_id, field_id, crop_id, variety, season, sequence, acres, planting_date, multi_year, end_season, est_cleanout_pct, clean_lb, settled_on, settlement_ref, harvest_notes, harvest_records(*)';
  const [[cy], hist] = await Promise.all([
    q(sb.from('crop_years').select(sel).eq('crop_year_id', cropYearId)),
    q(sb.from('crop_years').select('crop_year_id, crop_id, variety, clean_lb, harvest_records(yield)').not('clean_lb', 'is', null)),
  ]);
  const cys = (await sb.from('crop_years').select('crop_year_id, field_id, crop_id, variety, season, sequence, planting_date, multi_year, end_season').eq('field_id', cy.field_id)).data ?? [];
  const passes = ((await sb.from('work_events').select('*').eq('field_id', cy.field_id).eq('operation', 'harvest')
    .gte('performed_on', `${cy.season}-01-01`).lte('performed_on', `${cy.season + 1}-06-30`).order('performed_on')).data ?? [])
    .filter((p) => p.crop_year_id === cy.crop_year_id || (!p.crop_year_id && autoCropYear('harvest', p.performed_on, cys)?.crop_year_id === cy.crop_year_id));
  const tickets = [...(cy.harvest_records ?? [])].sort((a, b) => String(a.harvested_on).localeCompare(String(b.harvested_on)) || a.harvest_id - b.harvest_id);
  const ac = cyAcres(cy);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  const reopen = () => openHarvest(cropYearId, onDone);
  const draw = () => {
    const y = yieldOf({ ...cy, harvest_records: tickets }, hist);
    dlg.innerHTML = `<form class="form harvest-form">
      <div class="dialog-head"><h3>Harvest · ${esc(fieldName(cy.field_id))}</h3>
        <p class="muted small">${esc(cyName(cy))}${ac ? ` · ${num(ac, 1)} ac` : ''}</p></div>

      <div class="lines-head"><b>Harvest passes</b><button type="button" class="small" data-act="add-pass">+ Log pass</button></div>
      ${passes.length ? `<ul class="list">${passes.map((p) => `<li><span class="li-name"><b>${esc(stageName(p.harvest_stage) || 'Harvest')}</b>
        <span class="muted small">${esc([dateRange(p.performed_on, p.end_date), [equipName(p.tractor_id), equipName(p.equipment_id)].filter(Boolean).join(' + '), operatorName(p.performed_by)].filter(Boolean).join(' · '))}</span></span>
        <span class="li-value"><button type="button" class="small" data-pass="${p.event_id}">Open</button></span></li>`).join('')}</ul>`
        : '<p class="muted small">None yet. Log each pass (swath/cut, merge/lift, combine/thresh) with its machine and operator.</p>'}

      <div class="lines-head"><b>Scale tickets</b><span class="muted small">"In the dirt" pounds</span></div>
      <div class="table-wrap"><table class="tickets">
        <thead><tr><th>Date</th><th>Ticket #</th><th class="r">Lb</th><th></th></tr></thead>
        <tbody>${tickets.map((t) => `<tr><td>${esc(t.harvested_on ?? '')}</td><td>${esc(t.ticket_no ?? '')}</td><td class="r">${lbFmt(t.yield)}</td>
          <td class="r"><button type="button" class="icon" data-del-ticket="${t.harvest_id}" aria-label="Delete ticket">✕</button></td></tr>`).join('')}
          <tr class="ticket-new"><td><input type="date" name="t_date" value="${esc(tickets.at(-1)?.harvested_on ?? localDate())}"></td>
            <td><input name="t_no" placeholder="#"></td>
            <td><input type="number" inputmode="decimal" step="any" min="0" name="t_lb" placeholder="lb"></td>
            <td><button type="button" class="small primary" data-act="add-ticket">Add</button></td></tr>
        </tbody>
        <tfoot><tr><td colspan="2"><b>Total in the dirt</b></td><td class="r"><b>${lbFmt(y.dirt)}</b></td><td></td></tr>
          ${ac && y.dirt ? `<tr><td colspan="2" class="muted">per acre</td><td class="r muted">${lbFmt(y.dirt / ac)}</td><td></td></tr>` : ''}</tfoot>
      </table></div>

      <div class="lines-head"><b>Clean-out</b></div>
      <div class="row2">
        <label>Estimated clean-out (%)<input type="number" inputmode="decimal" step="any" min="0" max="100" name="est_cleanout_pct" value="${esc(cy.est_cleanout_pct ?? '')}" placeholder="${y.hist ? y.hist.pct.toFixed(1) : ''}"></label>
        <div class="hv-est">${y.estPct != null && y.dirt ? `Estimated clean: <b>${lbFmt(y.dirt * y.estPct / 100)} lb</b>${ac ? ` · ${lbFmt(y.dirt * y.estPct / 100 / ac)} lb/ac` : ''}` : ''}</div>
      </div>
      <p class="muted small">${y.hist ? `Your history: <b>${y.hist.pct.toFixed(1)}%</b> average on ${y.hist.n} settled field${y.hist.n > 1 ? 's' : ''} of ${esc(y.hist.of)}.${cy.est_cleanout_pct == null ? ' Used as the estimate until you enter one.' : ''}` : 'No settled history for this crop yet. Each settlement you enter builds it.'}</p>

      <div class="lines-head"><b>Settlement</b><span class="muted small">Net clean pounds you're paid on</span></div>
      <div class="row2">
        <label>Clean lb<input type="number" inputmode="decimal" step="any" min="0" name="clean_lb" value="${esc(cy.clean_lb ?? '')}"></label>
        <label>Settled on<input type="date" name="settled_on" value="${esc(cy.settled_on ?? '')}"></label>
      </div>
      <label>Lot / settlement #<input name="settlement_ref" value="${esc(cy.settlement_ref ?? '')}"></label>
      <p class="hv-actual" id="hv-actual"></p>
      <label>Notes<textarea name="harvest_notes" rows="2">${esc(cy.harvest_notes ?? '')}</textarea></label>
      <div class="actions"><span class="spacer"></span>
        <button type="button" data-act="cancel">Close</button>
        <button type="submit" class="primary">Save</button></div>
    </form>`;
    const form = $('form', dlg), el = form.elements;
    const showActual = () => {
      const clean = Number(el.clean_lb.value);
      const est = el.est_cleanout_pct.value === '' ? y.hist?.pct ?? null : Number(el.est_cleanout_pct.value);
      const box = $('#hv-actual', dlg);
      if (clean > 0 && y.dirt > 0) {
        const pct = (clean / y.dirt) * 100;
        box.innerHTML = `Actual clean-out <b>${pct.toFixed(1)}%</b>${ac ? ` · <b>${lbFmt(clean / ac)}</b> clean lb/ac` : ''}${est != null ? ` <span class="muted">(estimate was ${est.toFixed(1)}%, ${pct - est >= 0 ? '+' : ''}${(pct - est).toFixed(1)} pts)</span>` : ''}`;
      } else box.innerHTML = clean > 0 ? '<span class="muted">Add scale tickets to work out the clean-out %.</span>' : '';
    };
    el.clean_lb.oninput = showActual; el.est_cleanout_pct.oninput = showActual; showActual();
    $('[data-act=cancel]', dlg).onclick = () => dlg.close();
    // Opening a pass leaves this dialog, so save what's typed here first.
    const patchNow = () => {
      const n = (k) => (el[k].value === '' ? null : Number(el[k].value));
      return { est_cleanout_pct: n('est_cleanout_pct'), clean_lb: n('clean_lb'), settled_on: el.settled_on.value || null,
        settlement_ref: el.settlement_ref.value.trim() || null, harvest_notes: el.harvest_notes.value.trim() || null };
    };
    const saveQuiet = async () => { try { await q(sb.from('crop_years').update(patchNow()).eq('crop_year_id', cy.crop_year_id)); } catch { /* shown */ } };
    $('[data-act=add-pass]', dlg).onclick = async () => { await saveQuiet(); openWorkForm({ operation: 'harvest', fieldId: cy.field_id, cropYearId: cy.crop_year_id,
      stage: ['swath', 'merge', 'thresh'].find((st) => !passes.some((p) => p.harvest_stage === st)) ?? 'other' }, () => { onDone?.(); reopen(); }); };
    $$('[data-pass]', dlg).forEach((b) => (b.onclick = async () => { await saveQuiet(); openWorkForm({ eventId: Number(b.dataset.pass) }, () => { onDone?.(); reopen(); }); }));
    $('[data-act=add-ticket]', dlg).onclick = async () => {
      const lb = Number(el.t_lb.value);
      if (!(lb > 0)) { toast('Enter the pounds on the ticket', true); el.t_lb.focus(); return; }
      try {
        const [t] = await q(sb.from('harvest_records').insert({ crop_year_id: cy.crop_year_id, harvested_on: el.t_date.value || localDate(), yield: lb, unit: 'lb',
          ticket_no: el.t_no.value.trim() || null, stage: 'ticket' }).select('*'));
        tickets.push(t); stash(); draw(); onDone?.();
        $('input[name=t_lb]', dlg).focus();
      } catch { /* shown */ }
    };
    el.t_lb.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-act=add-ticket]', dlg).click(); } };
    $$('[data-del-ticket]', dlg).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this ticket?')) return;
      try { await q(sb.from('harvest_records').delete().eq('harvest_id', Number(b.dataset.delTicket))); tickets.splice(tickets.findIndex((t) => t.harvest_id === Number(b.dataset.delTicket)), 1); stash(); draw(); onDone?.(); } catch { /* shown */ }
    }));
    // Keep unsaved settlement typing across redraws (adding a ticket redraws).
    const stash = () => { ['est_cleanout_pct', 'clean_lb', 'settled_on', 'settlement_ref', 'harvest_notes'].forEach((k) => { cy[k] = el[k].value === '' ? null : el[k].value; }); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const patch = patchNow();
      try { await q(sb.from('crop_years').update(patch).eq('crop_year_id', cy.crop_year_id)); dlg.close(); toast('Saved'); onDone?.(); } catch { /* shown */ }
    };
  };
  draw();
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// The crop year's planting date = the earliest planting record's start date.
async function syncPlantingDate(cropYearId) {
  if (!cropYearId) return;
  // Planned plantings don't count.
  let res = await sb.from('work_events').select('performed_on').eq('crop_year_id', cropYearId).eq('operation', 'planting').neq('status', 'planned').order('performed_on').limit(1);
  if (res.error) res = await sb.from('work_events').select('performed_on').eq('crop_year_id', cropYearId).eq('operation', 'planting').order('performed_on').limit(1);
  const recs = res.data ?? [];
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
        <span class="muted small">${esc([equipName(r.equipment_id), d.seed_lot && 'lot ' + d.seed_lot, act != null && rateFmt(act, (d.seed_used_unit ?? 'lb') + '/ac'), patText(r, d)].filter(Boolean).join(' · '))}</span></span>
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
      ...(refs.appRates.length ? (() => { const r = appRate(method, method === 'spray' ? val('sprayer_id') : null); return { app_cost_per_acre: r.rate, app_cost_basis: r.basis }; })() : {}),
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
          ...(refs.appRates.length ? (() => { const r = appRate(load.method, load.sprayer_id); return { app_cost_per_acre: r.rate, app_cost_basis: r.basis }; })() : {}),
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
// Types in a category: the standard ones for it plus any in use there. No category = every type.
function typesInCategory(cat) {
  const all = equipTypeOptions().map(([t]) => t);
  const inUse = new Set(refs.equipment.filter((e) => !cat || eqCat(e) === cat).map((e) => (e.type ?? '').trim().toLowerCase()));
  return all.filter((t) => !cat || eqCat({ type: t }) === cat || inUse.has(t.toLowerCase()));
}
// Equipment types for the dropdown, in number-band order; any other type already in use is kept.
const EQ_TYPES = ['Tractor', 'Combine', 'Swather / windrower', 'Sprayer', 'Pickup', 'Truck', 'Trailer', 'Loader', 'Forklift', 'Scraper', 'Blade',
  'Disk', 'Disk ripper', 'Ripper', 'Plough', 'Rototiller', 'Packer', 'Skewtreader', 'Shredder', 'Planter', 'Drill',
  'Cultivator', 'Corrugator', 'Dammer-diker', 'Toolbar', 'Bean cutter', 'Other', 'Pivot', 'Solid set', 'Handline', 'Pump', 'Mainline', 'Well', 'Building'];
function equipTypeOptions() {
  const used = refs.equipment.map((e) => (e.type ?? '').trim()).filter(Boolean);
  const extra = [...new Set(used.filter((t) => !EQ_TYPES.some((x) => x.toLowerCase() === t.toLowerCase())))].sort();
  return [...EQ_TYPES, ...extra].map((t) => [t, t]);
}
// New equipment while a category filter is on: only that category's types in the Type dropdown.
function narrowTypeChoices(form, row) {
  const cat = CRUD.equipment.state?.f?.cat, sel = form.elements.type;
  if (row || !cat || !sel) return;
  const keep = new Set(typesInCategory(cat).map((t) => t.toLowerCase()));
  [...sel.options].forEach((o) => { if (o.value && !keep.has(o.value.toLowerCase())) o.remove(); });
}
// Type-specific parts of the equipment form show only for the types they apply to.
const ENGINE_RE = /tractor|combine|swather|windrower|sprayer|pickup|truck|loader|forklift|scraper|blade|excavat|backhoe|skid/i;
const IRRIG_RE = /pivot|solid ?set|handline|hand line|wheel ?line|pump|mainline|well/i;
const TYPE_FIELDS = [
  [/pump/i, ['hp', 'frame_size', 'meter_no', 'vfd']],
  [/planter|drill/i, ['planting_settings']],
  [/disk|ripper|plough|plow|rototill|packer|skewtread|shredder|harrow|planter|drill|cultivat|corrugat|dammer|toolbar|bedder|bean cutter|header|digger|combine|swather|windrower|sprayer|implement/i, ['cost_per_acre']],
  [ENGINE_RE, ['hours', 'hours_date', 'engine_serial']],
  [/pickup|truck|trailer/i, ['license_plate']],
];
function typeOnlyFields(form, row) {
  const typeIn = form.elements.type;
  const sync = () => {
    const t = typeIn?.value ?? '';
    for (const [re, keys] of TYPE_FIELDS) {
      keys.filter((k) => form.elements[k]).forEach((k) => {
        const el = form.elements[k], has = el.type === 'checkbox' ? el.checked : String(el.value ?? '').trim() !== '';
        const show = re.test(t) || (has && !!row && t === (row.type ?? ''));   // keep showing data an existing record already has
        el.closest('label').hidden = !show;
      });
    }
    const fieldsBox = form.parentElement?.querySelector('.eq-fields') ?? $('.eq-fields', form);
    if (fieldsBox) fieldsBox.hidden = !IRRIG_RE.test(t) && !fieldsBox.dataset.linked;
    const workBox = $('.eq-work', form);
    if (workBox) workBox.hidden = !t || IRRIG_RE.test(t) || /building|shop|shed/i.test(t);
  };
  typeIn?.addEventListener('input', sync); typeIn?.addEventListener('change', sync);
  sync();
  return sync;
}
// Suggest the next free number for the type typed in.
function equipmentNumberHint(form, row) {
  const inp = form.elements.unit_no, typeIn = form.elements.type;
  if (!inp) return;
  const hint = document.createElement('p'); hint.className = 'muted small form-hint';
  inp.closest('label').after(hint);
  const draw = () => {
    if (eqNum(row) != null && String(inp.value).trim() === String(row.unit_no).trim()) { hint.textContent = ''; return; }
    const start = TYPE_BAND.find(([re]) => re.test(typeIn?.value ?? ''))?.[1] ?? 600;
    const n = nextFreeNumber(start);
    const sub = Object.values(EQ_SUBS).flat().find(([, lo]) => lo === start)?.[0] ?? EQ_BANDS.find(([, , b]) => b === Math.floor(start / 100) * 100)?.[1];
    hint.innerHTML = n ? `Next free ${esc(sub)} number: <button type="button" class="link">${n}</button>` : `The ${esc(sub)} range is full.`;
    $('button', hint)?.addEventListener('click', () => { inp.value = n; draw(); });
  };
  typeIn?.addEventListener('input', draw); typeIn?.addEventListener('change', draw); inp.addEventListener('input', draw); draw();
}

// Fields a pivot / pump / well serves.
async function equipmentFieldLinks(form, row) {
  const box = document.createElement('details');
  box.className = 'eq-fields';
  form.querySelector('.actions').before(box);
  if (!row) return box.remove();
  const res = await sb.from('equipment_fields').select('field_id').eq('equipment_id', row.equipment_id);
  if (res.error) return box.remove();
  const have = new Set(res.data.map((x) => x.field_id));
  if (have.size) box.dataset.linked = '1';
  const irr = eqCat(row) === 'irrigation';
  box.open = irr || have.size > 0;
  box.innerHTML = `<summary><b>Fields it serves</b> <span class="muted small">${have.size ? [...have].map((id) => esc(fieldById(id)?.name ?? '')).join(', ') : irr ? 'none yet' : 'pivots, pumps, wells'}</span></summary>
    <div class="chips">${fieldsInOrder().filter((f) => f.active || have.has(f.field_id)).map((f) => `<label class="chip-toggle"><input type="checkbox" value="${f.field_id}" ${have.has(f.field_id) ? 'checked' : ''}><span>${esc(f.name)}</span></label>`).join('')}</div>`;
  $$('input', box).forEach((c) => (c.onchange = async () => {
    try {
      if (c.checked) await q(sb.from('equipment_fields').insert({ equipment_id: row.equipment_id, field_id: Number(c.value) }));
      else await q(sb.from('equipment_fields').delete().eq('equipment_id', row.equipment_id).eq('field_id', Number(c.value)));
      loadRefs();
    } catch { c.checked = !c.checked; }
  }));
}

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

// =====================================================================
// Maintenance & repair: open problems, service due, history.
// Pivots, pumps, wells, mainlines and buildings are equipment rows too.
// =====================================================================
const maintState = { view: 'repairs', q: '', equip: '', cat: '', season: new Date().getFullYear() };
const JOB_STATUS = [['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done']];
const jobStatusName = (k) => JOB_STATUS.find(([x]) => x === k)?.[1] ?? k;
const addMonths = (iso, m) => { const d = new Date(iso + 'T12:00'); d.setMonth(d.getMonth() + Number(m)); return localDate(d); };
const fmtDateY = (iso) => (iso ? new Date(iso + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// When an interval is next due, from the last time it was done (or where tracking started).
function serviceDue(iv, eq, jobs) {
  const last = jobs.filter((j) => j.interval_id === iv.interval_id && j.status === 'done')
    .sort((a, b) => String(b.completed_on ?? '').localeCompare(String(a.completed_on ?? '')) || (b.hours_at ?? 0) - (a.hours_at ?? 0))[0];
  const baseHrs = last?.hours_at ?? iv.start_hours;
  const baseDate = last?.completed_on ?? iv.start_date;
  const curHrs = eq?.hours != null ? Number(eq.hours) : null;
  const dueHrs = iv.every_hours != null && baseHrs != null ? Number(baseHrs) + Number(iv.every_hours) : null;
  const leftHrs = dueHrs != null && curHrs != null ? dueHrs - curHrs : null;
  const dueDate = iv.every_months != null && baseDate ? addMonths(baseDate, iv.every_months) : null;
  const daysLeft = dueDate ? Math.round((new Date(dueDate + 'T12:00') - new Date(localDate() + 'T12:00')) / 864e5) : null;
  const over = (leftHrs != null && leftHrs <= 0) || (daysLeft != null && daysLeft <= 0);
  const soon = !over && ((leftHrs != null && leftHrs <= Math.max(25, Number(iv.every_hours) * 0.1)) || (daysLeft != null && daysLeft <= 30));
  const unknown = dueHrs == null && dueDate == null;
  return { last, dueHrs, leftHrs, curHrs, dueDate, daysLeft, state: unknown ? 'unknown' : over ? 'over' : soon ? 'soon' : 'ok' };
}
function dueText(d, iv, eq) {
  const parts = [];
  if (d.dueHrs != null) parts.push(d.leftHrs == null ? `due at ${num(d.dueHrs, 0)} hrs (no current hours)` : d.leftHrs <= 0 ? `<b>${num(-d.leftHrs, 0)} hrs over</b> (due ${num(d.dueHrs, 0)})` : `${num(d.leftHrs, 0)} hrs left (due ${num(d.dueHrs, 0)})`);
  else if (iv.every_hours != null) parts.push('enter the hours it was last done');
  if (d.dueDate) parts.push(d.daysLeft <= 0 ? `<b>${-d.daysLeft} days over</b> (${fmtDateY(d.dueDate)})` : `due ${fmtDateY(d.dueDate)}`);
  if (d.dueHrs != null && eq?.hours_date) parts.push(`<span class="muted">hours as of ${fmtDateY(eq.hours_date)}</span>`);
  return parts.join(' · ');
}
const everyText = (iv) => [iv.every_hours != null && `every ${num(iv.every_hours, 0)} hrs`, iv.every_months != null && `every ${iv.every_months} mo`].filter(Boolean).join(' or ');

const maintTabs = (labels = {}) => `<div class="subtabs">${[['repairs', 'Repairs'], ['service', 'Service due'], ['history', 'History'], ['tasks', 'Seasonal tasks']]
  .map(([k, l]) => `<button data-mview="${k}" class="${maintState.view === k ? 'active' : ''}">${labels[k] ?? l}</button>`).join('')}</div>`;
async function renderMaint(el) {
  const s = maintState;
  if (s.view === 'tasks') return renderSeasonal(el);
  const [jobsRes, ivRes] = await Promise.all([
    sb.from('maint_jobs').select('*, maint_photos(photo_id, kind)').order('reported_on', { ascending: false }).order('job_id', { ascending: false }),
    sb.from('service_intervals').select('*').eq('active', true),
  ]);
  if (jobsRes.error) { el.innerHTML = '<div class="empty">Maintenance isn’t set up yet. Run <b>maintenance.sql</b> in Supabase first.</div>'; return; }
  await loadRefs();
  const jobs = jobsRes.data, ivs = ivRes.data ?? [];
  const eqById = (id) => refs.equipment.find((e) => e.equipment_id === id);
  const term = s.q.trim().toLowerCase();
  const eqOf = (id) => refs.equipment.find((e) => e.equipment_id === id);
  const match = (eqId, text = '') => (!s.equip || Number(s.equip) === eqId) && (!s.cat || eqCat(eqOf(eqId)) === s.cat)
    && (!term || `${eqOf(eqId) ? eqLabel(eqOf(eqId)) : ''} ${text}`.toLowerCase().includes(term));
  const open = jobs.filter((j) => j.status !== 'done' && match(j.equipment_id, j.title))
    .sort((a, b) => Number(b.down) - Number(a.down) || (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0) || a.reported_on.localeCompare(b.reported_on));
  const dues = ivs.filter((iv) => match(iv.equipment_id, iv.name) && eqById(iv.equipment_id)?.active !== false)
    .map((iv) => ({ iv, eq: eqById(iv.equipment_id), d: serviceDue(iv, eqById(iv.equipment_id), jobs) }));
  const rank = { over: 0, soon: 1, unknown: 2, ok: 3 };
  dues.sort((a, b) => rank[a.d.state] - rank[b.d.state] || (a.d.leftHrs ?? 1e9) - (b.d.leftHrs ?? 1e9) || String(a.d.dueDate ?? '9').localeCompare(String(b.d.dueDate ?? '9')));
  const nOver = dues.filter((x) => x.d.state === 'over').length, nSoon = dues.filter((x) => x.d.state === 'soon').length;
  const done = jobs.filter((j) => j.status === 'done' && (j.completed_on ?? j.reported_on).startsWith(String(s.season)) && match(j.equipment_id, j.title));
  const eqOpts = refs.equipment.filter((e) => (e.active || jobs.some((j) => j.equipment_id === e.equipment_id)) && (!s.cat || eqCat(e) === s.cat)).sort(eqSort);
  const photoN = (j, k) => (j.maint_photos ?? []).filter((p) => p.kind === k).length;

  el.innerHTML = `
    ${maintTabs({ repairs: `Repairs${open.length ? ` (${open.length})` : ''}`, service: `Service due${nOver ? ` (${nOver} over)` : nSoon ? ` (${nSoon} soon)` : ''}` })}
    <div class="section-head"><h2>${{ repairs: 'Repairs', service: 'Service due', history: 'Maintenance history' }[s.view]}</h2>
      <div class="row">
        ${s.view === 'history' ? `<button data-season="-1" aria-label="Previous year">‹</button><strong class="season">${s.season}</strong><button data-season="1" aria-label="Next year">›</button>` : ''}
        <button data-act="scan">Scan QR</button>
        ${s.view === 'service' ? '<button data-act="add-iv">+ Interval</button>' : ''}
        <button class="primary" data-act="report">${s.view === 'service' ? 'Log service' : s.view === 'history' ? 'Log work done' : 'Report a problem'}</button>
      </div></div>
    <div class="filters">
      <input type="search" data-f="q" placeholder="Search equipment or job…" value="${esc(s.q)}">
      <select data-f="cat"><option value="">All categories</option>${EQ_BANDS.filter(([k]) => refs.equipment.some((e) => eqCat(e) === k)).map(([k, l, b]) => `<option value="${k}" ${s.cat === k ? 'selected' : ''}>${b}s · ${esc(l)}</option>`).join('')}</select>
      <select data-f="equip"><option value="">All ${s.cat ? esc(EQ_BANDS.find(([k]) => k === s.cat)[1].toLowerCase()) : 'equipment'}</option>${eqOpts.map((e) => `<option value="${e.equipment_id}" ${Number(s.equip) === e.equipment_id ? 'selected' : ''}>${esc(eqLabel(e))}</option>`).join('')}</select>
    </div>
    ${s.view === 'repairs' ? (open.length ? `<ul class="list job-list card">${open.map((j) => `<li class="${j.down ? 'down' : ''}">
        <span class="li-name"><b>${esc(j.title)}</b> ${j.down ? '<span class="badge bad">DOWN</span>' : ''} <span class="badge ${j.status === 'in_progress' ? 'up' : ''}">${jobStatusName(j.status)}</span>
          <span class="muted small">${esc(eqOf(j.equipment_id) ? eqLabel(eqOf(j.equipment_id)) : '')} · reported ${fmtDateY(j.reported_on)}${j.reported_by || j.reported_by_email ? ' by ' + esc(operatorName(j.reported_by) || j.reported_by_email) : ''}${photoN(j, 'problem') ? ` · 📷 ${photoN(j, 'problem')}` : ''}</span></span>
        <span class="li-value"><button class="small" data-job="${j.job_id}">Open</button></span></li>`).join('')}</ul>`
      : '<div class="empty">No open repairs.</div>') : ''}
    ${s.view === 'service' ? (dues.length ? `<ul class="list job-list card">${dues.map(({ iv, eq, d }) => `<li class="due-${d.state}">
        <span class="li-name"><b>${esc(eq ? eqLabel(eq) : '?')}</b> · ${esc(iv.name)} <span class="muted small">${everyText(iv)}</span>
          <span class="small">${d.state === 'over' ? '<span class="badge bad">Overdue</span> ' : d.state === 'soon' ? '<span class="badge warn">Due soon</span> ' : ''}${dueText(d, iv, eq)}</span></span>
        <span class="li-value"><button class="small" data-iv="${iv.interval_id}">Edit</button> <button class="small primary" data-svc="${iv.interval_id}">Done</button></span></li>`).join('')}</ul>`
      : '<div class="empty">No service intervals yet. Add one with <b>+ Interval</b>, or from a machine under Setup → Equipment.</div>') : ''}
    ${s.view === 'history' ? (done.length ? `<p class="muted small">${done.length} job(s) in ${s.season}${done.some((j) => j.cost != null) ? ` · total <b>${money(done.reduce((n, j) => n + Number(j.cost || 0), 0))}</b>` : ''}</p>
      <div class="card table-wrap"><table class="m-cards"><thead><tr><th>Date</th><th>Equipment</th><th>Job</th><th class="r">Hours</th><th class="r">Cost</th><th></th></tr></thead><tbody>
      ${done.map((j) => `<tr><td class="nowrap">${fmtDateY(j.completed_on ?? j.reported_on)}</td><td>${esc(eqOf(j.equipment_id) ? eqLabel(eqOf(j.equipment_id)) : '')}</td>
        <td>${esc(j.title)} <span class="muted small">${j.kind === 'service' ? 'service' : 'repair'}${photoN(j, 'invoice') ? ' · 🧾' : ''}</span></td>
        <td class="r">${j.hours_at != null ? num(j.hours_at, 0) : ''}</td><td class="r">${money(j.cost)}</td>
        <td class="r"><button class="small" data-job="${j.job_id}">Open</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">Nothing finished in ${s.season}.</div>`) : ''}`;
  const reload = () => renderMaint(el);
  wireMaintTabs(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $$('[data-f]', el).forEach((inp) => {
    if (inp.type === 'search') { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { s.q = inp.value; reload(); }, 300); }; }
    else inp.onchange = () => { if (inp.dataset.f === 'cat') { s.cat = inp.value; s.equip = ''; } else s.equip = inp.value; reload(); };
  });
  $('[data-act=report]', el).onclick = () => openJob(s.view === 'service' ? { kind: 'service', status: 'done', equipmentId: Number(s.equip) || null }
    : s.view === 'history' ? { status: 'done', equipmentId: Number(s.equip) || null } : { equipmentId: Number(s.equip) || null }, reload);
  $('[data-act=add-iv]', el)?.addEventListener('click', () => openInterval({ equipmentId: Number(s.equip) || null }, reload));
  $('[data-act=scan]', el).onclick = () => openScanner();
  $$('[data-job]', el).forEach((b) => (b.onclick = () => openJob({ jobId: Number(b.dataset.job) }, reload)));
  $$('[data-iv]', el).forEach((b) => (b.onclick = () => openInterval({ intervalId: Number(b.dataset.iv) }, reload)));
  $$('[data-svc]', el).forEach((b) => (b.onclick = () => {
    const iv = ivs.find((x) => x.interval_id === Number(b.dataset.svc));
    openJob({ kind: 'service', status: 'done', equipmentId: iv.equipment_id, intervalId: iv.interval_id, title: iv.name }, reload);
  }));
}

// opts: { jobId } to edit; or { equipmentId, kind, status, intervalId, title } for a new job
async function openJob(opts, onDone) {
  let j = null;
  if (opts.jobId) [j] = await q(sb.from('maint_jobs').select('*').eq('job_id', opts.jobId));
  const v = j ?? { kind: opts.kind ?? 'repair', status: opts.status ?? 'open', equipment_id: opts.equipmentId ?? null, interval_id: opts.intervalId ?? null,
    title: opts.title ?? '', reported_on: localDate(), completed_on: opts.status === 'done' ? localDate() : null, down: false };
  const ivs = (await sb.from('service_intervals').select('*').eq('active', true)).data ?? [];
  // Whoever is signed in is the reporter on a new record; an existing record keeps its reporter.
  const me = await myOperator();
  const reporter = j ? (operatorName(j.reported_by) || j.reported_by_email || '—') : (me?.name ?? myEmail ?? '—');
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form job-form">
    <div class="dialog-head"><h3>${j ? (v.kind === 'service' ? 'Service' : 'Repair') : v.kind === 'service' ? 'Log service' : v.status === 'done' ? 'Log work done' : 'Report a problem'}</h3></div>
    ${equipPickerHtml('equipment_id', v.equipment_id)}
    <div class="row2">
      <label>Type<select name="kind"><option value="repair" ${v.kind === 'repair' ? 'selected' : ''}>Repair</option><option value="service" ${v.kind === 'service' ? 'selected' : ''}>Scheduled service</option></select></label>
    </div>
    <label data-svc-only>Service interval<select name="interval_id"></select></label>
    <label>What's wrong / what was done *<input name="title" required value="${esc(v.title ?? '')}" placeholder="e.g. Hydraulic leak at rear remote"></label>
    <label>Details<textarea name="description" rows="2">${esc(v.description ?? '')}</textarea></label>
    <label class="check"><input type="checkbox" name="down" ${v.down ? 'checked' : ''}> Down — can't be used until fixed</label>
    <div class="row2">
      <label>Status<select name="status">${JOB_STATUS.map(([k, l]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="ro-field"><span>Reported by</span><b>${esc(reporter)}</b></div>
    </div>
    <div class="row2">
      <label>Reported on<input type="date" name="reported_on" value="${esc(v.reported_on ?? '')}"></label>
      <label data-done-only>Completed on<input type="date" name="completed_on" value="${esc(v.completed_on ?? '')}"></label>
    </div>
    <fieldset class="plant-box" data-done-only><legend>Completed</legend>
      <div class="row2">
        <label>Fixed / serviced by<input name="done_by" value="${esc(v.done_by ?? '')}" placeholder="Shop, dealer, person"></label>
        <label>Machine hours<input type="number" inputmode="decimal" step="0.1" min="0" name="hours_at" value="${esc(v.hours_at ?? '')}"></label>
      </div>
      <div class="row2">
        <label>Total cost ($)<input type="number" inputmode="decimal" step="0.01" min="0" name="cost" value="${esc(v.cost ?? '')}"></label>
        <label>Vendor<input name="vendor" value="${esc(v.vendor ?? '')}"></label>
      </div>
      <label>Invoice #<input name="invoice_no" value="${esc(v.invoice_no ?? '')}"></label>
    </fieldset>
    <label>Notes<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    <div id="job-photos"></div>
    <div class="actions">
      ${j ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div></form>`;
  const form = $('form', dlg), el = form.elements;
  const sync = () => {
    const svc = el.kind.value === 'service', isDone = el.status.value === 'done';
    $$('[data-svc-only]', dlg).forEach((x) => (x.hidden = !svc));
    $$('[data-done-only]', dlg).forEach((x) => (x.hidden = !isDone));
    if (isDone && !el.completed_on.value) el.completed_on.value = localDate();
    const eqId = Number(el.equipment_id.value), cur = Number(el.interval_id.value) || v.interval_id;
    const mine = ivs.filter((iv) => iv.equipment_id === eqId);
    el.interval_id.innerHTML = `<option value="">${mine.length ? '— not a listed interval —' : 'No intervals for this machine'}</option>` + mine.map((iv) => `<option value="${iv.interval_id}" ${iv.interval_id === cur ? 'selected' : ''}>${esc(iv.name)} (${everyText(iv)})</option>`).join('');
    const eq = refs.equipment.find((e) => e.equipment_id === eqId);
    el.hours_at.placeholder = eq?.hours != null ? `last ${num(eq.hours, 0)}` : '';
  };
  const pick = wireEquipPicker(dlg, 'equipment_id', () => sync());
  pick.set(v.equipment_id);
  el.kind.onchange = sync; el.status.onchange = sync;
  el.interval_id.onchange = () => { const iv = ivs.find((x) => x.interval_id === Number(el.interval_id.value)); if (iv && !el.title.value.trim()) el.title.value = iv.name; };
  sync();
  if (j) jobPhotos($('#job-photos', dlg), j);
  else $('#job-photos', dlg).innerHTML = '<p class="muted small">Save first, then add photos of the problem or the invoice.</p>';
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const val = (k) => String(el[k].value).trim();
    const n = (k) => (val(k) === '' ? null : Number(val(k)));
    const isDone = val('status') === 'done';
    const row = {
      equipment_id: Number(val('equipment_id')), kind: val('kind'), interval_id: val('kind') === 'service' ? n('interval_id') : null,
      title: val('title'), description: val('description') || null, down: isDone ? false : el.down.checked, status: val('status'),
      ...(j ? {} : { reported_by: me?.operator_id ?? null, reported_by_email: myEmail || null }), reported_on: val('reported_on') || localDate(), completed_on: isDone ? val('completed_on') || localDate() : null,
      done_by: isDone ? val('done_by') || null : null, hours_at: isDone ? n('hours_at') : null, cost: isDone ? n('cost') : null,
      vendor: isDone ? val('vendor') || null : null, invoice_no: isDone ? val('invoice_no') || null : null, notes: val('notes') || null,
      updated_at: new Date().toISOString(),
    };
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      let id = j?.job_id;
      if (j) await q(sb.from('maint_jobs').update(row).eq('job_id', id));
      else {
        let r = await sb.from('maint_jobs').insert(row).select('job_id').single();
        if (r.error && /reported_by_email/.test(r.error.message ?? '')) { delete row.reported_by_email; r = await sb.from('maint_jobs').insert(row).select('job_id').single(); }
        if (r.error) { toast(r.error.message, true); throw r.error; }
        id = r.data.job_id;
      }
      // Newer hours reading → update the machine's hours.
      const eq = refs.equipment.find((x) => x.equipment_id === row.equipment_id);
      if (row.hours_at != null && (eq?.hours == null || row.hours_at > Number(eq.hours))) {
        await q(sb.from('equipment').update({ hours: row.hours_at, hours_date: row.completed_on }).eq('equipment_id', row.equipment_id));
        await loadRefs();
      }
      toast('Saved'); onDone?.();
      if (!j) openJob({ jobId: id }, onDone); else dlg.close();
    } catch { btn.disabled = false; }
  };
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm('Delete this job and its photos?')) return;
    try {
      const ph = await q(sb.from('maint_photos').select('path').eq('job_id', j.job_id));
      if (ph.length) await sb.storage.from('maintenance').remove(ph.map((p) => p.path));
      await q(sb.from('maint_jobs').delete().eq('job_id', j.job_id));
      dlg.close(); toast('Deleted'); onDone?.();
    } catch { /* shown */ }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

async function jobPhotos(box, job) {
  const draw = async () => {
    const photos = await q(sb.from('maint_photos').select('*').eq('job_id', job.job_id).order('taken_at'));
    const urls = photos.length ? (await sb.storage.from('maintenance').createSignedUrls(photos.map((p) => p.path), 3600)).data ?? [] : [];
    const group = (kind, title, accept) => {
      const list = photos.map((p, i) => ({ p, url: urls[i]?.signedUrl })).filter((x) => x.p.kind === kind);
      return `<div class="lines-head"><b>${title}</b></div><div class="eq-grid">${list.map(({ p, url }) => `<div class="eq-thumb">
        <a href="${esc(url ?? '#')}" target="_blank" rel="noopener">${/\.pdf$/i.test(p.path) ? '<span class="pdf-thumb">PDF</span>' : `<img src="${esc(url ?? '')}" alt="">`}</a>
        <span class="muted small">${esc(new Date(p.taken_at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>
        <button type="button" class="icon" data-rm="${p.photo_id}" aria-label="Delete">✕</button></div>`).join('')}
        <label class="eq-add"><input type="file" accept="${accept}" multiple hidden data-kind="${kind}"><span>＋ Add</span></label></div>`;
    };
    box.innerHTML = group('problem', 'Problem photos', 'image/*') + group('invoice', 'Invoice', 'image/*,application/pdf');
    $$('input[type=file]', box).forEach((inp) => (inp.onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      inp.nextElementSibling.textContent = 'Uploading…';
      try {
        for (const f of files) {
          const isPdf = f.type === 'application/pdf';
          const blob = isPdf ? f : await shrinkImage(f, 2000);
          const ext = isPdf ? 'pdf' : blob.type === 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() || 'img').toLowerCase();
          const path = `${job.equipment_id}/${job.job_id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
          const { error } = await sb.storage.from('maintenance').upload(path, blob, { contentType: blob.type || f.type || 'application/octet-stream' });
          if (error) throw error;
          await q(sb.from('maint_photos').insert({ job_id: job.job_id, path, kind: inp.dataset.kind }));
        }
        toast(files.length > 1 ? `${files.length} files added` : 'Added');
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, true); }
      draw();
    }));
    $$('[data-rm]', box).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this file?')) return;
      const p = photos.find((x) => x.photo_id === Number(b.dataset.rm));
      try { await sb.storage.from('maintenance').remove([p.path]); await q(sb.from('maint_photos').delete().eq('photo_id', p.photo_id)); } catch { /* shown */ }
      draw();
    }));
  };
  draw();
}

// opts: { intervalId } to edit, or { equipmentId } for a new one
async function openInterval(opts, onDone) {
  let iv = null;
  if (opts.intervalId) [iv] = await q(sb.from('service_intervals').select('*').eq('interval_id', opts.intervalId));
  const eq0 = refs.equipment.find((e) => e.equipment_id === (iv?.equipment_id ?? opts.equipmentId));
  const v = iv ?? { equipment_id: opts.equipmentId ?? null, start_date: localDate(), start_hours: eq0?.hours ?? null };
  const dlg = $('#dialog');
  dlg.innerHTML = `<form class="form">
    <div class="dialog-head"><h3>${iv ? 'Edit' : 'New'} service interval</h3></div>
    ${equipPickerHtml('equipment_id', v.equipment_id)}
    <label>Service *<input name="name" required value="${esc(v.name ?? '')}" placeholder="e.g. Engine oil & filter, Gearbox oil, Grease"></label>
    <div class="row2">
      <label>Every (hours)<input type="number" inputmode="decimal" step="any" min="0" name="every_hours" value="${esc(v.every_hours ?? '')}"></label>
      <label>Every (months)<input type="number" inputmode="numeric" step="1" min="1" name="every_months" value="${esc(v.every_months ?? '')}"></label>
    </div>
    <p class="muted small form-hint">Fill one or both. With both, it's due at whichever comes first.</p>
    <div class="row2">
      <label>Last done at (hours)<input type="number" inputmode="decimal" step="any" min="0" name="start_hours" value="${esc(v.start_hours ?? '')}"></label>
      <label>Last done on<input type="date" name="start_date" value="${esc(v.start_date ?? '')}"></label>
    </div>
    <p class="muted small form-hint">Where tracking starts. After the first logged service, the latest one is used instead.</p>
    <label>Notes (filter part #, oil spec…)<textarea name="notes" rows="2">${esc(v.notes ?? '')}</textarea></label>
    <div class="actions">
      ${iv ? '<button type="button" class="danger" data-act="del">Remove</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div></form>`;
  const form = $('form', dlg), el = form.elements;
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  wireEquipPicker(dlg, 'equipment_id', () => { const e = refs.equipment.find((x) => x.equipment_id === Number(el.equipment_id.value)); if (!iv && e?.hours != null && !el.start_hours.value) el.start_hours.value = e.hours; }).set(v.equipment_id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const n = (k) => (el[k].value === '' ? null : Number(el[k].value));
    const row = { equipment_id: Number(el.equipment_id.value), name: el.name.value.trim(), every_hours: n('every_hours'), every_months: n('every_months'),
      start_hours: n('start_hours'), start_date: el.start_date.value || null, notes: el.notes.value.trim() || null };
    if (row.every_hours == null && row.every_months == null) return toast('Enter hours, months, or both', true);
    try {
      if (iv) await q(sb.from('service_intervals').update(row).eq('interval_id', iv.interval_id));
      else await q(sb.from('service_intervals').insert(row));
      dlg.close(); toast('Saved'); onDone?.();
    } catch { /* shown */ }
  };
  const del = $('[data-act=del]', dlg);
  if (del) del.onclick = async () => {
    if (!confirm('Remove this interval? Past service records are kept.')) return;
    try { await q(sb.from('service_intervals').update({ active: false }).eq('interval_id', iv.interval_id)); dlg.close(); toast('Removed'); onDone?.(); } catch { /* shown */ }
  };
  if (!dlg.open) dlg.showModal();
}

// Equipment form: its service intervals and open repairs
async function equipmentService(form, row) {
  const box = document.createElement('div');
  box.className = 'eq-service';
  form.querySelector('.actions').before(box);
  if (!row) return;
  const [ivRes, jobRes] = await Promise.all([
    sb.from('service_intervals').select('*').eq('equipment_id', row.equipment_id).eq('active', true),
    sb.from('maint_jobs').select('*').eq('equipment_id', row.equipment_id),
  ]);
  if (ivRes.error) return;
  const jobs = jobRes.data ?? [], open = jobs.filter((j) => j.status !== 'done');
  box.innerHTML = `<div class="lines-head"><b>Maintenance</b><span class="muted small">${open.length ? `${open.length} open repair${open.length > 1 ? 's' : ''}` : 'No open repairs'} · ${jobs.length - open.length} done</span></div>
    ${ivRes.data.length ? `<ul class="list">${ivRes.data.map((iv) => { const d = serviceDue(iv, row, jobs); return `<li class="due-${d.state}"><span class="li-name">${esc(iv.name)} <span class="muted small">${everyText(iv)}</span>
      <span class="small">${dueText(d, iv, row)}</span></span></li>`; }).join('')}</ul>` : '<p class="muted small">No service intervals.</p>'}
    <div class="row"><button type="button" class="small" data-act="eq-iv">+ Service interval</button><button type="button" class="small" data-act="eq-job">Report a problem</button></div>`;
  $('[data-act=eq-iv]', box).onclick = () => openInterval({ equipmentId: row.equipment_id }, null);
  $('[data-act=eq-job]', box).onclick = () => openJob({ equipmentId: row.equipment_id }, null);
}

// =====================================================================
// Seasonal tasks: procedure checklists (startup / shutdown) run across systems each season.
// Shared steps apply to every system; a step with equipment_id is extra for that one system.
// =====================================================================
const PROC_KINDS = [['startup', 'Startup (in-season ready)'], ['shutdown', 'Shutdown (end of season)'], ['other', 'Other']];
const PROC_SCOPE = [['irrigation', 'Irrigation (pump stations, pivots, solid sets)'], ['pivots', 'Pivots'], ['pumps', 'Pump stations'], ['solid_sets', 'Solid sets'], ['wells', 'Mainlines & wells'], ['all', 'Any equipment']];
const SYS_TYPES = [['pumps', 'Pump stations', 'Pump stations'], ['pivots', 'Pivots', 'Pivots'], ['solid_sets', 'Solid sets', 'Solid sets'], ['wells', 'Mainlines & wells', 'Mainlines & wells']];
const sysType = (e) => SYS_TYPES.find(([, , sub]) => sub === eqSub(e))?.[0] ?? null;
const TASK_STATUS = { todo: 'Not started', in_progress: 'In progress', done: 'Done' };
const procScopeTest = (scope) => (e) => scope === 'all' ? true : scope === 'irrigation' ? ['pumps', 'pivots', 'solid_sets'].includes(sysType(e)) : sysType(e) === scope;
// Step groups a procedure shows: one per system type it covers, plus "every system".
const scopeTypes = (scope) => (scope === 'irrigation' ? ['pumps', 'pivots', 'solid_sets'] : scope === 'all' ? [] : [scope]);
const seasonalState = { season: new Date().getFullYear(), run: null, mine: false };
let myEmail = null;
async function myOperator() {
  if (myEmail == null) myEmail = ((await sb.auth.getUser()).data?.user?.email ?? '').toLowerCase();
  return refs.operators.find((o) => (o.login_email ?? '').trim().toLowerCase() === myEmail) ?? null;
}
// Seasonal tasks are labelled by field; the machine is the small print.
const sysKind = (e) => SYS_TYPES.find(([k]) => k === sysType(e))?.[1]?.replace(/s$/, '') ?? e?.type ?? '';
const taskTitle = (e) => (e ? (eqFields(e).length ? eqFields(e).join(', ') : e.name) : '?');
const taskSub = (e) => (e ? [sysKind(e), eqNum(e) != null ? `#${eqNum(e)}` : '', eqFields(e).length && !eqFields(e).every((f) => e.name.includes(f)) ? e.name : ''].filter(Boolean).join(' · ') : '');
const fieldRank = (e) => { const fs = (e?.equipment_fields ?? []).map((x) => fieldsInOrder().findIndex((f) => f.field_id === x.field_id)).filter((i) => i >= 0); return fs.length ? Math.min(...fs) : 1e6; };
const taskSort = (a, b) => fieldRank(a) - fieldRank(b) || (SYS_TYPES.findIndex(([k]) => k === sysType(a)) - SYS_TYPES.findIndex(([k]) => k === sysType(b))) || eqSort(a, b);
// Which pump station covers a pivot / solid set (shares a field with it), and what a station covers.
const sharesField = (a, b) => (a?.equipment_fields ?? []).some((x) => (b?.equipment_fields ?? []).some((y) => y.field_id === x.field_id));
const stationFor = (e) => refs.equipment.find((p) => p.active && sysType(p) === 'pumps' && p.equipment_id !== e.equipment_id && sharesField(p, e)) ?? null;
const coveredBy = (st) => refs.equipment.filter((e) => e.active && ['pivots', 'solid_sets'].includes(sysType(e)) && sharesField(st, e)).sort(taskSort);
// A system's checklist in sections. A pump station: its own steps, then a section per pivot / solid set it serves.
// A pivot or solid set with no pump station: Pump steps, then its own. Each item: { step, sec, key, sub, noteEq }.
function checklistFor(proc, eq) {
  const steps = (proc?.procedure_steps ?? []).filter((st) => st.active);
  const t = sysType(eq);
  const secs = [];
  if (t === 'pumps') {
    secs.push({ sys: eq, type: 'pumps', label: 'Pump station' });
    coveredBy(eq).forEach((c) => secs.push({ sys: c, type: sysType(c), label: `${taskTitle(c)} · ${sysKind(c)}` }));
  } else if ((t === 'pivots' || t === 'solid_sets') && ['irrigation', 'all'].includes(proc?.applies_to)) {
    if (!stationFor(eq)) secs.push({ sys: eq, type: 'pumps', label: 'Pump' });
    secs.push({ sys: eq, type: t, label: sysKind(eq) });
  } else secs.push({ sys: eq, type: t, label: '' });
  const items = [];
  secs.forEach((sec, i) => {
    const mine = steps.filter((st) => (st.equipment_id == null && st.system_type === sec.type)
      || (st.equipment_id == null && st.system_type == null && i === 0)
      || (st.equipment_id === sec.sys.equipment_id && (st.system_type ?? sysType(sec.sys)) === sec.type)
      || (st.equipment_id === sec.sys.equipment_id && st.system_type == null && sec.type === sysType(sec.sys) && sysType(sec.sys) == null))
      .sort((a, b) => a.position - b.position || (a.equipment_id == null ? -1 : 1) || a.step_id - b.step_id);
    sec.items = mine.map((st) => { const sub = sec.sys.equipment_id === eq.equipment_id ? 0 : sec.sys.equipment_id; return { step: st, sec, sub, noteEq: sec.sys.equipment_id, key: `${st.step_id}:${sub}` }; });
    items.push(...sec.items);
  });
  return { secs, items };
}
const stepsFor = (steps, eqId) => {
  const t = sysType(refs.equipment.find((e) => e.equipment_id === eqId));
  return steps.filter((st) => st.active && (st.equipment_id === eqId || (st.equipment_id == null && (!st.system_type || st.system_type === t))))
    .sort((a, b) => a.position - b.position || (a.equipment_id == null ? -1 : 1) || a.step_id - b.step_id);
};

async function renderSeasonal(el) {
  const s = seasonalState;
  await loadRefs();
  const [procRes, runRes] = await Promise.all([
    sb.from('procedures').select('*, procedure_steps(*)').order('name'),
    sb.from('procedure_runs').select('*, procedure_tasks(*, procedure_checks(*))').eq('season', s.season).order('started_on', { ascending: false }),
  ]);
  if (procRes.error) { el.innerHTML = `${maintTabs()}<div class="empty">Seasonal tasks aren’t set up yet. Run <b>irrigation_procedures.sql</b> in Supabase first.</div>`; wireMaintTabs(el); return; }
  const procs = procRes.data, runs = runRes.data ?? [];
  const me = await myOperator();
  const procOf = (id) => procs.find((p) => p.procedure_id === id);
  const skips = new Set(((await sb.from('procedure_step_notes').select('step_id, equipment_id').eq('skip', true)).data ?? []).map((x) => `${x.step_id}:${x.equipment_id}`));
  const progress = (t, p) => {
    const eq = refs.equipment.find((e) => e.equipment_id === t.equipment_id);
    const live = eq ? checklistFor(p, eq).items.filter((it) => !skips.has(`${it.step.step_id}:${it.noteEq}`)) : [];
    const done = new Set((t.procedure_checks ?? []).map((c) => `${c.step_id}:${c.sub_id ?? 0}`));
    return { done: live.filter((it) => done.has(it.key)).length, n: live.length };
  };
  const run = s.run ? runs.find((r) => r.run_id === s.run) : null;
  const reload = () => renderSeasonal(el);
  if (run) {
    const p = procOf(run.procedure_id);
    const tasks = [...run.procedure_tasks].filter((t) => !s.mine || (me && t.assigned_to === me.operator_id))
      .sort((a, b) => taskSort(refs.equipment.find((e) => e.equipment_id === a.equipment_id) ?? {}, refs.equipment.find((e) => e.equipment_id === b.equipment_id) ?? {}));
    const nDone = run.procedure_tasks.filter((t) => t.status === 'done').length;
    el.innerHTML = `${maintTabs()}
      <div class="section-head"><h2>${esc(p?.name ?? 'Procedure')} · ${run.season}</h2>
        <div class="row"><button data-act="back">‹ All rounds</button><button data-act="add-sys">+ Systems</button><button data-act="new-sys">+ New system</button></div></div>
      <p class="muted small">${nDone} of ${run.procedure_tasks.length} done · started ${fmtDateY(run.started_on)}${run.due_on ? ` · due ${fmtDateY(run.due_on)}` : ''}</p>
      ${(() => { const st = run.procedure_tasks.map((x) => refs.equipment.find((e) => e.equipment_id === x.equipment_id)).filter((e) => sysType(e) === 'pumps');
        const dups = run.procedure_tasks.filter((x) => st.some((p) => coveredBy(p).some((c) => c.equipment_id === x.equipment_id)));
        return dups.length ? `<div class="notice"><b>${dups.length} pivot/solid set checklist(s) are duplicates</b> of sections on a pump station's checklist. <button class="small primary" data-act="merge">Merge them</button></div>` : ''; })()}
      <div class="progress"><span style="width:${run.procedure_tasks.length ? (nDone / run.procedure_tasks.length) * 100 : 0}%"></span></div>
      <div class="filters"><label class="check"><input type="checkbox" data-mine ${s.mine ? 'checked' : ''} ${me ? '' : 'disabled'}> Only my tasks${me ? '' : ' <span class="muted small">(set your sign-in email under Setup → Operators)</span>'}</label></div>
      <div class="card table-wrap"><table class="m-cards run-table"><thead><tr><th>Field</th><th>Assigned</th><th>Progress</th><th>Status</th><th></th></tr></thead><tbody>
      ${tasks.map((t) => { const e = refs.equipment.find((x) => x.equipment_id === t.equipment_id); const pr = progress(t, p); return `<tr>
        <td><b>${esc(taskTitle(e))}</b><div class="muted small">${esc(taskSub(e))}</div></td>
        <td><select data-assign="${t.task_id}"><option value="">—</option>${refs.operators.filter((o) => o.active || o.operator_id === t.assigned_to).map((o) => `<option value="${o.operator_id}" ${o.operator_id === t.assigned_to ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></td>
        <td>${pr.done}/${pr.n}</td><td><span class="badge ${t.status === 'done' ? 'new' : t.status === 'in_progress' ? 'down' : 'off'}">${TASK_STATUS[t.status]}</span>${t.completed_on ? ` <span class="muted small">${fmtDateY(t.completed_on)}</span>` : ''}</td>
        <td class="r"><button class="small" data-task="${t.task_id}">Open</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="actions"><span class="spacer"></span><button class="danger small" data-act="del-run">Delete this round</button></div>`;
    wireMaintTabs(el);
    $('[data-act=back]', el).onclick = () => { s.run = null; reload(); };
    $('[data-mine]', el).onchange = (e) => { s.mine = e.target.checked; reload(); };
    $$('[data-assign]', el).forEach((sel) => (sel.onchange = async () => {
      try { await q(sb.from('procedure_tasks').update({ assigned_to: sel.value ? Number(sel.value) : null }).eq('task_id', Number(sel.dataset.assign))); toast('Assigned'); } catch { /* shown */ }
    }));
    $$('[data-task]', el).forEach((b) => (b.onclick = () => openTask(Number(b.dataset.task), p, reload)));
    $('[data-act=add-sys]', el).onclick = () => startRound(procs, reload, run);
    $('[data-act=new-sys]', el).onclick = () => newSystem(run, reload);
    $('[data-act=merge]', el)?.addEventListener('click', async () => {
      if (!confirm('Move their ticks onto the pump station checklists and remove the duplicate checklists?')) return;
      try { const m = await mergeCoveredTasks(run.run_id); toast(`Merged ${m}`); } catch { /* shown */ }
      reload();
    });
    $('[data-act=del-run]', el).onclick = async () => {
      if (!confirm('Delete this whole round and everything ticked off in it?')) return;
      try { await q(sb.from('procedure_runs').delete().eq('run_id', run.run_id)); s.run = null; reload(); } catch { /* shown */ }
    };
    return;
  }
  const myOpen = me ? runs.flatMap((r) => r.procedure_tasks.filter((t) => t.assigned_to === me.operator_id && t.status !== 'done').map((t) => ({ t, r }))) : [];
  el.innerHTML = `${maintTabs()}
    <div class="section-head"><h2>Seasonal tasks</h2>
      <div class="row">
        <button data-season="-1" aria-label="Previous year">‹</button><strong class="season">${s.season}</strong><button data-season="1" aria-label="Next year">›</button>
        <button data-act="procs">Procedures</button>
        <button class="primary" data-act="start" ${procs.some((p) => p.active) ? '' : 'disabled'}>Start a round</button>
      </div></div>
    ${myOpen.length ? `<div class="card"><h3>My tasks</h3><ul class="list">${myOpen.map(({ t, r }) => { const e = refs.equipment.find((x) => x.equipment_id === t.equipment_id); const pr = progress(t, procOf(r.procedure_id));
      return `<li><span class="li-name"><b>${esc(taskTitle(e))}</b> <span class="muted small">${esc(taskSub(e))} · ${esc(procOf(r.procedure_id)?.name ?? '')} · ${pr.done}/${pr.n}</span></span>
      <span class="li-value"><button class="small primary" data-mytask="${t.task_id}" data-proc="${r.procedure_id}">Open</button></span></li>`; }).join('')}</ul></div>` : ''}
    ${!procs.length ? '<div class="empty">No procedures yet. Tap <b>Procedures</b> to write your first checklist (for example, Pivot fall shutdown).</div>'
      : runs.length ? `<ul class="list card">${runs.map((r) => { const p = procOf(r.procedure_id); const n = r.procedure_tasks.length, d = r.procedure_tasks.filter((t) => t.status === 'done').length;
        return `<li><span class="li-name"><b>${esc(p?.name ?? '?')}</b> <span class="muted small">${PROC_KINDS.find(([k]) => k === p?.kind)?.[1] ?? ''} · started ${fmtDateY(r.started_on)}${r.due_on ? ` · due ${fmtDateY(r.due_on)}` : ''}</span>
          <span class="progress"><span style="width:${n ? (d / n) * 100 : 0}%"></span></span><span class="small">${d} of ${n} systems done</span></span>
          <span class="li-value"><button class="small" data-run="${r.run_id}">Open</button></span></li>`; }).join('')}</ul>`
      : `<div class="empty">No rounds started in ${s.season}. Tap <b>Start a round</b> to send a procedure out to every system.</div>`}`;
  wireMaintTabs(el);
  $$('[data-season]', el).forEach((b) => (b.onclick = () => { s.season += Number(b.dataset.season); reload(); }));
  $('[data-act=procs]', el).onclick = () => openProcedures(procs, reload);
  $('[data-act=start]', el).onclick = () => startRound(procs, reload);
  $$('[data-run]', el).forEach((b) => (b.onclick = () => { s.run = Number(b.dataset.run); reload(); }));
  $$('[data-mytask]', el).forEach((b) => (b.onclick = () => openTask(Number(b.dataset.mytask), procOf(Number(b.dataset.proc)), reload)));
}
function wireMaintTabs(el) {
  $$('[data-mview]', el).forEach((b) => (b.onclick = () => { maintState.view = b.dataset.mview; seasonalState.run = null; renderMaint(el); }));
}

// Start a round (or add systems to one): pick the procedure, the systems, and a due date.
function startRound(procs, onDone, run = null) {
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  const active = procs.filter((p) => p.active || p.procedure_id === run?.procedure_id);
  dlg.innerHTML = `<form class="form">
    <div class="dialog-head"><h3>${run ? 'Add systems' : 'Start a round'}</h3></div>
    <div class="row2">
      <label>Procedure *<select name="procedure_id" ${run ? 'disabled' : ''}>${active.map((p) => `<option value="${p.procedure_id}" ${p.procedure_id === run?.procedure_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label>Due by<input type="date" name="due_on" value="${esc(run?.due_on ?? '')}" ${run ? 'disabled' : ''}></label>
    </div>
    <div class="lines-head"><b>Systems</b><span><button type="button" class="small" data-all="1">All</button> <button type="button" class="small" data-all="0">None</button></span></div>
    <div class="pick-list" id="sys-list"></div>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">${run ? 'Add' : 'Start'}</button></div></form>`;
  const form = $('form', dlg), el = form.elements;
  const have = new Set((run?.procedure_tasks ?? []).map((t) => t.equipment_id));
  const draw = () => {
    const p = procs.find((x) => x.procedure_id === Number(el.procedure_id.value));
    const list = refs.equipment.filter((e) => e.active && procScopeTest(p?.applies_to ?? 'all')(e) && !have.has(e.equipment_id)).sort(eqSort);
    const groups = [...SYS_TYPES.map(([k, l]) => [l, list.filter((e) => sysType(e) === k)]), ['Other', list.filter((e) => !sysType(e))]].filter(([, es]) => es.length);
    $('#sys-list', dlg).innerHTML = list.length ? groups.map(([l, es]) => `<div class="sys-group"><b>${esc(l)}</b> <span class="muted small">${es.length}</span>
      ${[...es].sort(taskSort).map((e) => { const st = ['pivots', 'solid_sets'].includes(sysType(e)) ? stationFor(e) : null;
        return `<label class="check"><input type="checkbox" value="${e.equipment_id}" ${st ? '' : 'checked'}> <b>${esc(taskTitle(e))}</b> <span class="muted small">${esc(taskSub(e))}${st ? ` · on ${esc(st.name)}'s checklist` : ''}</span></label>`; }).join('')}</div>`).join('')
      : `<p class="muted small">No ${run ? 'more ' : ''}active ${esc(PROC_SCOPE.find(([k]) => k === p?.applies_to)?.[1]?.toLowerCase() ?? 'systems')} to add.</p>`;
  };
  el.procedure_id.onchange = draw; draw();
  $$('[data-all]', dlg).forEach((b) => (b.onclick = () => $$('#sys-list input', dlg).forEach((c) => (c.checked = b.dataset.all === '1'))));
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ids = $$('#sys-list input:checked', dlg).map((c) => Number(c.value));
    if (!ids.length) return toast('Pick at least one system', true);
    try {
      let runId = run?.run_id;
      if (!run) runId = (await q(sb.from('procedure_runs').insert({ procedure_id: Number(el.procedure_id.value), season: seasonalState.season, due_on: el.due_on.value || null }).select('run_id').single())).run_id;
      await q(sb.from('procedure_tasks').insert(ids.map((id) => ({ run_id: runId, equipment_id: id }))));
      seasonalState.run = runId;
      dlg.close(); toast(`${ids.length} system(s) ${run ? 'added' : 'in this round'}`); onDone?.();
    } catch { /* shown */ }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// A pump station's checklist covers every pivot / solid set sharing a field with it. If one of those also has
// its own checklist in the same round, fold its ticks into the station's and drop the duplicate.
async function mergeCoveredTasks(runId) {
  await loadRefs();
  const [run] = await q(sb.from('procedure_runs').select('*, procedures(*, procedure_steps(*)), procedure_tasks(*, procedure_checks(*))').eq('run_id', runId));
  if (!run) return 0;
  const proc = run.procedures;
  const eqOf = (id) => refs.equipment.find((e) => e.equipment_id === id);
  let merged = 0;
  for (const st of run.procedure_tasks.filter((x) => sysType(eqOf(x.equipment_id)) === 'pumps')) {
    const station = eqOf(st.equipment_id);
    const items = checklistFor(proc, station).items;
    const have = new Set(st.procedure_checks.map((c) => `${c.step_id}:${c.sub_id ?? 0}`));
    for (const c of coveredBy(station)) {
      const dup = run.procedure_tasks.find((x) => x.equipment_id === c.equipment_id && x.task_id !== st.task_id);
      if (!dup) continue;
      const moves = [];
      for (const ck of dup.procedure_checks) {
        const it = items.find((i) => i.step.step_id === ck.step_id && i.sub === c.equipment_id) ?? items.find((i) => i.step.step_id === ck.step_id && i.sub === 0);
        if (it && !have.has(it.key)) { have.add(it.key); moves.push({ task_id: st.task_id, step_id: ck.step_id, sub_id: it.sub, done_at: ck.done_at, done_by_name: ck.done_by_name }); }
      }
      if (moves.length) await q(sb.from('procedure_checks').insert(moves));
      if (dup.notes && !st.notes) await q(sb.from('procedure_tasks').update({ notes: dup.notes }).eq('task_id', st.task_id));
      await q(sb.from('procedure_tasks').delete().eq('task_id', dup.task_id));
      merged++;
    }
    // Status of the station after the merge
    const after = (await q(sb.from('procedure_checks').select('step_id, sub_id').eq('task_id', st.task_id))).map((c) => `${c.step_id}:${c.sub_id ?? 0}`);
    const skipRows = (await sb.from('procedure_step_notes').select('step_id, equipment_id').eq('skip', true)).data ?? [];
    const live = items.filter((i) => !skipRows.some((s2) => s2.step_id === i.step.step_id && s2.equipment_id === i.noteEq));
    const n = live.filter((i) => after.includes(i.key)).length;
    const status = n === 0 ? 'todo' : n >= live.length ? 'done' : 'in_progress';
    if (status !== st.status) await q(sb.from('procedure_tasks').update({ status, completed_on: status === 'done' ? localDate() : null }).eq('task_id', st.task_id));
  }
  return merged;
}

// From a pump station's checklist: add a pivot or solid set it serves (existing, or new).
function addCovered(station, onDone) {
  const covered = new Set(coveredBy(station).map((e) => e.equipment_id));
  const others = refs.equipment.filter((e) => e.active && ['pivots', 'solid_sets'].includes(sysType(e)) && !covered.has(e.equipment_id)).sort(taskSort);
  const dlg2 = document.createElement('dialog');
  dlg2.className = 'stacked';
  dlg2.innerHTML = `<form class="form"><div class="dialog-head"><h3>Add to ${esc(taskTitle(station))}</h3><p class="muted small">Its steps become a section on this pump station's checklist.</p></div>
    <div class="seg" role="group"><button type="button" data-mode="new" class="on">New</button><button type="button" data-mode="existing">Already in the app</button></div>
    <div data-new><div class="row2"><label>Kind<select name="kind"><option value="Solid set">Solid set</option><option value="Pivot">Pivot</option></select></label>
      <label>Name *<input name="name" placeholder="e.g. Solid set-274"></label></div>
      <p class="muted small">Linked to the same field(s) as this pump station: ${esc(eqFields(station).join(', ') || 'none yet')}.</p></div>
    <div data-existing hidden><label>System<select name="existing"><option value="">Choose…</option>${others.map((e) => `<option value="${e.equipment_id}">${esc(taskTitle(e))} · ${esc(taskSub(e))}</option>`).join('')}</select></label>
      <p class="muted small">This pump station will be marked as serving its field(s).</p></div>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Add</button></div></form>`;
  document.body.appendChild(dlg2);
  let mode = 'new';
  $$('[data-mode]', dlg2).forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $$('[data-mode]', dlg2).forEach((x) => x.classList.toggle('on', x === b)); $('[data-new]', dlg2).hidden = mode !== 'new'; $('[data-existing]', dlg2).hidden = mode !== 'existing'; }));
  const close = () => { dlg2.close(); dlg2.remove(); };
  $('[data-act=cancel]', dlg2).onclick = close;
  $('form', dlg2).onsubmit = async (e) => {
    e.preventDefault();
    const el = e.target.elements;
    try {
      const fids = (station.equipment_fields ?? []).map((x) => x.field_id);
      if (mode === 'new') {
        const name = el.name.value.trim();
        if (!name) return toast('Enter a name', true);
        const kind = el.kind.value, band = kind === 'Pivot' ? 700 : 740;
        const [ne] = await q(sb.from('equipment').insert({ name, type: kind, unit_no: String(nextFreeNumber(band) ?? ''), active: true }).select('equipment_id'));
        if (fids.length) await q(sb.from('equipment_fields').insert(fids.map((f) => ({ equipment_id: ne.equipment_id, field_id: f }))));
        else toast('This pump station has no fields, so link both to a field under Setup → Equipment', true);
      } else {
        const sys = refs.equipment.find((x) => x.equipment_id === Number(el.existing.value));
        if (!sys) return toast('Pick a system', true);
        const sf = (sys.equipment_fields ?? []).map((x) => x.field_id);
        if (sf.length) await q(sb.from('equipment_fields').upsert(sf.map((f) => ({ equipment_id: station.equipment_id, field_id: f }))));
        else if (fids.length) await q(sb.from('equipment_fields').insert(fids.map((f) => ({ equipment_id: sys.equipment_id, field_id: f }))));
      }
      await loadRefs();
      close(); toast('Added'); onDone?.();
    } catch { /* shown */ }
  };
  dlg2.showModal();
}

// Add a pump station / pivot / solid set that isn't in the app yet, straight into a round.
function newSystem(run, onDone) {
  const kinds = [['Pump', 'Pump station', 760], ['Pivot', 'Pivot', 700], ['Solid set', 'Solid set', 740], ['Mainline', 'Mainline or well', 780]];
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form">
    <div class="dialog-head"><h3>New system</h3><p class="muted small">Added to equipment and to this round.</p></div>
    <div class="row2"><label>Name *<input name="name" required placeholder="e.g. Pump Station 3"></label>
      <label>Kind<select name="kind">${kinds.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
    <div class="lines-head"><b>Fields it serves</b></div>
    <div class="chips">${fieldsInOrder().filter((f) => f.active).map((f) => `<label class="chip-toggle"><input type="checkbox" value="${f.field_id}"><span>${esc(f.name)}</span></label>`).join('')}</div>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Add</button></div></form>`;
  const form = $('form', dlg);
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const kind = kinds.find(([k]) => k === form.elements.kind.value);
    try {
      const [eq] = await q(sb.from('equipment').insert({ name: form.elements.name.value.trim(), type: kind[0], unit_no: String(nextFreeNumber(kind[2]) ?? ''), active: true }).select('equipment_id'));
      const fids = $$('.chips input:checked', dlg).map((c) => Number(c.value));
      if (fids.length) await q(sb.from('equipment_fields').insert(fids.map((f) => ({ equipment_id: eq.equipment_id, field_id: f }))));
      await q(sb.from('procedure_tasks').insert({ run_id: run.run_id, equipment_id: eq.equipment_id }));
      if (kind[0] === 'Pump') { const m = await mergeCoveredTasks(run.run_id); if (m) toast(`${m} pivot/solid set checklist(s) moved onto this pump station`); }
      await loadRefs();
      dlg.close(); toast('System added'); onDone?.();
    } catch { /* shown */ }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// One system's checklist, in sections: tick steps, and build the procedure while doing it —
// add steps, notes and photos for a system, or mark a step "not on this system".
async function openTask(taskId, proc, onDone) {
  const [t] = await q(sb.from('procedure_tasks').select('*, procedure_checks(*)').eq('task_id', taskId));
  const eq = refs.equipment.find((e) => e.equipment_id === t.equipment_id);
  const me = await myOperator();
  const checks = new Map(t.procedure_checks.map((c) => [`${c.step_id}:${c.sub_id ?? 0}`, c]));
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  let cl = { secs: [], items: [] }, notes = new Map(), urls = new Map(), editing = null, photos = [];
  const nk = (it) => `${it.step.step_id}:${it.noteEq}`;
  const load = async () => {
    [proc] = await q(sb.from('procedures').select('*, procedure_steps(*)').eq('procedure_id', proc.procedure_id));
    cl = checklistFor(proc, eq);
    const eqIds = [...new Set(cl.secs.map((sc) => sc.sys.equipment_id))];
    const stepIds = [...new Set(cl.items.map((it) => it.step.step_id))];
    notes = new Map(stepIds.length ? ((await sb.from('procedure_step_notes').select('*').in('equipment_id', eqIds).in('step_id', stepIds)).data ?? []).map((n) => [`${n.step_id}:${n.equipment_id}`, n]) : []);
    photos = stepIds.length ? ((await sb.from('procedure_step_photos').select('*').in('equipment_id', eqIds).in('step_id', stepIds).order('taken_at')).data ?? []) : [];
    const paths = [...cl.items.map((it) => it.step.photo_path), ...[...notes.values()].map((n) => n.photo_path), ...photos.map((ph) => ph.path)].filter((x) => x && !urls.has(x));
    if (paths.length) ((await sb.storage.from('maintenance').createSignedUrls(paths, 3600)).data ?? []).forEach((u, i) => urls.set(paths[i], u.signedUrl));
  };
  const live = () => cl.items.filter((it) => !notes.get(nk(it))?.skip);
  const setStatus = async () => {
    const lv = live(), n = lv.filter((it) => checks.has(it.key)).length;
    const status = n === 0 ? 'todo' : n >= lv.length ? 'done' : 'in_progress';
    if (status !== t.status) {
      await q(sb.from('procedure_tasks').update({ status, completed_on: status === 'done' ? localDate() : null }).eq('task_id', t.task_id));
      if (status === 'done') toast('All steps done');
      t.status = status;
    }
  };
  const saveNote = async (it, patch) => {
    const cur = notes.get(nk(it)) ?? { note: null, photo_path: null, skip: false };
    const row = { note: cur.note, photo_path: cur.photo_path, skip: cur.skip, ...patch };
    if (!row.note && !row.photo_path && !row.skip) await q(sb.from('procedure_step_notes').delete().eq('step_id', it.step.step_id).eq('equipment_id', it.noteEq));
    else await q(sb.from('procedure_step_notes').upsert({ step_id: it.step.step_id, equipment_id: it.noteEq, ...row }));
  };
  const tick = async (it, on) => {
    if (on) {
      const row = { task_id: t.task_id, step_id: it.step.step_id, sub_id: it.sub, done_by_name: me?.name ?? myEmail ?? null };
      await q(sb.from('procedure_checks').insert(row));
      checks.set(it.key, { ...row, done_at: new Date().toISOString() });
    } else { await q(sb.from('procedure_checks').delete().eq('task_id', t.task_id).eq('step_id', it.step.step_id).eq('sub_id', it.sub)); checks.delete(it.key); }
  };
  const itemRow = (it) => {
    const st = it.step, c = checks.get(it.key), n = notes.get(nk(it)), k = it.key;
    return `<li class="${c ? 'done' : ''}">
      <label class="check"><input type="checkbox" data-step="${k}" ${c ? 'checked' : ''}><span>${esc(st.text)}${st.equipment_id ? ' <span class="badge up">This system</span>' : ''}</span></label>
      ${st.photo_path ? `<a href="${esc(urls.get(st.photo_path) ?? '#')}" target="_blank" rel="noopener"><img class="step-img" src="${esc(urls.get(st.photo_path) ?? '')}" alt=""></a>` : ''}
      ${n?.note ? `<p class="step-note">⚠ ${esc(n.note)}</p>` : ''}
      ${(() => { const ps = photos.filter((ph) => ph.step_id === st.step_id && ph.equipment_id === it.noteEq); const legacy = n?.photo_path;
        return ps.length || legacy ? `<div class="step-photos">${legacy ? `<a href="${esc(urls.get(legacy) ?? '#')}" target="_blank" rel="noopener"><img src="${esc(urls.get(legacy) ?? '')}" alt=""></a>` : ''}${ps.map((ph) => `<span class="sp"><a href="${esc(urls.get(ph.path) ?? '#')}" target="_blank" rel="noopener"><img src="${esc(urls.get(ph.path) ?? '')}" alt=""></a><button type="button" class="icon" data-rm-ph="${ph.photo_id}" aria-label="Delete photo">✕</button></span>`).join('')}</div>` : ''; })()}
      ${editing === k ? `<div class="note-edit"><input data-note-in value="${esc(n?.note ?? '')}" placeholder="Note for this system only"><button type="button" class="small primary" data-note-save="${k}">Save</button></div>` : ''}
      <div class="step-tools">
        ${c ? `<span class="muted small">✓ ${esc(c.done_by_name ?? '')} ${new Date(c.done_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` : ''}
        <button type="button" class="link small" data-note="${k}">${n?.note ? 'Edit note' : 'Note'}</button>
        <label class="link small">+ Photos<input type="file" accept="image/*" multiple hidden data-photo="${k}"></label>
        ${st.equipment_id ? `<button type="button" class="link small" data-del-own="${k}">Delete step</button>` : `<button type="button" class="link small" data-skip="${k}">Not on this system</button>`}
      </div></li>`;
  };
  const draw = () => {
    const lv = live(), skipped = cl.items.filter((it) => notes.get(nk(it))?.skip);
    const many = cl.secs.length > 1;
    // "Add a step" choices: which section, and for whom.
    const secOpts = cl.secs.map((sc, i) => `<option value="${i}">${esc(sc.label || 'This checklist')}</option>`).join('');
    dlg.innerHTML = `<div class="form task-form">
      <div class="dialog-head"><h3>${esc(taskTitle(eq))}</h3><p class="muted small">${esc(taskSub(eq))} · ${esc(proc?.name ?? '')}${proc?.notes ? ` · ${esc(proc.notes)}` : ''}</p></div>
      <p><b>${lv.filter((it) => checks.has(it.key)).length}</b> of ${lv.length} steps done</p>
      ${cl.secs.map((sc) => { const its = sc.items.filter((it) => !notes.get(nk(it))?.skip); return `${many ? `<h4 class="cl-sec">${esc(sc.label)} <span class="muted small">${its.filter((it) => checks.has(it.key)).length}/${its.length}</span></h4>` : ''}
        <ol class="checklist">${its.map(itemRow).join('')}</ol>`; }).join('')}
      ${skipped.length ? `<details class="skipped"><summary>${skipped.length} step${skipped.length > 1 ? 's' : ''} not on this system</summary><ul class="list">${skipped.map((it) => `<li><span class="li-name muted">${many ? `<b>${esc(it.sec.label)}:</b> ` : ''}${esc(it.step.text)}</span><span class="li-value"><button type="button" class="small" data-unskip="${it.key}">Put back</button></span></li>`).join('')}</ul></details>` : ''}
      ${sysType(eq) === 'pumps' ? `<button type="button" class="small" data-act="add-covered">+ Pivot or solid set on this pump station</button>` : ''}
      <div class="add-step card">
        <b>Add a step</b>
        <textarea rows="2" data-new-text placeholder="What did you do here?"></textarea>
        ${many ? `<label>Section<select data-new-sec>${secOpts}</select></label>` : ''}
        <div class="row2">
          <label>For<select data-new-scope></select></label>
          <label>Where<select data-new-after></select></label>
        </div>
        <label class="check"><input type="checkbox" data-new-done checked> Done already</label>
        <button type="button" class="primary small" data-act="add-step">Add step</button>
      </div>
      <label>Notes<textarea name="notes" rows="2">${esc(t.notes ?? '')}</textarea></label>
      <div class="actions"><button type="button" data-act="problem">Report a problem</button><span class="spacer"></span><button type="button" class="primary" data-act="close">Close</button></div></div>`;
    const itOf = (k) => cl.items.find((it) => it.key === k);
    const secSel = $('[data-new-sec]', dlg);
    const fillAdd = () => {
      const sc = cl.secs[Number(secSel?.value ?? 0)];
      const kind = SYS_TYPES.find(([k]) => k === sc.type)?.[1]?.toLowerCase().replace(/s$/, '');
      $('[data-new-scope]', dlg).innerHTML = `<option value="mine">Only ${esc(sc.sys.equipment_id === eq.equipment_id ? (eq.name ?? 'this system') : taskTitle(sc.sys))}</option>${sc.type ? `<option value="type">Every ${esc(kind ?? '')}</option>` : ''}<option value="all">Every checklist</option>`;
      const its = sc.items.filter((it) => !notes.get(nk(it))?.skip);
      $('[data-new-after]', dlg).innerHTML = `<option value="start">At the beginning</option><option value="end">At the end</option>${its.map((it, i) => `<option value="${it.step.step_id}">After step ${i + 1}</option>`).join('')}`;
      $('[data-new-after]', dlg).value = 'end';
    };
    secSel?.addEventListener('change', fillAdd); fillAdd();
    const busy = async (fn) => { try { await fn(); } catch { /* shown */ } await load(); await setStatus().catch(() => {}); draw(); };
    $$('[data-step]', dlg).forEach((c) => (c.onchange = () => busy(() => tick(itOf(c.dataset.step), c.checked))));
    $$('[data-note]', dlg).forEach((b) => (b.onclick = () => { editing = b.dataset.note; draw(); $('[data-note-in]', dlg)?.focus(); }));
    $$('[data-note-save]', dlg).forEach((b) => (b.onclick = () => { const v = $('[data-note-in]', dlg).value.trim() || null; editing = null; busy(() => saveNote(itOf(b.dataset.noteSave), { note: v })); }));
    $('[data-note-in]', dlg)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('[data-note-save]', dlg).click(); } });
    $$('[data-skip]', dlg).forEach((b) => (b.onclick = () => busy(async () => { const it = itOf(b.dataset.skip); if (checks.has(it.key)) await tick(it, false); await saveNote(it, { skip: true }); })));
    $$('[data-unskip]', dlg).forEach((b) => (b.onclick = () => busy(() => saveNote(itOf(b.dataset.unskip), { skip: false }))));
    $$('[data-del-own]', dlg).forEach((b) => (b.onclick = () => { if (confirm('Delete this step from this system?')) busy(() => q(sb.from('procedure_steps').update({ active: false }).eq('step_id', itOf(b.dataset.delOwn).step.step_id))); }));
    $$('[data-photo]', dlg).forEach((inp) => (inp.onchange = (e) => {
      const files = [...e.target.files]; if (!files.length) return;
      const it = itOf(inp.dataset.photo);
      busy(async () => {
        for (const f of files) {
          const blob = await shrinkImage(f, 1600);
          const path = `procedures/${proc.procedure_id}/sys-${it.noteEq}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
          const { error } = await sb.storage.from('maintenance').upload(path, blob, { contentType: blob.type || 'image/jpeg' });
          if (error) { toast(`Upload failed: ${error.message}`, true); return; }
          await q(sb.from('procedure_step_photos').insert({ step_id: it.step.step_id, equipment_id: it.noteEq, path }));
        }
        toast(files.length > 1 ? `${files.length} photos added` : 'Photo added');
      });
    }));
    $$('[data-rm-ph]', dlg).forEach((b) => (b.onclick = () => {
      if (!confirm('Delete this photo?')) return;
      const ph = photos.find((x) => x.photo_id === Number(b.dataset.rmPh));
      busy(async () => { await sb.storage.from('maintenance').remove([ph.path]); await q(sb.from('procedure_step_photos').delete().eq('photo_id', ph.photo_id)); });
    }));
    $('[data-act=add-step]', dlg).onclick = () => {
      const text = $('[data-new-text]', dlg).value.trim();
      if (!text) return $('[data-new-text]', dlg).focus();
      const sc = cl.secs[Number(secSel?.value ?? 0)];
      const scope = $('[data-new-scope]', dlg).value, after = $('[data-new-after]', dlg).value, done = $('[data-new-done]', dlg).checked;
      const pos = sc.items.map((it) => it.step.position);
      const ref = sc.items.find((it) => String(it.step.step_id) === after);
      const position = after === 'start' ? Math.min(10, ...pos) - 10 : ref ? ref.step.position + 1 : Math.max(0, ...pos) + 10;
      busy(async () => {
        const row = { procedure_id: proc.procedure_id, position, text,
          equipment_id: scope === 'mine' ? sc.sys.equipment_id : null,
          system_type: scope === 'all' ? null : sc.type };
        const [ns] = await q(sb.from('procedure_steps').insert(row).select('step_id'));
        if (done) {
          const fresh = checklistFor({ ...proc, procedure_steps: [...proc.procedure_steps, { ...row, step_id: ns.step_id, active: true }] }, eq).items.find((it) => it.step.step_id === ns.step_id && it.sec.sys.equipment_id === sc.sys.equipment_id && it.sec.type === sc.type);
          if (fresh) await tick(fresh, true);
        }
        toast('Step added');
      });
    };
    $('[data-act=close]', dlg).onclick = async () => {
      const nv = $('textarea[name=notes]', dlg).value.trim() || null;
      if (nv !== (t.notes ?? null)) { try { await q(sb.from('procedure_tasks').update({ notes: nv }).eq('task_id', t.task_id)); } catch { /* shown */ } }
      dlg.close(); onDone?.();
    };
    $('[data-act=problem]', dlg).onclick = () => openJob({ equipmentId: t.equipment_id }, onDone);
    $('[data-act=add-covered]', dlg)?.addEventListener('click', () => addCovered(eq, async () => {
      await mergeCoveredTasks(t.run_id);
      openTask(taskId, proc, onDone);
    }));
  };
  await load();
  draw();
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// Procedure templates: shared steps + extra steps for a single system, each optionally with a photo.
function openProcedures(procs, onDone) {
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<div class="form"><div class="dialog-head"><h3>Procedures</h3><p class="muted small">Checklists you send out each season.</p></div>
    ${procs.length ? `<ul class="list">${procs.map((p) => `<li><span class="li-name"><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge off">inactive</span>'}
      <span class="muted small">${PROC_KINDS.find(([k]) => k === p.kind)?.[1] ?? ''} · ${PROC_SCOPE.find(([k]) => k === p.applies_to)?.[1] ?? ''} · ${(p.procedure_steps ?? []).filter((x) => x.active && x.equipment_id == null).length} steps</span></span>
      <span class="li-value"><button class="small" data-edit-proc="${p.procedure_id}">Edit</button></span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}
    <div class="actions"><button type="button" class="primary" data-act="new">New procedure</button><span class="spacer"></span><button type="button" data-act="close">Close</button></div></div>`;
  $('[data-act=close]', dlg).onclick = () => { dlg.close(); onDone?.(); };
  $('[data-act=new]', dlg).onclick = () => editProcedure(null, onDone);
  $$('[data-edit-proc]', dlg).forEach((b) => (b.onclick = () => editProcedure(Number(b.dataset.editProc), onDone)));
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

async function editProcedure(procId, onDone) {
  let p = procId ? (await q(sb.from('procedures').select('*, procedure_steps(*)').eq('procedure_id', procId)))[0] : null;
  const dlg = $('#dialog');
  let sys = '';          // system whose notes and extra steps are shown
  let sysNotes = new Map();
  const urls = new Map();
  const loadUrls = async () => {
    const paths = (p?.procedure_steps ?? []).filter((st) => st.photo_path && !urls.has(st.photo_path)).map((st) => st.photo_path);
    if (paths.length) ((await sb.storage.from('maintenance').createSignedUrls(paths, 3600)).data ?? []).forEach((u, i) => urls.set(paths[i], u.signedUrl));
  };
  const loadNotes = async () => {
    sysNotes = new Map();
    if (!sys || !p) return;
    const ids = (p.procedure_steps ?? []).map((st) => st.step_id);
    if (ids.length) ((await sb.from('procedure_step_notes').select('step_id, note').eq('equipment_id', Number(sys)).in('step_id', ids)).data ?? []).forEach((n) => sysNotes.set(n.step_id, n.note));
  };
  const reloadP = async () => { [p] = await q(sb.from('procedures').select('*, procedure_steps(*)').eq('procedure_id', p.procedure_id)); await loadUrls(); await loadNotes(); draw(); };
  const stepRow = (st, i, list, withNote) => `<li data-sid="${st.step_id}">
    <div class="step-row"><span class="step-n">${i + 1}.</span><textarea rows="1" data-text="${st.step_id}">${esc(st.text)}</textarea>
      <span class="step-btns"><button type="button" class="icon" data-up="${st.step_id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" class="icon" data-down="${st.step_id}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <label class="icon" title="Photo">📷<input type="file" accept="image/*" hidden data-photo="${st.step_id}"></label><button type="button" class="icon" data-del-step="${st.step_id}" aria-label="Delete step">✕</button></span></div>
    ${st.photo_path ? `<div class="step-photo"><img src="${esc(urls.get(st.photo_path) ?? '')}" alt=""><button type="button" class="small" data-rm-photo="${st.step_id}">Remove photo</button></div>` : ''}
    ${withNote ? `<label class="step-note-in">Note for this system only<input data-note="${st.step_id}" value="${esc(sysNotes.get(st.step_id) ?? '')}" placeholder="e.g. wooden plugs, no valves"></label>` : ''}</li>`;
  const draw = () => {
    const all = (p?.procedure_steps ?? []).filter((st) => st.active);
    const scope = p?.applies_to ?? 'irrigation';
    const types = scopeTypes(scope);
    const groupOf = (t) => all.filter((st) => st.equipment_id == null && (st.system_type ?? null) === t).sort((a, b) => a.position - b.position || a.step_id - b.step_id);
    const groups = [...types.map((t) => [t, SYS_TYPES.find(([k]) => k === t)?.[1] ?? t]), [null, types.length > 1 ? 'Every system' : 'Steps']];
    const systems = refs.equipment.filter((e) => (e.active || all.some((st) => st.equipment_id === e.equipment_id)) && procScopeTest(scope)(e)).sort(eqSort);
    const sysEq = sys ? refs.equipment.find((e) => e.equipment_id === Number(sys)) : null;
    const sysShared = sysEq ? all.filter((st) => st.equipment_id == null && (!st.system_type || st.system_type === sysType(sysEq))).sort((a, b) => a.position - b.position) : [];
    const extra = sys ? all.filter((st) => st.equipment_id === Number(sys)).sort((a, b) => a.position - b.position) : [];
    const special = new Set(all.filter((st) => st.equipment_id != null).map((st) => st.equipment_id));
    dlg.innerHTML = `<form class="form proc-form">
      <div class="dialog-head"><h3>${p ? 'Edit' : 'New'} procedure</h3></div>
      <label>Name *<input name="name" required value="${esc(p?.name ?? '')}" placeholder="e.g. End of season shutdown"></label>
      <div class="row2">
        <label>Kind<select name="kind">${PROC_KINDS.map(([k, l]) => `<option value="${k}" ${(p?.kind ?? 'shutdown') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Covers<select name="applies_to">${PROC_SCOPE.map(([k, l]) => `<option value="${k}" ${scope === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label>Notes<textarea name="notes" rows="2">${esc(p?.notes ?? '')}</textarea></label>
      <label class="check"><input type="checkbox" name="active" ${p?.active === false ? '' : 'checked'}> Active</label>
      ${p ? `${groups.filter(([t, , ]) => t !== null || types.length !== 1 || groupOf(null).length).map(([t, label]) => { const list = groupOf(t); return `
        <div class="lines-head"><b>${esc(label)}</b><span class="muted small">${t ? `done at every ${esc(label.toLowerCase().replace(/s$/, ''))}` : types.length > 1 ? 'on every checklist' : ''}</span></div>
        <ol class="step-list">${list.map((st, i) => stepRow(st, i, list, false)).join('')}</ol>
        <div class="row step-add"><input data-new="g:${t ?? ''}" placeholder="Add a step…"><button type="button" class="small" data-add="g:${t ?? ''}">Add</button></div>`; }).join('')}
        <div class="lines-head"><b>One system's notes and extra steps</b></div>
        <label>System<select data-sys><option value="">Choose a system…</option>${systems.map((e) => `<option value="${e.equipment_id}" ${Number(sys) === e.equipment_id ? 'selected' : ''}>${esc(eqLabel(e))}${special.has(e.equipment_id) ? ' ★' : ''}</option>`).join('')}</select></label>
        ${sys ? `<p class="muted small">Notes show under that step on this system's checklist only.</p>
          <ol class="step-list">${sysShared.map((st, i) => stepRow(st, i, sysShared, true)).join('')}</ol>
          <div class="lines-head"><b>Extra steps for ${esc(sysEq ? eqLabel(sysEq) : '')}</b></div>
          <ol class="step-list">${extra.map((st, i) => stepRow(st, i, extra, false)).join('')}</ol>
          <div class="row step-add"><input data-new="sys" placeholder="Add a step for this system…">
            <select data-after><option value="end">at the end</option>${sysShared.map((st, i) => `<option value="${st.position}">after step ${i + 1}</option>`).join('')}</select>
            <button type="button" class="small" data-add="sys">Add</button></div>` : ''}`
        : '<p class="muted small">Save the name first, then add the steps.</p>'}
      <div class="actions">${p ? '<button type="button" class="danger" data-act="del">Delete</button>' : ''}<span class="spacer"></span>
        <button type="button" data-act="cancel">${p ? 'Done' : 'Cancel'}</button><button type="submit" class="primary">Save</button></div></form>`;
    const form = $('form', dlg), el = form.elements;
    const head = () => ({ name: el.name.value.trim(), kind: el.kind.value, applies_to: el.applies_to.value, notes: el.notes.value.trim() || null, active: el.active.checked });
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        if (p) { await q(sb.from('procedures').update(head()).eq('procedure_id', p.procedure_id)); toast('Saved'); await reloadP(); }
        else { const [np] = await q(sb.from('procedures').insert(head()).select('*')); p = { ...np, procedure_steps: [] }; toast('Saved. Add the steps now.'); draw(); }
      } catch { /* shown */ }
    };
    if (p) el.applies_to.onchange = async () => { try { await q(sb.from('procedures').update(head()).eq('procedure_id', p.procedure_id)); await reloadP(); } catch { /* shown */ } };
    $('[data-act=cancel]', dlg).onclick = async () => {
      if (p) { try { await q(sb.from('procedures').update(head()).eq('procedure_id', p.procedure_id)); } catch { /* shown */ } }
      const procs = (await sb.from('procedures').select('*, procedure_steps(*)').order('name')).data ?? [];
      openProcedures(procs, onDone);
    };
    const del = $('[data-act=del]', dlg);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this procedure?')) return;
      try { await q(sb.from('procedures').delete().eq('procedure_id', p.procedure_id)); dlg.close(); onDone?.(); }
      catch { toast('It has rounds, so it can’t be deleted. Untick Active instead.', true); }
    };
    if (!p) return;
    const sysSel = $('[data-sys]', dlg);
    sysSel.onchange = async () => { sys = sysSel.value; await loadNotes(); draw(); };
    $$('[data-add]', dlg).forEach((b) => (b.onclick = async () => {
      const key = b.dataset.add;
      const inp = $(`[data-new="${key}"]`, dlg);
      const text = inp.value.trim();
      if (!text) return inp.focus();
      let row;
      if (key === 'sys') {
        const after = $('[data-after]', dlg).value;
        const maxShared = Math.max(0, ...sysShared.map((st) => st.position));
        const position = after === 'end' ? maxShared + 5 + extra.length : Number(after) + 1 + extra.filter((x) => x.position > Number(after) && x.position < Number(after) + 10).length;
        row = { procedure_id: p.procedure_id, equipment_id: Number(sys), position, text };
      } else {
        const t = key.slice(2) || null;
        row = { procedure_id: p.procedure_id, system_type: t, position: Math.max(0, ...groupOf(t).map((st) => st.position)) + 10, text };
      }
      try { await q(sb.from('procedure_steps').insert(row)); await reloadP(); $(`[data-new="${key}"]`, dlg)?.focus(); } catch { /* shown */ }
    }));
    $$('[data-new]', dlg).forEach((inp) => (inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $(`[data-add="${inp.dataset.new}"]`, dlg).click(); } }));
    $$('[data-text]', dlg).forEach((ta) => (ta.onchange = async () => { try { await q(sb.from('procedure_steps').update({ text: ta.value.trim() }).eq('step_id', Number(ta.dataset.text))); } catch { /* shown */ } }));
    $$('[data-note]', dlg).forEach((inp) => (inp.onchange = async () => {
      const sid = Number(inp.dataset.note), note = inp.value.trim();
      try {
        if (note) await q(sb.from('procedure_step_notes').upsert({ step_id: sid, equipment_id: Number(sys), note }));
        else await q(sb.from('procedure_step_notes').delete().eq('step_id', sid).eq('equipment_id', Number(sys)));
        sysNotes.set(sid, note); toast('Note saved');
      } catch { /* shown */ }
    }));
    $$('[data-del-step]', dlg).forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this step?')) return;
      try { await q(sb.from('procedure_steps').update({ active: false }).eq('step_id', Number(b.dataset.delStep))); await reloadP(); } catch { /* shown */ }
    }));
    const move = async (id, dir) => {
      const st = all.find((x) => x.step_id === id);
      const list = st.equipment_id != null ? extra : groupOf(st.system_type ?? null);
      const i = list.indexOf(st), o = list[i + dir];
      if (!o) return;
      try {
        await q(sb.from('procedure_steps').update({ position: o.position }).eq('step_id', st.step_id));
        await q(sb.from('procedure_steps').update({ position: st.position === o.position ? st.position + dir : st.position }).eq('step_id', o.step_id));
        await reloadP();
      } catch { /* shown */ }
    };
    $$('[data-up]', dlg).forEach((b) => (b.onclick = () => move(Number(b.dataset.up), -1)));
    $$('[data-down]', dlg).forEach((b) => (b.onclick = () => move(Number(b.dataset.down), 1)));
    $$('[data-photo]', dlg).forEach((inp) => (inp.onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const blob = await shrinkImage(f, 1600);
        const path = `procedures/${p.procedure_id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
        const { error } = await sb.storage.from('maintenance').upload(path, blob, { contentType: blob.type || 'image/jpeg' });
        if (error) throw error;
        await q(sb.from('procedure_steps').update({ photo_path: path }).eq('step_id', Number(inp.dataset.photo)));
        await reloadP();
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, true); }
    }));
    $$('[data-rm-photo]', dlg).forEach((b) => (b.onclick = async () => {
      const st = all.find((x) => x.step_id === Number(b.dataset.rmPhoto));
      try { await sb.storage.from('maintenance').remove([st.photo_path]); await q(sb.from('procedure_steps').update({ photo_path: null }).eq('step_id', st.step_id)); await reloadP(); } catch { /* shown */ }
    }));
  };
  await loadUrls();
  draw();
  dlg.classList.add('wide');
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// =====================================================================
// QR labels: each machine gets a code that opens its card in the app.
// =====================================================================
const equipLink = (id) => `${location.origin}${location.pathname}#eq=${id}`;
const loadScript = (src, global) => (window[global] ? Promise.resolve(window[global]) : new Promise((res, rej) => {
  const sc = document.createElement('script'); sc.src = src; sc.onload = () => res(window[global]); sc.onerror = () => rej(new Error('Could not load ' + src));
  document.head.appendChild(sc);
}));
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const JSQR_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

async function qrSvg(text, cell = 4) {
  const qrcode = await loadScript(QR_LIB, 'qrcode');
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

function openQrLabels(rows) {
  const list = (rows ?? refs.equipment).filter((e) => e.active).sort(eqSort);
  const dlg = $('#dialog');
  dlg.classList.add('wide');
  dlg.innerHTML = `<form class="form">
    <div class="dialog-head"><h3>Print QR labels</h3><p class="muted small">Scanning a label opens that machine in the app (after signing in).</p></div>
    <div class="row2"><label>Category<select data-qcat><option value="">All</option>${EQ_BANDS.filter(([k]) => list.some((e) => eqCat(e) === k)).map(([k, l, b]) => `<option value="${k}">${b}s · ${esc(l)}</option>`).join('')}</select></label>
      <label>Label size<select data-qsize><option value="2">2 in (6 per row)</option><option value="1.5">1.5 in</option><option value="3">3 in</option></select></label></div>
    <div class="lines-head"><b>Equipment</b><span><button type="button" class="small" data-all="1">All</button> <button type="button" class="small" data-all="0">None</button></span></div>
    <div class="pick-list" id="qr-list"></div>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Print</button></div></form>`;
  const draw = () => {
    const cat = $('[data-qcat]', dlg).value;
    $('#qr-list', dlg).innerHTML = list.filter((e) => !cat || eqCat(e) === cat).map((e) => `<label class="check"><input type="checkbox" value="${e.equipment_id}" checked> ${esc(eqLabel(e))}</label>`).join('');
  };
  $('[data-qcat]', dlg).onchange = draw; draw();
  $$('[data-all]', dlg).forEach((b) => (b.onclick = () => $$('#qr-list input', dlg).forEach((c) => (c.checked = b.dataset.all === '1'))));
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  $('form', dlg).onsubmit = async (e) => {
    e.preventDefault();
    const ids = $$('#qr-list input:checked', dlg).map((c) => Number(c.value));
    if (!ids.length) return toast('Pick at least one', true);
    const size = Number($('[data-qsize]', dlg).value);
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print labels', true);
    w.document.write('<p style="font:14px sans-serif">Making labels…</p>');
    try {
      const labels = [];
      for (const id of ids) {
        const eq = refs.equipment.find((x) => x.equipment_id === id);
        labels.push(`<div class="lab"><div class="qr">${await qrSvg(equipLink(id))}</div><div class="num">${eqNum(eq) != null ? '#' + eqNum(eq) : ''}</div><div class="nm">${esc(eq.name)}</div></div>`);
      }
      w.document.open();
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Equipment QR labels</title><style>
        body { font-family: Arial, sans-serif; margin: .3in; }
        .grid { display: flex; flex-wrap: wrap; gap: .15in; }
        .lab { width: ${size}in; border: 1px dashed #bbb; padding: .08in; text-align: center; break-inside: avoid; }
        .qr svg { width: 100%; height: auto; display: block; }
        .num { font-weight: 700; font-size: ${Math.max(10, size * 9)}pt; margin-top: .03in; }
        .nm { font-size: ${Math.max(7, size * 4.5)}pt; line-height: 1.15; }
        @media print { .lab { border-color: #ddd; } .tip { display: none; } }
      </style></head><body><p class="tip" style="font-size:12px;color:#666">Print at 100% (no "fit to page"). Cut on the dashed lines.</p>
      <div class="grid">${labels.join('')}</div><script>setTimeout(() => print(), 400)<\/script></body></html>`);
      w.document.close();
      dlg.close();
    } catch (err) { w.close(); toast(err.message, true); }
  };
  dlg.onclose = () => dlg.classList.remove('wide');
  if (!dlg.open) dlg.showModal();
}

// In-app scanner: the phone camera, decoded with the browser's BarcodeDetector or jsQR.
async function openScanner() {
  const dlg = $('#dialog');
  dlg.classList.remove('wide');
  dlg.innerHTML = `<div class="form scan-form"><div class="dialog-head"><h3>Scan a QR label</h3></div>
    <video playsinline muted></video><p class="muted small" id="scan-msg">Point the camera at the label.</p>
    <div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Cancel</button></div></div>`;
  let stream = null, stop = false;
  const end = () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  dlg.onclose = end;
  $('[data-act=cancel]', dlg).onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  const video = $('video', dlg);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream; await video.play();
  } catch {
    $('#scan-msg', dlg).textContent = 'Camera not available. Allow camera access, or scan the label with your phone’s camera app instead.';
    return;
  }
  let detect;
  if ('BarcodeDetector' in window) {
    const bd = new window.BarcodeDetector({ formats: ['qr_code'] });
    detect = async () => (await bd.detect(video))[0]?.rawValue ?? null;
  } else {
    const jsQR = await loadScript(JSQR_LIB, 'jsQR');
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      if (!video.videoWidth) return null;
      const k = Math.min(1, 640 / video.videoWidth);
      c.width = video.videoWidth * k; c.height = video.videoHeight * k;
      ctx.drawImage(video, 0, 0, c.width, c.height);
      return jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data ?? null;
    };
  }
  const loop = async () => {
    if (stop) return;
    let text = null;
    try { text = await detect(); } catch { /* keep trying */ }
    const m = text?.match(/eq=(\d+)/);
    if (m) { dlg.close(); openEquipCard(Number(m[1])); return; }
    if (text) $('#scan-msg', dlg).textContent = 'That code isn’t an equipment label.';
    setTimeout(loop, 250);
  };
  loop();
}

// What you get after scanning: the machine, its open repairs and service due, and quick actions.
async function openEquipCard(id) {
  await loadRefs();
  const eq = refs.equipment.find((e) => e.equipment_id === id);
  const dlg = $('#dialog');
  dlg.classList.remove('wide');
  if (!eq) { dlg.innerHTML = '<div class="form"><h3>Not found</h3><p>That equipment isn’t in the app (it may have been deleted).</p><div class="actions"><span class="spacer"></span><button type="button" data-act="cancel">Close</button></div></div>'; $('[data-act=cancel]', dlg).onclick = () => dlg.close(); if (!dlg.open) dlg.showModal(); return; }
  const [jobRes, ivRes] = await Promise.all([sb.from('maint_jobs').select('*').eq('equipment_id', id), sb.from('service_intervals').select('*').eq('equipment_id', id).eq('active', true)]);
  const jobs = jobRes.data ?? [], open = jobs.filter((j) => j.status !== 'done'), ivs = ivRes.data ?? [];
  const reopen = () => openEquipCard(id);
  const engine = ENGINE_RE.test(eq.type ?? '');
  dlg.innerHTML = `<div class="form eq-card">
    <div class="dialog-head"><h3>${esc(eqNum(eq) != null ? `#${eqNum(eq)} ` : '')}${esc(eq.name)}</h3>
      <p class="muted small">${esc([eq.type, eq.make, eq.model, eq.model_year, eqFields(eq).length ? 'field ' + eqFields(eq).join(', ') : ''].filter(Boolean).join(' · '))}</p></div>
    <div class="eq-actions">
      <button type="button" class="primary" data-act="problem">Report a problem</button>
      <button type="button" data-act="service">Log service</button>
      <label class="btn">Add photo<input type="file" accept="image/*" capture="environment" hidden data-act="photo"></label>
      <button type="button" data-act="checked">Checked today</button>
    </div>
    ${engine ? `<div class="row hours-row"><label>Hours now<input type="number" inputmode="decimal" step="0.1" min="0" data-hours placeholder="${eq.hours != null ? num(eq.hours, 0) : ''}"></label><button type="button" data-act="hours">Update</button>
      <span class="muted small">${eq.hours != null ? `last ${num(eq.hours, 0)}${eq.hours_date ? ' on ' + fmtDateY(eq.hours_date) : ''}` : 'no hours yet'}</span></div>` : ''}
    <div class="lines-head"><b>Open repairs</b><span class="muted small">${open.length || 'none'}</span></div>
    ${open.length ? `<ul class="list">${open.map((j) => `<li><span class="li-name">${esc(j.title)} ${j.down ? '<span class="badge bad">DOWN</span>' : ''}<span class="muted small">${jobStatusName(j.status)} · ${fmtDateY(j.reported_on)}</span></span><span class="li-value"><button type="button" class="small" data-job="${j.job_id}">Open</button></span></li>`).join('')}</ul>` : ''}
    ${ivs.length ? `<div class="lines-head"><b>Service</b></div><ul class="list">${ivs.map((iv) => { const d = serviceDue(iv, eq, jobs); return `<li class="due-${d.state}"><span class="li-name">${esc(iv.name)}<span class="small">${dueText(d, iv, eq)}</span></span><span class="li-value"><button type="button" class="small" data-svc="${iv.interval_id}">Done</button></span></li>`; }).join('')}</ul>` : ''}
    <div class="actions"><span class="spacer"></span><button type="button" data-act="close">Close</button></div></div>`;
  $('[data-act=close]', dlg).onclick = () => dlg.close();
  $('[data-act=problem]', dlg).onclick = () => openJob({ equipmentId: id }, null);
  $('[data-act=service]', dlg).onclick = () => openJob({ kind: 'service', status: 'done', equipmentId: id }, null);
  $$('[data-job]', dlg).forEach((b) => (b.onclick = () => openJob({ jobId: Number(b.dataset.job) }, null)));
  $$('[data-svc]', dlg).forEach((b) => (b.onclick = () => { const iv = ivs.find((x) => x.interval_id === Number(b.dataset.svc)); openJob({ kind: 'service', status: 'done', equipmentId: id, intervalId: iv.interval_id, title: iv.name }, null); }));
  $('[data-act=checked]', dlg).onclick = async () => { try { await q(sb.from('equipment').update({ verified_on: localDate() }).eq('equipment_id', id)); toast('Marked checked today'); } catch { /* shown */ } };
  $('[data-act=hours]', dlg)?.addEventListener('click', async () => {
    const v = Number($('[data-hours]', dlg).value);
    if (!(v > 0)) return toast('Enter the hours', true);
    if (eq.hours != null && v < Number(eq.hours) && !confirm(`That's less than the last reading (${num(eq.hours, 0)}). Save anyway?`)) return;
    try { await q(sb.from('equipment').update({ hours: v, hours_date: localDate() }).eq('equipment_id', id)); toast('Hours updated'); reopen(); } catch { /* shown */ }
  });
  $('[data-act=photo]', dlg).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const blob = await shrinkImage(f);
      const path = `${id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
      const { error } = await sb.storage.from('equipment').upload(path, blob, { contentType: blob.type || 'image/jpeg' });
      if (error) throw error;
      await q(sb.from('equipment_photos').insert({ equipment_id: id, path }));
      await q(sb.from('equipment').update({ verified_on: localDate() }).eq('equipment_id', id));
      toast('Photo added');
    } catch (err) { toast(`Upload failed: ${err.message ?? err}`, true); }
  };
  if (!dlg.open) dlg.showModal();
}

async function renderSetup(el) {
  const tabs = ['riders', 'turnouts', 'crops', 'operators', 'chemicals', 'equipment', 'worktypes', 'costs', 'customers', 'leases'];
  el.innerHTML = `<div class="subtabs">${tabs.map((t) =>
    `<button data-tab="${t}" class="${t === setupTab ? 'active' : ''}">${esc(t === 'costs' ? 'Cost rates' : CRUD[t].title)}</button>`).join('')}</div>
    <div id="setup-body"><p class="muted">Loading…</p></div>`;
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { setupTab = b.dataset.tab; renderSetup(el); }));
  if (setupTab === 'costs') return renderCostRates($('#setup-body', el));
  await renderCrud(CRUD[setupTab], $('#setup-body', el));
}

// Setup -> Cost rates: one $/acre per work type and per application method; machine overrides live on Equipment.
async function renderCostRates(el) {
  await loadRefs();
  const ready = refs.workTypes.length && 'cost_per_acre' in refs.workTypes[0];
  if (!ready || !refs.appRates.length) { el.innerHTML = '<div class="empty">Cost rates aren’t set up yet. Run <b>work_costs.sql</b> in Supabase first.</div>'; return; }
  const overrides = refs.equipment.filter((e) => e.cost_per_acre != null);
  const yr = new Date().getFullYear();
  el.innerHTML = `
    <div class="card"><h3>Work passes ($/acre)</h3>
      <p class="muted small">Used for every pass of that work type unless the implement or machine has its own rate (Setup → Equipment).</p>
      <div class="rate-grid">${refs.workTypes.filter((w) => w.active || w.cost_per_acre != null).map((w) => `<label>${esc(workLabel(w.operation))}
        <span class="money-in"><span>$</span><input type="number" inputmode="decimal" step="0.01" min="0" data-op="${esc(w.operation)}" value="${w.cost_per_acre ?? ''}"><span class="muted">/ac</span></span></label>`).join('')}</div></div>
    <div class="card"><h3>Chemical applications ($/acre)</h3>
      <p class="muted small">Application cost only (the pass, not the product). Ground spray uses the sprayer's own rate if it has one.</p>
      <div class="rate-grid">${METHODS.map(([m, label]) => { const r = refs.appRates.find((x) => x.method === m); return `<label>${esc(label)}
        <span class="money-in"><span>$</span><input type="number" inputmode="decimal" step="0.01" min="0" data-method="${m}" value="${r?.cost_per_acre ?? ''}"><span class="muted">/ac</span></span></label>`; }).join('')}</div></div>
    <div class="card"><h3>Machine overrides</h3>
      ${overrides.length ? `<ul class="list">${overrides.map((e) => `<li><span class="li-name">${esc(e.name)} <span class="muted small">${esc((e.equipment_work_types ?? []).map((x) => workLabel(x.operation)).join(', '))}</span></span><span class="li-value">${money(e.cost_per_acre)}/ac</span></li>`).join('')}</ul>`
        : '<p class="muted small">None. Set one on an implement or machine under Setup → Equipment when it costs more or less than its work type (a ripper vs. a disk, say).</p>'}</div>
    <div class="card"><h3>Recalculate a season</h3>
      <p class="muted small">Each record keeps the rate it was saved with, so changing a rate here doesn't change past records. To apply today's rates to a whole season, recalculate it.</p>
      <div class="row"><select id="recalc-yr">${[yr + 1, yr, yr - 1, yr - 2, yr - 3].map((y) => `<option ${y === yr ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <button type="button" data-act="recalc">Recalculate costs</button></div>
      <p class="muted small" id="recalc-msg"></p></div>`;
  const saveRate = async (inp, table, key, id) => {
    const v = inp.value === '' ? null : Number(inp.value);
    try { await q(sb.from(table).update({ cost_per_acre: v }).eq(key, id)); toast('Rate saved'); await loadRefs(); } catch { /* shown */ }
  };
  $$('[data-op]', el).forEach((i) => (i.onchange = () => saveRate(i, 'operation_types', 'operation', i.dataset.op)));
  $$('[data-method]', el).forEach((i) => (i.onchange = () => saveRate(i, 'application_rates', 'method', i.dataset.method)));
  $('[data-act=recalc]', el).onclick = async () => {
    const y = $('#recalc-yr', el).value;
    if (!confirm(`Replace the saved costs on every ${y} work and chemical record with today's rates?`)) return;
    const msg = $('#recalc-msg', el); msg.textContent = 'Working…';
    try {
      const works = await q(sb.from('work_events').select('event_id, operation, equipment_id, acres').gte('performed_on', `${y}-01-01`).lte('performed_on', `${y}-12-31`));
      for (const w of works) {
        const r = workRate(w.operation, w.equipment_id);
        await q(sb.from('work_events').update({ cost_per_acre: r.rate, cost_basis: r.basis, cost_total: r.rate != null && w.acres != null ? Math.round(r.rate * w.acres * 100) / 100 : null }).eq('event_id', w.event_id));
      }
      const chems = await q(sb.from('chemical_events').select('event_id, method, sprayer_id').gte('applied_on', `${y}-01-01`).lte('applied_on', `${y}-12-31`));
      for (const c of chems) {
        const r = appRate(c.method, c.sprayer_id);
        await q(sb.from('chemical_events').update({ app_cost_per_acre: r.rate, app_cost_basis: r.basis }).eq('event_id', c.event_id));
      }
      msg.textContent = `Updated ${works.length} work and ${chems.length} chemical record(s) for ${y}.`;
    } catch { msg.textContent = 'Stopped on an error; some records may not be updated.'; }
  };
}

// =====================================================================
// Tools: specialized calculators.
// =====================================================================
const G_PER_LB = 453.592;
let toolOpen = 'gp-cal';
const TOOLS = [
  { id: 'gp-cal', title: 'Great Plains drill calibration', blurb: 'Grams from one seed tube over 0.1 acre → lb/acre', render: renderGpCal },
  { id: 'ss-cal', title: 'Seed Spider calibration', blurb: 'Grams from one bin over a timed run → lb/acre at your speed', render: renderSsCal },
  { id: 'mono', title: 'Monosem sprockets', blurb: 'Seed plate + spacing → transmission sprockets', render: renderMonoCal },
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

// Monosem transmission (sowing distances table, manual p.35). Every value in the table fits
// spacing = 109.25 × B ÷ A ÷ holes, so plates not in the table use the same formula.
const MONO_A = [26, 24, 23, 26, 24, 23, 24, 23, 19, 19, 17, 18, 19, 17, 18, 17, 14, 14, 14];
const MONO_B = [17, 17, 19, 23, 23, 24, 26, 26, 23, 24, 23, 26, 28, 26, 28, 28, 24, 26, 28];
const MONO_K = 109.25;
const MONO_TABLE = {
  9: [7.9, 8.6, 10.0, 10.7, 11.6, 12.7, 13.1, 13.7, 14.7, 15.3, 16.4, 17.5, 17.9, 18.6, 18.9, 20.0, 20.8, 22.5, 24.3],
  12: [6.0, 6.4, 7.5, 8.1, 8.7, 9.5, 9.9, 10.3, 11.0, 11.5, 12.3, 13.1, 13.4, 13.9, 14.2, 15.0, 15.6, 16.9, 18.2],
  18: [4.0, 4.3, 5.0, 5.4, 5.8, 6.3, 6.6, 6.9, 7.3, 7.7, 8.2, 8.8, 8.9, 9.3, 9.4, 10.0, 10.4, 11.3, 12.1],
  24: [3.0, 3.2, 3.8, 4.0, 4.4, 4.7, 4.9, 5.1, 5.5, 5.7, 6.2, 6.6, 6.7, 7.0, 7.1, 7.5, 7.8, 8.5, 9.1],
  30: [2.4, 2.6, 3.0, 3.2, 3.5, 3.8, 3.9, 4.1, 4.4, 4.6, 4.9, 5.3, 5.4, 5.6, 5.7, 6.0, 6.2, 6.8, 7.3],
  36: [2.0, 2.1, 2.5, 2.7, 2.9, 3.2, 3.3, 3.4, 3.7, 3.8, 4.1, 4.4, 4.5, 4.6, 4.7, 5.0, 5.2, 5.6, 6.1],
  40: [1.8, 1.9, 2.3, 2.4, 2.6, 2.8, 3.0, 3.1, 3.3, 3.4, 3.7, 3.9, 4.0, 4.2, 4.2, 4.5, 4.7, 5.1, 5.5],
  48: [1.5, 1.6, 1.9, 2.0, 2.2, 2.4, 2.5, 2.6, 2.8, 2.9, 3.1, 3.3, 3.4, 3.5, 3.5, 3.7, 3.9, 4.2, 4.6],
  60: [1.2, 1.3, 1.5, 1.6, 1.7, 1.9, 2.0, 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.8, 3.0, 3.1, 3.4, 3.6],
  72: [1.0, 1.1, 1.3, 1.3, 1.5, 1.6, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 3.0],
  90: [0.79, 0.86, 1.00, 1.07, 1.16, 1.27, 1.31, 1.37, 1.47, 1.53, 1.64, 1.75, 1.79, 1.86, 1.89, 2.00, 2.08, 2.25, 2.43],
  120: [0.60, 0.64, 0.75, 0.81, 0.87, 0.95, 0.99, 1.03, 1.10, 1.15, 1.23, 1.31, 1.34, 1.39, 1.42, 1.50, 1.56, 1.69, 1.82],
};
const SQIN_PER_AC = 43560 * 144;

function renderMonoCal(box) {
  let st = { holes: '24', other: '', mode: 'spacing', spacing: '', pop: '', row: 22, measured: '', measuredCombo: '' };
  try { st = { ...st, ...JSON.parse(localStorage.getItem('mono-cal') || '{}') }; } catch { /* storage unavailable */ }
  const save = () => { try { localStorage.setItem('mono-cal', JSON.stringify(st)); } catch { /* ignore */ } };
  const holesOf = () => (st.holes === 'other' ? Number(st.other) : Number(st.holes));
  const exact = (i, h) => (MONO_K * MONO_B[i]) / MONO_A[i] / h;
  const combos = (h) => MONO_A.map((a, i) => ({ i, a, b: MONO_B[i], sp: MONO_TABLE[h]?.[i] ?? exact(i, h) }));
  const popOf = (sp) => (sp > 0 && st.row > 0 ? SQIN_PER_AC / (Number(st.row) * sp) : null);
  const fmtPop = (p) => (p == null ? '—' : Math.round(p / 10) * 10).toLocaleString();
  const fmtSp = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

  const draw = () => {
    box.innerHTML = `
      <h3>Monosem sprocket selection</h3>
      <div class="cal-grid">
        <div class="cal-inputs">
          <label>Seed plate (holes)<select data-f="holes">
            ${Object.keys(MONO_TABLE).map((h) => `<option value="${h}" ${st.holes === h ? 'selected' : ''}>${h} holes</option>`).join('')}
            <option value="other" ${st.holes === 'other' ? 'selected' : ''}>Other…</option></select></label>
          ${st.holes === 'other' ? '<label>Holes in the plate<input type="number" inputmode="numeric" min="1" data-k="other" value="' + esc(st.other) + '"></label>' : ''}
          <div class="seg" role="group" aria-label="Enter by">
            <button type="button" data-mode="spacing" class="${st.mode === 'spacing' ? 'on' : ''}">Seed spacing<small>inches</small></button>
            <button type="button" data-mode="pop" class="${st.mode === 'pop' ? 'on' : ''}">Seeds per acre<small>population</small></button>
          </div>
          ${st.mode === 'spacing'
            ? `<label>Target seed spacing (in)<input type="number" inputmode="decimal" step="any" min="0" data-k="spacing" value="${esc(st.spacing)}"></label>`
            : `<label>Target seeds per acre<input type="number" inputmode="numeric" step="any" min="0" data-k="pop" value="${esc(st.pop)}"></label>`}
          <label>Row spacing (in)<input type="number" inputmode="decimal" step="any" min="0" data-k="row" value="${esc(st.row)}"></label>
          <details class="cal-adv" ${st.measured ? 'open' : ''}><summary>Field check</summary>
            <p class="muted small">After planting a pass, measure the average seed spacing (e.g. the length of 20 seeds ÷ 20) and enter it with the sprockets you ran. Picks are then corrected for what the planter actually does.</p>
            <div class="row2">
              <label>Sprockets run (A upper / B lower)<select data-k="measuredCombo"><option value="">—</option>${MONO_A.map((a, i) => `<option value="${i}" ${String(st.measuredCombo) === String(i) ? 'selected' : ''}>${a} / ${MONO_B[i]}</option>`).join('')}</select></label>
              <label>Measured spacing (in)<input type="number" inputmode="decimal" step="any" min="0" data-k="measured" value="${esc(st.measured)}"></label>
            </div>
            <div class="muted small" id="mono-factor"></div>
          </details>
        </div>
        <div class="cal-out" id="cal-out"></div>
      </div>
      <div class="cal-steps"><h4>Notes</h4><ol>
        <li>Driver A is the upper sprocket (driver); Driver B is the lower sprocket (driven), as in the Monosem manual's sowing distance table.</li>
        <li>Spacing assumes every hole drops one seed. Doubles and skips change the real spacing, so check it in the field.</li>
      </ol></div>`;
    calc(); wire();
  };

  const calc = () => {
    const h = holesOf();
    const target = st.mode === 'spacing' ? Number(st.spacing) : Number(st.pop) > 0 && st.row > 0 ? SQIN_PER_AC / (Number(st.row) * Number(st.pop)) : 0;
    // Field factor: measured ÷ expected for the combo that was run on this plate.
    let factor = 1;
    const fEl = $('#mono-factor', box);
    const mh = Number(st.measuredHoles) || h;
    if (st.measured && st.measuredCombo !== '' && mh > 0) {
      const exp = combos(mh)[Number(st.measuredCombo)].sp;
      factor = Number(st.measured) / exp;
      fEl.innerHTML = `Expected ${fmtSp(exp)}" with the ${mh}-hole plate; measured ${st.measured}". Seeds are landing <b>${((factor - 1) * 100).toFixed(1)}% ${factor >= 1 ? 'farther apart' : 'closer together'}</b> than the table. Picks below are corrected.`;
    } else if (fEl) fEl.textContent = '';
    const out = $('#cal-out', box);
    if (!(h > 0)) { out.innerHTML = '<p class="muted">Pick a seed plate.</p>'; return; }
    if (!(target > 0)) { out.innerHTML = `<p class="muted">Enter the target ${st.mode === 'spacing' ? 'seed spacing' : 'seeds per acre'}.</p>`; return; }
    const ranked = combos(h).map((c) => ({ ...c, real: c.sp * factor, off: (c.sp * factor / target - 1) * 100 })).sort((x, y) => Math.abs(x.off) - Math.abs(y.off));
    const best = ranked[0];
    const tone = Math.abs(best.off) <= 3 ? 'ok' : Math.abs(best.off) <= 8 ? 'warn' : 'bad';
    const inTable = !!MONO_TABLE[h];
    // Best combo on every other plate, to show when a plate change gets closer.
    const plates = Object.keys(MONO_TABLE).map(Number).map((ph) => {
      const r = combos(ph).map((c) => ({ ...c, off: (c.sp * factor / target - 1) * 100 })).sort((x, y) => Math.abs(x.off) - Math.abs(y.off))[0];
      return { ph, ...r };
    });
    const better = plates.filter((p) => p.ph !== h && Math.abs(p.off) < Math.abs(best.off) - 0.5).sort((x, y) => Math.abs(x.off) - Math.abs(y.off));
    out.innerHTML = `
      <div class="cal-stat ${tone}"><span class="stat-label">Use these sprockets · ${h}-hole plate</span>
        <span class="cal-settings"><span>Driver A <span class="muted small">upper · driver</span> <b class="stat-value">${best.a}</b></span><span>Driver B <span class="muted small">lower · driven</span> <b class="stat-value">${best.b}</b></span></span>
        <span class="cal-diff">${fmtSp(best.real)}" spacing · ${fmtPop(popOf(best.real))} seeds/ac · ${best.off >= 0 ? '+' : ''}${best.off.toFixed(1)}% ${best.off >= 0 ? 'farther' : 'closer'} than target</span>
        <span class="muted small">Target ${fmtSp(target)}" (${fmtPop(popOf(target))} seeds/ac at ${st.row}" rows).${inTable ? '' : ' This plate isn’t in the table; spacing is figured from the table’s formula.'}${factor !== 1 ? ' Corrected with your field check.' : ''}</span></div>
      <div class="cal-stat"><span class="stat-label">Next closest on this plate</span>
        <table class="cal-rows"><thead><tr><th>A / B</th><th>Spacing</th><th>Seeds/ac</th><th>vs target</th></tr></thead><tbody>
        ${ranked.slice(1, 4).map((c) => `<tr><td>${c.a} / ${c.b}</td><td>${fmtSp(c.real)}"</td><td>${fmtPop(popOf(c.real))}</td><td>${c.off >= 0 ? '+' : ''}${c.off.toFixed(1)}%</td></tr>`).join('')}
        </tbody></table></div>
      ${better.length && Math.abs(best.off) > 2 ? `<div class="cal-stat"><span class="stat-label">Closer with a different plate</span>
        <table class="cal-rows"><thead><tr><th>Plate</th><th>A / B</th><th>Spacing</th><th>vs target</th></tr></thead><tbody>
        ${better.slice(0, 3).map((p) => `<tr><td>${p.ph} holes</td><td>${p.a} / ${p.b}</td><td>${fmtSp(p.sp * factor)}"</td><td>${p.off >= 0 ? '+' : ''}${p.off.toFixed(1)}%</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
  };

  const wire = () => {
    $('[data-f=holes]', box).onchange = (e) => { st.holes = e.target.value; save(); draw(); };
    $$('[data-mode]', box).forEach((b) => (b.onclick = () => { st.mode = b.dataset.mode; save(); draw(); }));
    $$('[data-k]', box).forEach((i) => (i.oninput = i.onchange = () => {
      if (!i.isConnected) return; // late change event from an input that was just redrawn
      const changed = String(st[i.dataset.k] ?? '') !== i.value;
      st[i.dataset.k] = i.value;
      if (changed && (i.dataset.k === 'measured' || i.dataset.k === 'measuredCombo') && holesOf() > 0) st.measuredHoles = holesOf(); // the plate the check was run on
      save(); calc();
    }));
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
  maint: renderMaint,
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
  await show(currentView);
  openFromHash();
}
// A QR label holds the app link + #eq=<id>; opening it (camera app or in-app scan) shows that machine's card.
function openFromHash() {
  const m = location.hash.match(/eq=(\d+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  openEquipCard(Number(m[1]));
}
window.addEventListener('hashchange', () => { if (started) openFromHash(); });

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

// Phones: list rows are cards; tapping anywhere on a row opens it (its Edit / Open button).
const PHONE = window.matchMedia('(max-width: 700px)');
document.addEventListener('click', (e) => {
  if (!PHONE.matches) return;
  const tr = e.target.closest('table.m-cards tbody tr');
  if (!tr || e.target.closest('button, a, input, select, textarea, label')) return;
  const btn = tr.querySelector('[data-edit], [data-open], [data-job], [data-task], [data-edit-cy]') ?? [...tr.querySelectorAll('td:last-child button')].at(-1);
  btn?.click();
});

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
