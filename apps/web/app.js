/**
 * Data Workbench 2.0 — Local-First Visual Data Transformation & Automation Studio (Web UI)
 * Shares the exact same deterministic packages/* engine as the CLI and MCP Server.
 */

import { parseCsv, serializeCsv, detectCsvDialect } from '../../packages/csv-engine/index.js';
import { parseXlsx, serializeXlsx } from '../../packages/xlsx-engine/index.js';
import {
  formatJson,
  validateJson,
  parseNdjson,
  serializeNdjson,
  flattenObject,
  unflattenObject,
  jsonToTabular,
  queryJsonPath,
  parseYaml,
  serializeYaml,
  parseXml
} from '../../packages/json-engine/index.js';
import { profileDataset, suggestFixes, explainDataset } from '../../packages/quality-engine/index.js';
import { diffTables, diffJson, formatDiffReport } from '../../packages/diff-engine/index.js';
import {
  generateJsonSchema,
  createSchemaSnapshot,
  diffSchemaSnapshots,
  validateDataContract
} from '../../packages/workflow-schema/index.js';
import { listNodes, getNodeDefinition } from '../../packages/node-registry/index.js';
import {
  executeWorkflow,
  WorkflowRecorder,
  runRegressionTests,
  compileNaturalLanguagePlan,
  generateCodeViews,
  exportWorkflowPackage,
  ENGINE_VERSION
} from '../../packages/workflow-core/index.js';
import {
  MESSY_CUSTOMERS_CSV,
  API_RESPONSE_JSON,
  PRODUCT_CATALOG_V1_CSV,
  PRODUCT_CATALOG_V2_CSV,
  SAMPLE_CLEAN_WORKFLOW
} from '../../packages/test-fixtures/index.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function safeCopyText(text) {
  try {
if (navigator.clipboard && navigator.clipboard.writeText) {
  await navigator.clipboard.writeText(text);
  return true;
}
  } catch {}
  try {
const ta = document.createElement('textarea');
ta.value = text;
ta.style.position = 'fixed';
ta.style.left = '-9999px';
ta.style.opacity = '0';
document.body.appendChild(ta);
ta.select();
const ok = document.execCommand('copy');
ta.remove();
return ok;
  } catch {
return false;
  }
}

function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SEO_TOOLS = [
  { id: 'csv-cleaner', name: 'CSV Cleaner', desc: 'Auto-detect dialect, fix whitespace/dates/duplicates, inspect Quality Radar.' },
  { id: 'json-formatter', name: 'JSON Formatter', desc: 'Pretty-print, minify, and sort keys deterministically.' },
  { id: 'json-validator', name: 'JSON Validator', desc: 'Validate JSON syntax with exact line & column diagnostics.' },
  { id: 'json-diff', name: 'JSON Diff', desc: 'Path-level, value-level, and array comparison with tolerance options.' },
  { id: 'csv-to-json', name: 'CSV to JSON', desc: 'Convert RFC 4180 CSV tables to clean JSON arrays.' },
  { id: 'json-to-csv', name: 'JSON to CSV', desc: 'Flatten nested JSON to formula-safe CSV.' },
  { id: 'csv-deduplicator', name: 'CSV Deduplicator', desc: 'Remove duplicates by single or composite key (keep first/last).' },
  { id: 'compare-two-csv-files', name: 'Compare Two CSV Files', desc: 'Primary-key diff showing added, removed, and cell-level changes.' },
  { id: 'json-schema-generator', name: 'JSON Schema Generator', desc: 'Generate JSON Schema 2020-12 from any sample payload.' },
  { id: 'json-path-tester', name: 'JSONPath Tester (RFC 9535)', desc: 'Evaluate RFC 9535 JSONPath queries with normalized path output.' }
];

const state = {
  theme: 'dark',
  cmdOpen: false,
  cmdQuery: '',
  toast: '',
  nodeSearch: '',
  fileDragOver: false,
  colMenu: null,
  shieldPulse: false,
  kpiFresh: false,
  wiringFrom: null,
  gridScrollTop: 0,
  mode: 'onboarding', // onboarding | table | canvas | code | diff | schema | tools
  inspectorTab: 'node', // node | fixes | diff | explain | copilot
  codeTab: 'sql', // sql | json | cli
  activeTool: 'csv-cleaner',
  fileName: 'messy-customers.csv',
  rawInput: MESSY_CUSTOMERS_CSV,
  inputKind: 'csv',
  dataset: parseCsv(MESSY_CUSTOMERS_CSV),
  dialect: detectCsvDialect(MESSY_CUSTOMERS_CSV),
  profile: null,
  fixes: [],
  explanation: null,
  recorder: new WorkflowRecorder(SAMPLE_CLEAN_WORKFLOW),
  selectedNodeId: 'input-1',
  nodePositions: {},
  canvasZoom: 1,
  lastRun: null,
  isRunning: false,
  activeWorker: null,
  activeAbort: null,
  executionMode: 'worker',
  estimatedBytes: 0,
  runHistory: [],
  filterIssueRows: null, // Set of row indices or null
  searchQuery: '',
  sampleMode: false, // Smart Sample & Scale-up indicator
  // Diff state
  diffLeftText: PRODUCT_CATALOG_V1_CSV,
  diffRightText: PRODUCT_CATALOG_V2_CSV,
  diffKey: 'sku',
  diffMode: 'csv', // csv | json
  diffResult: null,
  // Schema & Contract state
  schemaSnapshots: [],
  schemaDrift: null,
  contractText: JSON.stringify({
    requiredColumns: ['customer_id', 'email', 'signup_date'],
    minRows: 1,
    maxNullRate: { customer_id: 0, email: 0.05 }
  }, null, 2),
  contractResult: null,
  regressionText: JSON.stringify({
    expectedColumns: ['customer_id', 'email', 'signup_date'],
    uniqueKeys: ['customer_id'],
    maxRowDropRatio: 0.5
  }, null, 2),
  regressionResult: null,
  // Copilot state
  copilotPrompt: '把邮箱统一转小写，删除重复订单，日期统一成 ISO 格式，最后导出 JSON',
  copilotPlan: null,
  // SEO Tool scratchpad
  toolInputA: API_RESPONSE_JSON,
  toolInputB: '',
  toolParam: '$.data[?@.status == "paid"].order_id',
  toolOutput: ''
};

function recomputeAnalysis() {
  state.profile = profileDataset(state.dataset);
  state.fixes = suggestFixes(state.dataset, state.profile);
  state.explanation = explainDataset(state.dataset, state.profile);
  state.sampleMode = state.dataset.rows.length > 5000;
}

function layoutNodesAuto() {
  const wf = state.recorder.getWorkflow().workflow;
  wf.nodes.forEach((n, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    state.nodePositions[n.id] = { x: 40 + col * 270, y: 40 + row * 130 };
  });
}

function loadRawData(name, text) {
  state.fileName = name;
  state.rawInput = text;
  state.filterIssueRows = null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) {
    state.inputKind = 'json';
    const v = validateJson(text);
    if (!v.valid) {
      alert(`JSON syntax error at L${v.line}:C${v.column}: ${v.error}`);
      return;
    }
    state.dataset = jsonToTabular(v.data);
    state.dialect = null;
    state.recorder = new WorkflowRecorder({
      schemaVersion: '1.0',
      workflow: {
        id: 'json-workflow',
        name: `${name} Pipeline`,
        engineVersion: ENGINE_VERSION,
        nodes: [{ id: 'input-1', type: 'source.json', version: '1.0.0', params: { flatten: true } }],
        edges: []
      }
    });
  } else if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) {
    state.inputKind = 'ndjson';
    const { rows } = parseNdjson(text);
    state.dataset = jsonToTabular(rows);
    state.dialect = null;
  } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    state.inputKind = 'yaml';
    state.dataset = jsonToTabular(parseYaml(text));
    state.dialect = null;
  } else if (lower.endsWith('.xml')) {
    state.inputKind = 'xml';
    state.dataset = jsonToTabular(parseXml(text));
    state.dialect = null;
  } else {
    state.inputKind = 'csv';
    state.dialect = detectCsvDialect(text);
    state.dataset = parseCsv(text);
    state.recorder = new WorkflowRecorder({
      schemaVersion: '1.0',
      workflow: {
        id: 'csv-workflow',
        name: `${name} Cleanup`,
        engineVersion: ENGINE_VERSION,
        nodes: [{ id: 'input-1', type: 'source.csv', version: '1.0.0', params: { header: true, delimiter: 'auto' } }],
        edges: []
      }
    });
  }
  state.selectedNodeId = 'input-1';
  layoutNodesAuto();
  recomputeAnalysis();
  state.mode = 'table';
  render();
}

function cancelCurrentWorkflow() {
  if (state.activeWorker) {
    state.activeWorker.terminate();
    state.activeWorker = null;
  }
  if (state.activeAbort) {
    state.activeAbort.abort();
    state.activeAbort = null;
  }
  state.isRunning = false;
  render();
}

function runInWorker(wfDoc, inputsByNodeId) {
  return new Promise((resolve, reject) => {
    try {
      let worker;
      if (typeof window !== 'undefined' && window.__DW_WORKER_SOURCE__) {
        const blob = new Blob([window.__DW_WORKER_SOURCE__], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        worker = new Worker(url);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        worker = new Worker('./worker.js', { type: 'module' });
      }
      state.activeWorker = worker;
      const runId = 'run_' + Date.now();
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type === 'complete' && msg.runId === runId) {
          worker.terminate();
          state.activeWorker = null;
          resolve(msg.result);
        } else if (msg.type === 'error') {
          worker.terminate();
          state.activeWorker = null;
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        state.activeWorker = null;
        reject(err);
      };
      worker.postMessage({ type: 'run', runId, workflowDoc: wfDoc, inputsByNodeId, adapter: 'auto' });
    } catch (err) {
      reject(err);
    }
  });
}

async function runCurrentWorkflow() {
  if (state.isRunning) return;
  state.isRunning = true;
  render();

  const wfDoc = state.recorder.getWorkflow();
  const firstSource = wfDoc.workflow.nodes.find(n => n.type.startsWith('source.'));
  const inputsByNodeId = firstSource ? { [firstSource.id]: state.rawInput } : {};

  let res;
  try {
    res = await runInWorker(wfDoc, inputsByNodeId);
    state.executionMode = 'worker';
  } catch {
    state.executionMode = 'main-fallback';
    state.activeAbort = new AbortController();
    res = await executeWorkflow(wfDoc, { inputsByNodeId, signal: state.activeAbort.signal });
    state.activeAbort = null;
  }

  state.isRunning = false;
  state.lastRun = res;
  const outDs = res.finalDataset || res.finalOutput;
  state.estimatedBytes = outDs?.estimatedBytes || (typeof outDs?.estimateBytes === 'function' ? outDs.estimateBytes() : 0);

  state.runHistory.unshift({
    ts: new Date().toLocaleTimeString(),
    status: res.status,
    durationMs: res.durationMs,
    rows: outDs?.rows?.length ?? 0,
    warnings: res.warnings.length,
    errors: res.errors.length
  });
  if (state.runHistory.length > 20) state.runHistory.pop();
  if (outDs && Array.isArray(outDs.rows)) {
    state.dataset = outDs;
    recomputeAnalysis();
    state.shieldPulse = true;
    state.kpiFresh = true;
    setTimeout(() => { state.shieldPulse = false; state.kpiFresh = false; }, 1100);
  }
  render();
}

function runDiffTool() {
  if (state.diffMode === 'json') {
    const a = validateJson(state.diffLeftText);
    const b = validateJson(state.diffRightText);
    if (!a.valid || !b.valid) {
      alert('Both sides must be valid JSON.');
      return;
    }
    state.diffResult = diffJson(a.data, b.data);
  } else {
    const leftDs = parseCsv(state.diffLeftText);
    const rightDs = parseCsv(state.diffRightText);
    const keys = state.diffKey.split(',').map(s => s.trim()).filter(Boolean);
    state.diffResult = diffTables(leftDs, rightDs, { keys });
  }
  render();
}

function executeSeoTool() {
  const id = state.activeTool;
  try {
    if (id === 'json-formatter') {
      state.toolOutput = formatJson(state.toolInputA, { indent: 2, sortKeys: true });
    } else if (id === 'json-validator') {
      state.toolOutput = JSON.stringify(validateJson(state.toolInputA), null, 2);
    } else if (id === 'json-diff') {
      const a = JSON.parse(state.toolInputA);
      const b = JSON.parse(state.toolInputB || state.toolInputA);
      state.toolOutput = formatDiffReport(diffJson(a, b), 'markdown');
    } else if (id === 'csv-to-json') {
      const ds = parseCsv(state.toolInputA);
      state.toolOutput = formatJson(ds.rows, { indent: 2 });
    } else if (id === 'json-to-csv') {
      const ds = jsonToTabular(JSON.parse(state.toolInputA));
      state.toolOutput = serializeCsv(ds, { formulaGuard: true });
    } else if (id === 'csv-deduplicator') {
      const ds = parseCsv(state.toolInputA);
      const keys = state.toolParam.split(',').map(s => s.trim()).filter(Boolean);
      const def = getNodeDefinition('transform.deduplicate');
      const res = def.execute([ds], { keys, keep: 'last' });
      state.toolOutput = serializeCsv(res.output[0], { formulaGuard: true });
    } else if (id === 'compare-two-csv-files') {
      const a = parseCsv(state.toolInputA);
      const b = parseCsv(state.toolInputB || state.toolInputA);
      const keys = state.toolParam.split(',').map(s => s.trim()).filter(Boolean);
      state.toolOutput = formatDiffReport(diffTables(a, b, { keys }), 'markdown');
    } else if (id === 'json-schema-generator') {
      const data = JSON.parse(state.toolInputA);
      state.toolOutput = JSON.stringify(generateJsonSchema(data, { title: 'Generated Schema' }), null, 2);
    } else if (id === 'json-path-tester') {
      const data = JSON.parse(state.toolInputA);
      const res = queryJsonPath(data, state.toolParam || '$[*]');
      state.toolOutput = JSON.stringify(res, null, 2);
    } else if (id === 'csv-cleaner') {
      const ds = parseCsv(state.toolInputA);
      const prof = profileDataset(ds);
      const fixes = suggestFixes(ds, prof);
      state.toolOutput = JSON.stringify({ summary: prof.summary, issues: prof.issues, suggestedFixes: fixes }, null, 2);
    }
  } catch (err) {
    state.toolOutput = `Error: ${err.message}`;
  }
  render();
}


function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { if (state.toast === msg) { state.toast = ''; render(); } }, 3500);
}

function encodeWorkflowRecipe(wfDoc) {
  // Privacy invariant: strip any inline raw `data` from source params before encoding into URL!
  const clean = structuredClone(wfDoc);
  for (const n of clean?.workflow?.nodes || []) {
    if (n.params && 'data' in n.params) delete n.params.data;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(clean));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeWorkflowRecipe(b64url) {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function renderCommandPalette() {
  const q = state.cmdQuery.toLowerCase().trim();
  const commands = [
    { label: 'Run Workflow (▶)', badge: 'Action', action: 'run-workflow' },
    { label: 'Share Zero-Data Workflow Recipe URL', badge: 'Share', action: 'share-recipe' },
    { label: 'Export Portable Workflow Package', badge: 'Export', action: 'export-package' },
    { label: 'Switch to Table Mode', badge: 'Mode', action: 'set-mode', extra: 'data-mode="table"' },
    { label: 'Switch to Canvas DAG Mode', badge: 'Mode', action: 'set-mode', extra: 'data-mode="canvas"' },
    { label: 'Switch to Code Mode (SQL / JSON / CLI)', badge: 'Mode', action: 'set-mode', extra: 'data-mode="code"' },
    { label: 'Switch to Primary-Key / JSON Diff', badge: 'Mode', action: 'set-mode', extra: 'data-mode="diff"' },
    { label: 'Switch to Schema Guardian & Contracts', badge: 'Mode', action: 'set-mode', extra: 'data-mode="schema"' },
    { label: 'Toggle Dark / Light Theme', badge: 'UI', action: 'toggle-theme' },
    ...listNodes().map(n => ({ label: `Add Node: ${n.label} (${n.type})`, badge: n.category, action: 'add-node', extra: `data-type="${esc(n.type)}"` }))
  ].filter(c => !q || c.label.toLowerCase().includes(q) || c.badge.toLowerCase().includes(q));

  return `
  <div class="cmd-backdrop" data-action="close-cmd">
    <div class="cmd-modal" onclick="event.stopPropagation()">
      <input class="cmd-input" id="cmd-palette-input" placeholder="Type a command, mode, or node name (Esc to close)..." value="${esc(state.cmdQuery)}" data-action="cmd-query">
      <div class="cmd-list">
        ${commands.slice(0, 14).map(c => `
          <div class="cmd-item" data-action="${c.action}" ${c.extra || ''} data-cmd-close="1">
            <span>${esc(c.label)}</span>
            <span class="badge">${esc(c.badge)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  </div>`;
}

function renderTopbar() {
  const modes = [
    ['onboarding', 'Home'],
    ['table', 'Table'],
    ['canvas', 'Canvas'],
    ['code', 'Code'],
    ['diff', 'Diff'],
    ['schema', 'Schema & Tests'],
    ['tools', '10 Tools']
  ];
  return `
  <header class="topbar">
    <div style="display:flex;align-items:center;gap:10px;">
      <div class="brand">
        <span class="brand-mark">DW</span>
        <span>DATA WORKBENCH 2.4</span>
      </div>
      <span class="privacy-pill ${state.shieldPulse ? 'pulse' : ''}" title="All parsing, profiling, diffing, and workflow execution happen 100% locally in your browser.">
        <span class="dot dot-ok"></span> Local-Only · 0 Uploads
      </span>
    </div>
    <nav class="mode-tabs" aria-label="Workspace modes">
      ${modes.map(([id, label]) => `<button class="mode-tab ${state.mode === id ? 'active' : ''}" data-action="set-mode" data-mode="${id}">${label}</button>`).join('')}
    </nav>
    <div class="topbar-actions">
      <button class="btn btn-sm" data-action="undo" title="Undo workflow change">↶ Undo</button>
      <button class="btn btn-sm" data-action="redo" title="Redo workflow change">↷ Redo</button>
      ${state.isRunning ? `<button class="btn btn-danger btn-sm" data-action="cancel-workflow">■ Cancel</button>` : `<button class="btn btn-primary btn-sm" data-action="run-workflow">▶ Run</button>`}
      <button class="btn btn-sm" data-action="open-cmd" title="Command Palette (⌘K / Ctrl+K)">⌘K</button>
      <button class="btn btn-sm" data-action="share-recipe" title="Copy zero-data workflow recipe URL">Share Recipe</button>
      <button class="btn btn-sm" data-action="export-package">Export Package</button>
      <button class="btn btn-sm" data-action="toggle-theme" title="Toggle Dark/Light theme">${state.theme === 'dark' ? '☀' : '☾'}</button>
    </div>
  </header>`;
}

function renderSidebar() {
  const wf = state.recorder.getWorkflow().workflow;
  const allNodes = listNodes();
  const categories = ['Sources', 'Clean', 'Transform', 'Validate', 'Compare', 'Output'];

  return `
  <aside class="sidebar">
    <div class="panel-header">
      <span>Workspace</span>
      <button class="btn btn-sm" data-action="trigger-upload">+ Import</button>
    </div>
    <div class="panel-scroll">
      <div class="nav-section-title">Active File</div>
      <div class="nav-item active">
        <span style="overflow:hidden;text-overflow:ellipsis;">${esc(state.fileName)}</span>
        <span class="badge">${state.dataset.rows.length}r</span>
      </div>

      <div class="nav-section-title">Built-in Examples</div>
      <div class="nav-item" data-action="load-example" data-example="customers"><span>Messy Customer CSV</span><span class="badge badge-warn">CSV</span></div>
      <div class="nav-item" data-action="load-example" data-example="api"><span>API Response JSON</span><span class="badge badge-accent">JSON</span></div>
      <div class="nav-item" data-action="load-example" data-example="catalog"><span>Catalog v1 vs v2 Diff</span><span class="badge badge-ok">DIFF</span></div>

      <div class="nav-section-title">Workflow Steps (${wf.nodes.length})</div>
      ${wf.nodes.map(n => {
        const nr = state.lastRun?.nodeResults?.[n.id];
        const dotCls = !nr ? 'dot-accent' : nr.status === 'failed' ? 'dot-err' : nr.status === 'warning' ? 'dot-warn' : 'dot-ok';
        return `<div class="nav-item ${state.selectedNodeId === n.id ? 'active' : ''}" data-action="select-node" data-id="${esc(n.id)}">
          <span><span class="dot ${dotCls}" style="margin-right:6px;"></span>${esc(n.id)}</span>
          <span class="badge">${esc(n.type.split('.')[1])}</span>
        </div>`;
      }).join('')}

      <div class="nav-section-title">Node Library (${allNodes.length} · Click or Drag to Canvas)</div>
      <div style="padding:0 2px 6px;">
        <input class="input" id="sidebar-node-search" style="padding:4px 7px;font-size:11px;" placeholder="Search nodes (e.g. cluster, pii, sql)..." value="${esc(state.nodeSearch)}" data-action="node-search">
      </div>
      ${categories.map(cat => {
        const q = state.nodeSearch.trim().toLowerCase();
        const items = allNodes.filter(n => n.category === cat && (!q || n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q) || n.description.toLowerCase().includes(q)));
        if (items.length === 0) return '';
        return `
        <div style="font-size:10px;color:var(--text-2);margin:6px 4px 2px;">${cat} (${items.length})</div>
        ${items.map(n =>
          `<div class="nav-item" draggable="true" data-drag-node-type="${esc(n.type)}" data-action="add-node" data-type="${esc(n.type)}" title="${esc(n.description)} (Click to append or drag onto Canvas)">
            <span>+ ${esc(n.label)}</span>
          </div>`
        ).join('')}`;
      }).join('')}

      <div class="nav-section-title">Run History (${state.runHistory.length})</div>
      ${state.runHistory.slice(0, 6).map(r => `
        <div class="nav-item">
          <span>${esc(r.ts)} · ${r.rows}r</span>
          <span class="badge ${r.status === 'failed' ? 'badge-err' : r.status === 'warning' ? 'badge-warn' : 'badge-ok'}">${r.durationMs}ms</span>
        </div>
      `).join('')}
    </div>
  </aside>`;
}

function renderOnboarding() {
  return `
  <div class="stage-content">
    <div style="max-width:920px;margin:8px auto;">
      <h1 style="font-size:20px;font-weight:700;margin-bottom:6px;">From messy files to repeatable data workflows.</h1>
      <p style="color:var(--text-1);margin-bottom:14px;">Local-first visual data studio. Import CSV, JSON, NDJSON, YAML, or XML — inspect Data Quality Radar, preview fixes with confidence scores, record workflows automatically, and run them identically in browser, CLI, CI, or MCP.</p>

      <div class="nav-section-title">Start a Task</div>
      <div class="onboarding-grid">
        <div class="card card-interactive" data-action="load-example" data-example="customers">
          <h3>1. Clean a CSV</h3>
          <p>Detect dialect, bad rows, duplicates, mixed dates, whitespace, and PII — then fix with previews.</p>
        </div>
        <div class="card card-interactive" data-action="load-example" data-example="catalog">
          <h3>2. Compare Two Files</h3>
          <p>Primary-key or composite-key diff classifying Added, Removed, and field-level Changed rows.</p>
        </div>
        <div class="card card-interactive" data-action="load-example" data-example="api">
          <h3>3. Convert & Flatten JSON</h3>
          <p>Flatten nested API payloads, validate JSON Schema 2020-12, and query with RFC 9535 JSONPath.</p>
        </div>
        <div class="card card-interactive" data-action="set-mode" data-mode="canvas">
          <h3>4. Build a Visual Workflow</h3>
          <p>Connect deterministic nodes on the DAG canvas and export a Git-ready Workflow Package.</p>
        </div>
      </div>

      <div class="nav-section-title">Import Local File or Workflow JSON</div>
      <div style="display:flex;gap:10px;margin-bottom:18px;">
        <button class="btn btn-primary" data-action="trigger-upload">Open Local Data File (CSV / JSON / NDJSON / YAML / XML)</button>
        <button class="btn" data-action="trigger-wf-import">Load workflow.json</button>
      </div>

      <div class="card">
        <h3>Why Local-First Data Trust?</h3>
        <p style="margin-top:4px;">Every transformation runs inside your browser with zero file uploads. Table Mode, Canvas Mode, and Code Mode edit the exact same <code>workflow.json</code> v1.0 definition — ready for <code>dw run</code> in your terminal or GitHub Actions.</p>
      </div>
    </div>
  </div>`;
}

function renderTableMode() {
  const ds = state.dataset;
  const prof = state.profile;
  const displayRows = ds.rows
    .map((row, idx) => ({ row, idx }))
    .filter(item => {
      if (state.filterIssueRows && !state.filterIssueRows.has(item.idx)) return false;
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        return ds.columns.some(c => String(item.row[c] ?? '').toLowerCase().includes(q));
      }
      return true;
    });

  const rowHeight = 29;
  const visibleCount = 45;
  const startIdx = Math.max(0, Math.floor(state.gridScrollTop / rowHeight) - 5);
  const endIdx = Math.min(displayRows.length, startIdx + visibleCount);
  const visibleRows = displayRows.slice(startIdx, endIdx);
  const topSpacerPx = startIdx * rowHeight;
  const bottomSpacerPx = Math.max(0, (displayRows.length - endIdx) * rowHeight);

  return `
  <div class="stage-toolbar">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <strong>${esc(state.fileName)}</strong>
      <span class="badge">${ds.rows.length} rows × ${ds.columns.length} cols</span>
      <span class="badge ${state.sampleMode ? 'badge-warn' : 'badge-ok'}">${state.sampleMode ? 'Sample preview (top 200 rendered)' : 'Full execution'}</span>
      ${state.dialect ? `<span class="badge">Delim: ${esc(state.dialect.delimiterLabel)} (${state.dialect.delimiterConfidence})</span>` : ''}
      ${state.filterIssueRows ? `<button class="btn btn-sm btn-danger" data-action="clear-issue-filter">✕ Issue Filter (${state.filterIssueRows.size} rows)</button>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:6px;">
      <input class="input" style="width:160px;padding:4px 7px;" placeholder="Filter grid..." value="${esc(state.searchQuery)}" data-action="grid-search">
      <button class="btn btn-sm" data-action="quick-step" data-step="trim">Trim All</button>
      <button class="btn btn-sm" data-action="quick-step" data-step="dedupe">Deduplicate</button>
      <button class="btn btn-sm" data-action="export-data" data-fmt="csv">Export CSV</button>
      <button class="btn btn-sm" data-action="export-data" data-fmt="json">Export JSON</button>
      <button class="btn btn-sm" data-action="export-data" data-fmt="xlsx">Export XLSX</button>
    </div>
  </div>
  <div class="stage-content">
    <div class="kpi-row">
      <div class="kpi-box ${state.kpiFresh ? 'fresh' : ''}"><div class="kpi-val">${(prof.summary.completeness * 100).toFixed(1)}%</div><div class="kpi-lbl">Completeness</div></div>
      <div class="kpi-box"><div class="kpi-val">${(prof.summary.validity * 100).toFixed(1)}%</div><div class="kpi-lbl">Validity</div></div>
      <div class="kpi-box"><div class="kpi-val">${(prof.summary.consistency * 100).toFixed(1)}%</div><div class="kpi-lbl">Consistency</div></div>
      <div class="kpi-box"><div class="kpi-val">${prof.summary.duplicateRowCount}</div><div class="kpi-lbl">Duplicates</div></div>
      <div class="kpi-box"><div class="kpi-val">${prof.summary.piiColumnCount}</div><div class="kpi-lbl">PII Columns</div></div>
      <div class="kpi-box"><div class="kpi-val">${prof.summary.issueCount}</div><div class="kpi-lbl">Issues</div></div>
    </div>

    ${prof.issues.length > 0 ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${prof.issues.slice(0, 8).map((iss, idx) => `
          <button class="btn btn-sm ${iss.severity === 'error' ? 'btn-danger' : ''}" data-action="filter-issue" data-issue-idx="${idx}" title="Click to filter grid to affected rows">
            <span class="dot ${iss.severity === 'error' ? 'dot-err' : iss.severity === 'warning' ? 'dot-warn' : 'dot-accent'}"></span>
            ${iss.column ? `${esc(iss.column)}: ` : ''}${esc(iss.message)}
          </button>
        `).join('')}
      </div>
    ` : ''}

    <div class="radar-strip">
      ${prof.columns.map(col => {
        const barCls = col.validity < 0.9 || col.completeness < 0.8 ? 'err' : col.consistency < 0.95 ? 'warn' : '';
        return `
        <div class="radar-col">
          <div class="radar-col-head">
            <span style="overflow:hidden;text-overflow:ellipsis;">${esc(col.name)}</span>
            <span class="badge">${esc(col.inferredType)}</span>
          </div>
          <div class="mini-bar-track"><div class="mini-bar-fill ${barCls}" style="width:${Math.round(col.completeness * 100)}%"></div></div>
          <div style="font-size:11px;color:var(--text-2);display:flex;justify-content:space-between;">
            <span>Null ${(col.nullRate * 100).toFixed(1)}%</span>
            <span>Uniq ${(col.uniqueness * 100).toFixed(0)}%</span>
          </div>
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
            ${col.isLikelyId ? '<span class="badge badge-accent">ID</span>' : ''}
            ${col.pii ? `<span class="badge badge-warn">PII:${esc(col.pii.piiType)}</span>` : ''}
            ${col.invalidCount > 0 ? `<span class="badge badge-err">${col.invalidCount} bad</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="grid-wrap" id="virtual-grid-wrap" onscroll="window.__dwGridScroll && window.__dwGridScroll(this.scrollTop)">
      <table class="data-grid">
        <thead>
          <tr>
            <th style="width:42px;color:var(--text-2);">#</th>
            ${ds.columns.map(c => `<th class="col-clickable" data-action="open-col-menu" data-col="${esc(c)}" title="Click for quick actions on ${esc(c)}">${esc(c)} <span style="opacity:0.45;font-size:10px;">▾</span></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${topSpacerPx > 0 ? `<tr style="height:${topSpacerPx}px"><td colspan="${ds.columns.length + 1}"></td></tr>` : ''}
          ${visibleRows.map(({ row, idx }) => `
            <tr class="${state.filterIssueRows?.has(idx) ? 'row-issue' : ''}">
              <td style="color:var(--text-2);">${idx + 1}</td>
              ${ds.columns.map(c => {
                const v = row[c];
                return v === null || v === undefined || v === ''
                  ? `<td class="cell-null">null</td>`
                  : `<td title="${esc(v)}">${esc(v)}</td>`;
              }).join('')}
            </tr>
          `).join('')}
          ${bottomSpacerPx > 0 ? `<tr style="height:${bottomSpacerPx}px"><td colspan="${ds.columns.length + 1}"></td></tr>` : ''}
        </tbody>
      </table>
    </div>
    ${displayRows.length > visibleCount ? `<div style="margin-top:6px;font-size:11px;color:var(--text-2);">Virtualized Grid: rendering rows ${startIdx + 1}–${endIdx} of ${displayRows.length} (constant ~45 DOM rows).</div>` : ''}
  </div>`;
}

function renderCanvasMode() {
  const wf = state.recorder.getWorkflow().workflow;
  for (const n of wf.nodes) {
    if (!state.nodePositions[n.id]) layoutNodesAuto();
  }

  const edgesSvg = wf.edges.map(e => {
    const a = state.nodePositions[e.from];
    const b = state.nodePositions[e.to];
    if (!a || !b) return '';
    const x1 = a.x + 210, y1 = a.y + 32;
    const x2 = b.x, y2 = b.y + 32;
    const mx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    const flowCls = state.isRunning ? 'edge-flow' : (state.lastRun ? 'edge-flow settled' : '');
    return `<path d="${d}" class="edge-base"/>${flowCls ? `<path d="${d}" class="${flowCls}"/>` : ''}`;
  }).join('');

  return `
  <div class="stage-toolbar">
    <div style="display:flex;align-items:center;gap:8px;">
      <strong>Canvas: ${esc(wf.name)}</strong>
      <span class="badge">${wf.nodes.length} nodes · ${wf.edges.length} edges</span>
    </div>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-sm" data-action="canvas-zoom" data-delta="-0.1">− Zoom</button>
      <button class="btn btn-sm" data-action="canvas-zoom" data-delta="0.1">+ Zoom</button>
      <button class="btn btn-sm" data-action="canvas-layout">Auto Layout</button>
      <button class="btn btn-sm btn-primary" data-action="run-workflow">▶ Run DAG</button>
    </div>
  </div>
  <div class="stage-content" style="padding:8px;">
    <div class="canvas-viewport">
      <div class="canvas-stage" style="transform:scale(${state.canvasZoom});">
        <svg class="canvas-edges">${edgesSvg}</svg>
        ${wf.nodes.map(n => {
          const pos = state.nodePositions[n.id] || { x: 40, y: 40 };
          const def = getNodeDefinition(n.type);
          const nr = state.lastRun?.nodeResults?.[n.id];
          const dotCls = !nr ? 'dot-accent' : nr.status === 'failed' ? 'dot-err' : nr.status === 'warning' ? 'dot-warn' : 'dot-ok';
          return `
          <div class="wf-node ${state.selectedNodeId === n.id ? 'selected' : ''} ${n.disabled ? 'disabled' : ''}"
               style="left:${pos.x}px;top:${pos.y}px;"
               data-node-drag="${esc(n.id)}"
               data-action="select-node" data-id="${esc(n.id)}">
            <div class="wf-node-head">
              <span class="wf-node-title"><span class="dot ${dotCls}" style="margin-right:5px;"></span>${esc(def?.label || n.type)}</span>
              <span class="badge">v${esc(n.version || '1.0.0')}</span>
            </div>
            <div class="wf-node-meta">
              <span>${esc(n.id)}</span>
              <span>${nr ? `${nr.rowCount}r · ${nr.durationMs}ms` : esc(n.type)}</span>
            </div>
            <div class="node-ports">
              <div>${(def?.inputPorts || []).map(ip => `<button class="port-btn" data-action="port-in" data-node="${esc(n.id)}" data-port="${esc(ip.name)}" title="Connect to ${esc(n.id)}.${esc(ip.name)}">○ ${esc(ip.name)}</button>`).join(' ')}</div>
              <div>${(def?.outputPorts || [{ name: 'out' }]).map(op => `<button class="port-btn ${op.name === 'errors' ? 'err-port' : ''} ${state.wiringFrom?.nodeId === n.id && state.wiringFrom?.port === op.name ? 'wiring' : ''}" data-action="port-out" data-node="${esc(n.id)}" data-port="${esc(op.name)}" title="Start wire from ${esc(n.id)}.${esc(op.name)}">${esc(op.name)} ●</button>`).join(' ')}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function renderCodeMode() {
  const wfDoc = state.recorder.getWorkflow();
  const code = generateCodeViews(wfDoc, `./${state.fileName}`, './output.json');
  const content = state.codeTab === 'sql' ? code.sqlPreview : state.codeTab === 'cli' ? code.cliCommand : code.workflowJson;
  return `
  <div class="stage-toolbar">
    <div style="display:flex;gap:6px;">
      <button class="btn btn-sm ${state.codeTab === 'sql' ? 'btn-primary' : ''}" data-action="set-code-tab" data-tab="sql">SQL Preview (Read-only)</button>
      <button class="btn btn-sm ${state.codeTab === 'json' ? 'btn-primary' : ''}" data-action="set-code-tab" data-tab="json">Workflow JSON v1.0</button>
      <button class="btn btn-sm ${state.codeTab === 'cli' ? 'btn-primary' : ''}" data-action="set-code-tab" data-tab="cli">CLI Command</button>
    </div>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-sm" data-action="copy-code">Copy</button>
      <button class="btn btn-sm" data-action="download-workflow">Download workflow.json</button>
    </div>
  </div>
  <div class="stage-content">
    <p style="color:var(--text-2);font-size:12px;margin-bottom:8px;">Single source of truth: Table Mode, Canvas Mode, and Code Mode operate on the same Workflow Definition.</p>
    <pre class="code-block" id="code-preview-box">${esc(content)}</pre>
  </div>`;
}

function renderDiffMode() {
  const res = state.diffResult;
  return `
  <div class="stage-toolbar">
    <div style="display:flex;gap:6px;align-items:center;">
      <strong>File Diff Studio</strong>
      <button class="btn btn-sm ${state.diffMode === 'csv' ? 'btn-primary' : ''}" data-action="set-diff-mode" data-dm="csv">CSV Primary-Key Diff</button>
      <button class="btn btn-sm ${state.diffMode === 'json' ? 'btn-primary' : ''}" data-action="set-diff-mode" data-dm="json">JSON Path Diff</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      ${state.diffMode === 'csv' ? `<input class="input" style="width:150px;padding:4px 7px;" placeholder="Primary key (e.g. sku)" value="${esc(state.diffKey)}" data-action="diff-key-change">` : ''}
      <button class="btn btn-sm btn-primary" data-action="run-diff">Compare Now</button>
      ${res ? `<button class="btn btn-sm" data-action="export-diff-html">Export HTML Report</button>` : ''}
    </div>
  </div>
  <div class="stage-content">
    <div class="split-2" style="margin-bottom:12px;">
      <div class="field">
        <label>Left / Baseline (${state.diffMode.toUpperCase()})</label>
        <textarea rows="8" data-action="diff-left-change">${esc(state.diffLeftText)}</textarea>
      </div>
      <div class="field">
        <label>Right / New Version (${state.diffMode.toUpperCase()})</label>
        <textarea rows="8" data-action="diff-right-change">${esc(state.diffRightText)}</textarea>
      </div>
    </div>
    ${res ? `
      <div class="kpi-row">
        ${Object.entries(res.summary).map(([k, v]) => `<div class="kpi-box"><div class="kpi-val">${v}</div><div class="kpi-lbl">${esc(k)}</div></div>`).join('')}
      </div>
      ${res.warning ? `<div class="card" style="border-color:var(--warn);margin-bottom:10px;color:var(--warn);">${esc(res.warning)}</div>` : ''}
      <pre class="code-block">${esc(formatDiffReport(res, 'markdown'))}</pre>
    ` : '<p style="color:var(--text-2);">Click "Compare Now" to inspect added, removed, and cell-level changes.</p>'}
  </div>`;
}

function renderSchemaMode() {
  const schema = generateJsonSchema(state.dataset.rows.slice(0, 100), { title: `${state.fileName} Schema` });
  return `
  <div class="stage-toolbar">
    <strong>Schema Guardian · Data Contracts · Regression Tests</strong>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-sm" data-action="save-snapshot">Save Schema Snapshot (${state.schemaSnapshots.length})</button>
      <button class="btn btn-sm" data-action="compare-snapshots">Check Schema Drift</button>
      <button class="btn btn-sm btn-primary" data-action="run-contract">Run Data Contract</button>
      <button class="btn btn-sm btn-ok" data-action="run-regression">Run Regression Tests</button>
    </div>
  </div>
  <div class="stage-content">
    <div class="split-2">
      <div>
        <div class="nav-section-title">Auto-Generated JSON Schema 2020-12</div>
        <pre class="code-block" style="max-height:240px;">${esc(JSON.stringify(schema, null, 2))}</pre>
        ${state.schemaDrift ? `
          <div class="nav-section-title">Schema Drift Result (${state.schemaDrift.compatible ? 'COMPATIBLE' : 'BREAKING CHANGES'})</div>
          <pre class="code-block" style="max-height:180px;">${esc(JSON.stringify(state.schemaDrift, null, 2))}</pre>
        ` : ''}
      </div>
      <div>
        <div class="field">
          <label>Data Contract JSON (Input Requirements)</label>
          <textarea rows="6" data-action="contract-edit">${esc(state.contractText)}</textarea>
        </div>
        ${state.contractResult ? `<pre class="code-block" style="max-height:140px;margin-bottom:10px;">${esc(JSON.stringify(state.contractResult, null, 2))}</pre>` : ''}

        <div class="field">
          <label>Workflow Regression Expectations JSON</label>
          <textarea rows="6" data-action="regression-edit">${esc(state.regressionText)}</textarea>
        </div>
        ${state.regressionResult ? `<pre class="code-block" style="max-height:140px;">${esc(JSON.stringify(state.regressionResult, null, 2))}</pre>` : ''}
      </div>
    </div>
  </div>`;
}

function renderToolsMode() {
  const current = SEO_TOOLS.find(t => t.id === state.activeTool) || SEO_TOOLS[0];
  const needsTwo = current.id === 'json-diff' || current.id === 'compare-two-csv-files';
  const needsParam = current.id === 'json-path-tester' || current.id === 'csv-deduplicator' || current.id === 'compare-two-csv-files';
  return `
  <div class="stage-toolbar">
    <strong>Standalone Local Tool: ${esc(current.name)}</strong>
    <span style="color:var(--text-2);font-size:12px;">${esc(current.desc)}</span>
  </div>
  <div class="stage-content">
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
      ${SEO_TOOLS.map(t => `<button class="btn btn-sm ${state.activeTool === t.id ? 'btn-primary' : ''}" data-action="select-tool" data-tool="${t.id}">${esc(t.name)}</button>`).join('')}
    </div>
    ${needsParam ? `
      <div class="field">
        <label>${current.id === 'json-path-tester' ? 'RFC 9535 JSONPath Expression' : 'Key Column(s) (comma-separated)'}</label>
        <input class="input" value="${esc(state.toolParam)}" data-action="tool-param-change">
      </div>
    ` : ''}
    <div class="${needsTwo ? 'split-2' : ''}" style="margin-bottom:10px;">
      <div class="field">
        <label>Input ${needsTwo ? 'A (Baseline)' : ''}</label>
        <textarea rows="8" data-action="tool-input-a">${esc(state.toolInputA)}</textarea>
      </div>
      ${needsTwo ? `
        <div class="field">
          <label>Input B (New Version)</label>
          <textarea rows="8" data-action="tool-input-b">${esc(state.toolInputB)}</textarea>
        </div>
      ` : ''}
    </div>
    <div style="margin-bottom:10px;display:flex;gap:8px;">
      <button class="btn btn-primary" data-action="run-seo-tool">Run ${esc(current.name)} Locally</button>
    </div>
    ${state.toolOutput ? `<pre class="code-block">${esc(state.toolOutput)}</pre>` : ''}
  </div>`;
}


function renderColumnSelect(id, cols, selected) {
  return `<select id="${id}" data-form-field="${id}">
    <option value="">-- Choose column --</option>
    ${cols.map(c => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('')}
  </select>`;
}

function renderColumnCheckboxes(groupName, cols, selectedArr) {
  const sel = new Set(selectedArr || []);
  return `<div class="col-check-grid" data-form-multicheck="${groupName}">
    ${cols.map(c => `<label class="col-check-chip"><input type="checkbox" value="${esc(c)}" ${sel.has(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}
  </div>`;
}

function renderVisualNodeForm(node) {
  const p = node.params || {};
  const cols = state.dataset.columns || [];
  const t = node.type;

  if (t === 'source.csv') {
    return `
      <div class="field"><label>Delimiter</label>
        <select data-form-field="delimiter">
          ${[['auto','Auto Detect'],[',','Comma (,)'],[';','Semicolon (;)'],['	','Tab (\t)'],['|','Pipe (|)']].map(([v,l]) => `<option value="${v}" ${(p.delimiter||'auto')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <label class="toggle-row"><input type="checkbox" data-form-bool="header" ${p.header !== false ? 'checked' : ''}> First row is header</label>
      <label class="toggle-row"><input type="checkbox" data-form-bool="formulaGuard" ${p.formulaGuard !== false ? 'checked' : ''}> CSV Formula Injection Guard</label>
    `;
  }
  if (t === 'transform.deduplicate') {
    return `
      <div class="field"><label>Key Column(s)</label>${renderColumnCheckboxes('keys', cols, p.keys)}</div>
      <div class="field"><label>Keep Which Row</label>
        <select data-form-field="keep">
          <option value="first" ${(p.keep||'first')==='first'?'selected':''}>Keep First Occurrence</option>
          <option value="last" ${p.keep==='last'?'selected':''}>Keep Last Occurrence</option>
        </select>
      </div>
      <label class="toggle-row"><input type="checkbox" data-form-bool="caseSensitive" ${p.caseSensitive !== false ? 'checked' : ''}> Case sensitive</label>
    `;
  }
  if (t === 'transform.filter') {
    return `
      <div class="field"><label>Column</label>${renderColumnSelect('column', cols, p.column)}</div>
      <div class="field"><label>Condition</label>
        <select data-form-field="operator">
          ${[['notNull','Is Not Empty'],['isNull','Is Empty / Null'],['eq','Equals (=)'],['neq','Not Equals (!=)'],['contains','Contains'],['startsWith','Starts With'],['endsWith','Ends With'],['gt','Greater Than (>)'],['gte','Greater or Equal (>=)'],['lt','Less Than (<)'],['lte','Less or Equal (<=)']].map(([v,l]) => `<option value="${v}" ${(p.operator||'notNull')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Value</label><input class="input" data-form-field="value" value="${esc(p.value ?? '')}" placeholder="Filter value..."></div>
    `;
  }
  if (t === 'transform.sort') {
    return `
      <div class="field"><label>Sort Column</label>${renderColumnSelect('column', cols, p.column)}</div>
      <div class="field"><label>Direction</label>
        <select data-form-field="direction">
          <option value="asc" ${(p.direction||'asc')==='asc'?'selected':''}>Ascending (A → Z / 0 → 9)</option>
          <option value="desc" ${p.direction==='desc'?'selected':''}>Descending (Z → A / 9 → 0)</option>
        </select>
      </div>
    `;
  }
  if (t === 'clean.text') {
    return `
      <div class="field"><label>Target Columns (leave empty for all)</label>${renderColumnCheckboxes('columns', cols, p.columns)}</div>
      <div class="field"><label>Letter Case</label>
        <select data-form-field="case">
          ${[['none','Keep original'],['lower','lowercase'],['upper','UPPERCASE'],['title','Title Case']].map(([v,l]) => `<option value="${v}" ${(p.case||'none')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <label class="toggle-row"><input type="checkbox" data-form-bool="trim" ${p.trim !== false ? 'checked' : ''}> Trim leading/trailing spaces</label>
      <label class="toggle-row"><input type="checkbox" data-form-bool="collapseSpaces" ${p.collapseSpaces ? 'checked' : ''}> Collapse multiple spaces</label>
      <label class="toggle-row"><input type="checkbox" data-form-bool="normalizeNulls" ${p.normalizeNulls ? 'checked' : ''}> Normalize null tokens (N/A, null → null)</label>
    `;
  }
  if (t === 'clean.dateNormalize') {
    return `
      <div class="field"><label>Date Column</label>${renderColumnSelect('column', cols, p.column)}</div>
      <div class="field"><label>Ambiguous Slash Date Order</label>
        <select data-form-field="sourceOrder">
          <option value="MDY" ${(p.sourceOrder||'MDY')==='MDY'?'selected':''}>MM/DD/YYYY (US)</option>
          <option value="DMY" ${p.sourceOrder==='DMY'?'selected':''}>DD/MM/YYYY (EU/Intl)</option>
        </select>
      </div>
      <div class="field"><label>Target Format</label>
        <select data-form-field="targetFormat">
          <option value="ISO-8601" ${(p.targetFormat||'ISO-8601')==='ISO-8601'?'selected':''}>ISO-8601 (YYYY-MM-DD)</option>
          <option value="MM/DD/YYYY" ${p.targetFormat==='MM/DD/YYYY'?'selected':''}>MM/DD/YYYY</option>
          <option value="DD/MM/YYYY" ${p.targetFormat==='DD/MM/YYYY'?'selected':''}>DD/MM/YYYY</option>
        </select>
      </div>
      <div class="field"><label>Invalid Date Policy</label>
        <select data-form-field="invalidPolicy">
          <option value="keep" ${(p.invalidPolicy||'keep')==='keep'?'selected':''}>Keep original value</option>
          <option value="null" ${p.invalidPolicy==='null'?'selected':''}>Set to null</option>
          <option value="drop" ${p.invalidPolicy==='drop'?'selected':''}>Drop row (route to errors port)</option>
        </select>
      </div>
    `;
  }
  if (t === 'clean.piiMask') {
    return `
      <div class="field"><label>PII Columns to Protect</label>${renderColumnCheckboxes('columns', cols, p.columns)}</div>
      <div class="field"><label>Masking Strategy</label>
        <select data-form-field="strategy">
          ${[['mask','Mask (a***@domain.com)'],['hash','Deterministic Hash (h_...)'],['synthetic','Synthetic Placeholder'],['keepLast','Keep Last N Characters'],['remove','Remove (set null)']].map(([v,l]) => `<option value="${v}" ${(p.strategy||'mask')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Keep Last N (for keepLast)</label><input class="input" type="number" min="1" max="12" data-form-num="keepLast" value="${p.keepLast ?? 4}"></div>
    `;
  }
  if (t === 'clean.clusterMerge') {
    return `
      <div class="field"><label>Category Column to Cluster</label>${renderColumnSelect('column', cols, p.column)}</div>
      <div class="field"><label>Clustering Algorithm</label>
        <select data-form-field="method">
          <option value="both" ${(p.method||'both')==='both'?'selected':''}>Fingerprint + Levenshtein (Recommended)</option>
          <option value="fingerprint" ${p.method==='fingerprint'?'selected':''}>Key-Collision Fingerprint Only</option>
          <option value="levenshtein" ${p.method==='levenshtein'?'selected':''}>Levenshtein Edit Distance Only</option>
        </select>
      </div>
      <div class="field"><label>Max Edit Distance (1–4)</label><input class="input" type="number" min="1" max="4" data-form-num="maxDistance" value="${p.maxDistance ?? 2}"></div>
    `;
  }
  if (t === 'clean.fillNulls') {
    return `
      <div class="field"><label>Column</label>${renderColumnSelect('column', cols, p.column)}</div>
      <div class="field"><label>Fill Strategy</label>
        <select data-form-field="strategy">
          <option value="constant" ${(p.strategy||'constant')==='constant'?'selected':''}>Constant Value</option>
          <option value="forward" ${p.strategy==='forward'?'selected':''}>Forward Fill (previous row)</option>
          <option value="mean" ${p.strategy==='mean'?'selected':''}>Column Mean (numeric)</option>
        </select>
      </div>
      <div class="field"><label>Constant Value</label><input class="input" data-form-field="value" value="${esc(p.value ?? '')}"></div>
    `;
  }
  if (t === 'transform.selectColumns') {
    return `
      <div class="field"><label>Keep Only Columns (leave empty for all)</label>${renderColumnCheckboxes('include', cols, p.include)}</div>
      <div class="field"><label>Exclude / Drop Columns</label>${renderColumnCheckboxes('exclude', cols, p.exclude)}</div>
    `;
  }
  if (t === 'transform.sqlQuery') {
    return `<div class="field"><label>Local SQL Query</label><textarea rows="5" data-form-field="sql">${esc(p.sql || 'SELECT * FROM data LIMIT 100')}</textarea></div>`;
  }
  if (t === 'transform.jsonPath') {
    return `<div class="field"><label>RFC 9535 JSONPath Expression</label><input class="input" data-form-field="expression" value="${esc(p.expression || '$[*]')}"></div>`;
  }
  if (t === 'output.csv') {
    return `
      <div class="field"><label>Delimiter</label>
        <select data-form-field="delimiter">
          ${[[',','Comma (,)'],[';','Semicolon (;)'],['	','Tab (\t)'],['|','Pipe (|)']].map(([v,l]) => `<option value="${v}" ${(p.delimiter||',')===v?'selected':''}>${l}</option>`).join('')}
        </select>
      </div>
      <label class="toggle-row"><input type="checkbox" data-form-bool="header" ${p.header !== false ? 'checked' : ''}> Include header row</label>
      <label class="toggle-row"><input type="checkbox" data-form-bool="formulaGuard" ${p.formulaGuard !== false ? 'checked' : ''}> Protect against CSV Formula Injection</label>
    `;
  }
  if (t === 'output.json') {
    return `
      <label class="toggle-row"><input type="checkbox" data-form-bool="pretty" ${p.pretty !== false ? 'checked' : ''}> Pretty-print JSON (2-space indent)</label>
      <label class="toggle-row"><input type="checkbox" data-form-bool="sortKeys" ${p.sortKeys ? 'checked' : ''}> Sort keys deterministically</label>
    `;
  }
  return '';
}

function collectVisualFormParams(baseParams) {
  const formEl = document.getElementById('visual-node-form');
  if (!formEl) return null;
  const next = { ...(baseParams || {}) };
  formEl.querySelectorAll('[data-form-field]').forEach(el => { next[el.dataset.formField] = el.value; });
  formEl.querySelectorAll('[data-form-num]').forEach(el => { next[el.dataset.formNum] = Number(el.value); });
  formEl.querySelectorAll('[data-form-bool]').forEach(el => { next[el.dataset.formBool] = el.checked; });
  formEl.querySelectorAll('[data-form-multicheck]').forEach(box => {
    const key = box.dataset.formMulticheck;
    next[key] = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
  });
  return next;
}

function renderColumnQuickMenu() {
  const m = state.colMenu;
  if (!m) return '';
  const col = esc(m.col);
  return `
  <div class="col-menu" style="left:${m.x}px;top:${m.y}px;" onclick="event.stopPropagation()">
    <div class="col-menu-title">Column: ${col}</div>
    <button class="col-menu-item" data-action="col-quick" data-op="sort-asc" data-col="${col}">↑ Sort Ascending (A → Z)</button>
    <button class="col-menu-item" data-action="col-quick" data-op="sort-desc" data-col="${col}">↓ Sort Descending (Z → A)</button>
    <button class="col-menu-item" data-action="col-quick" data-op="trim-lower" data-col="${col}">Aa Trim & Lowercase</button>
    <button class="col-menu-item" data-action="col-quick" data-op="dedupe" data-col="${col}">⊘ Deduplicate by "${col}"</button>
    <button class="col-menu-item" data-action="col-quick" data-op="date-iso" data-col="${col}">📅 Normalize Dates (ISO-8601)</button>
    <button class="col-menu-item" data-action="col-quick" data-op="cluster" data-col="${col}">✦ Fuzzy Cluster Merge</button>
    <button class="col-menu-item" data-action="col-quick" data-op="mask-pii" data-col="${col}">🛡 Mask PII Locally</button>
    <button class="col-menu-item" data-action="col-quick" data-op="not-null" data-col="${col}">✓ Keep Non-Empty Rows</button>
    <button class="col-menu-item danger" data-action="col-quick" data-op="drop" data-col="${col}">✕ Drop Column "${col}"</button>
  </div>`;
}

function renderInspector() {
  const wf = state.recorder.getWorkflow().workflow;
  const node = wf.nodes.find(n => n.id === state.selectedNodeId) || wf.nodes[0];
  const nr = node ? state.lastRun?.nodeResults?.[node.id] : null;
  const tabs = [
    ['node', 'Node'],
    ['fixes', `Fixes (${state.fixes.length})`],
    ['diff', 'Diff'],
    ['explain', 'Explain'],
    ['copilot', 'AI Copilot']
  ];

  let body = '';
  if (state.inspectorTab === 'node' && node) {
    const def = getNodeDefinition(node.type);
    body = `
      <div class="field">
        <label>Selected Node</label>
        <div style="font-weight:600;">${esc(def?.label || node.type)} <span class="badge">${esc(node.id)}</span></div>
        <p style="font-size:11px;color:var(--text-2);margin-top:3px;">${esc(def?.description || '')}</p>
      </div>
      <div id="visual-node-form">${renderVisualNodeForm(node)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;">
        <button class="btn btn-sm btn-primary" data-action="save-visual-params" data-id="${esc(node.id)}">Apply & Run</button>
      </div>
      <details style="margin-bottom:10px;">
        <summary style="font-size:11px;color:var(--text-2);cursor:pointer;margin-bottom:6px;">Advanced JSON Parameters</summary>
        <textarea rows="6" id="node-params-editor">${esc(JSON.stringify(node.params || {}, null, 2))}</textarea>
        <button class="btn btn-sm" style="margin-top:6px;" data-action="save-node-params" data-id="${esc(node.id)}">Apply Raw JSON</button>
      </details>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
        <button class="btn btn-sm" data-action="toggle-node-disabled" data-id="${esc(node.id)}">${node.disabled ? 'Enable' : 'Disable'}</button>
        ${node.id !== 'input-1' ? `<button class="btn btn-sm btn-danger" data-action="delete-node" data-id="${esc(node.id)}">Delete</button>` : ''}
      </div>
      ${nr ? `
        <div class="card">
          <div style="font-weight:600;margin-bottom:4px;">Last Execution: <span class="badge ${nr.status === 'failed' ? 'badge-err' : 'badge-ok'}">${nr.status}</span></div>
          <div style="font-size:11px;color:var(--text-1);">Rows: ${nr.rowCount} · Time: ${nr.durationMs}ms</div>
          ${nr.warnings.map(w => `<div style="font-size:11px;color:var(--warn);margin-top:3px;">⚠ ${esc(w.message)}</div>`).join('')}
          ${nr.errors.map(e => `<div style="font-size:11px;color:var(--err);margin-top:3px;">✕ ${esc(e.message)}</div>`).join('')}
        </div>
      ` : ''}`;
  } else if (state.inspectorTab === 'fixes') {
    body = state.fixes.length === 0
      ? '<p style="color:var(--text-2);">No automatic fix proposals for the current dataset.</p>'
      : state.fixes.map((fix, idx) => `
        <div class="card" style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <strong style="font-size:12px;">${esc(fix.recommendedAction)}</strong>
            <span class="badge ${fix.confidence === 'high' ? 'badge-ok' : fix.confidence === 'medium' ? 'badge-warn' : 'badge-err'}">${fix.confidence}</span>
          </div>
          <div style="font-size:11px;color:var(--text-1);margin-bottom:4px;">${esc(fix.issue)} · Risk: ${esc(fix.informationLossRisk)}</div>
          ${fix.beforeAfterSamples.slice(0, 2).map(s => `
            <div style="font-family:var(--font-mono);font-size:10px;background:var(--bg-0);padding:4px 6px;border-radius:4px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;">
              <span style="color:var(--err);">- ${esc(s.before)}</span><br>
              <span style="color:var(--ok);">+ ${esc(s.after)}</span>
            </div>
          `).join('')}
          <button class="btn btn-sm btn-primary" style="margin-top:4px;" data-action="apply-fix" data-fix-idx="${idx}">Apply to Workflow</button>
        </div>
      `).join('');
  } else if (state.inspectorTab === 'diff') {
    const d = nr?.diff;
    body = d ? `
      <div class="kpi-row">
        <div class="kpi-box"><div class="kpi-val">+${d.rowsAdded}</div><div class="kpi-lbl">Added</div></div>
        <div class="kpi-box"><div class="kpi-val">-${d.rowsRemoved}</div><div class="kpi-lbl">Removed</div></div>
        <div class="kpi-box"><div class="kpi-val">${d.changedCells}</div><div class="kpi-lbl">Cells Δ</div></div>
      </div>
      <div class="nav-section-title">Sample Cell Changes</div>
      ${d.sampleChanges.length === 0 ? '<p style="color:var(--text-2);">No cell mutations in this step.</p>' : d.sampleChanges.map(ch => `
        <div class="card" style="margin-bottom:6px;font-family:var(--font-mono);font-size:11px;">
          <div>Row #${ch.rowIndex + 1} · <strong>${esc(ch.column)}</strong></div>
          <div style="color:var(--err);">- ${esc(ch.before)}</div>
          <div style="color:var(--ok);">+ ${esc(ch.after)}</div>
        </div>
      `).join('')}
    ` : '<p style="color:var(--text-2);">Run the workflow and select a transform node to view its Before/After Data Diff.</p>';
  } else if (state.inspectorTab === 'explain') {
    const ex = state.explanation;
    body = `
      <div class="card" style="margin-bottom:8px;border-color:var(--accent);">
        <div style="font-size:11px;color:var(--text-1);">${esc(ex.disclaimer)}</div>
      </div>
      <p style="font-size:12px;margin-bottom:8px;">${esc(ex.overview)}</p>
      <div class="nav-section-title">Column Guesses</div>
      ${ex.columnExplanations.map(c => `
        <div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;">
          <strong>${esc(c.column)}</strong> <span class="badge">${c.confidence}</span>
          <div style="color:var(--text-1);">${esc(c.semanticGuess)}</div>
        </div>
      `).join('')}
    `;
  } else if (state.inspectorTab === 'copilot') {
    body = `
      <div class="card" style="margin-bottom:8px;">
        <div style="font-size:11px;color:var(--ok);">Local Deterministic Copilot · 0 bytes sent externally</div>
      </div>
      <div class="field">
        <label>Describe rules in English or Chinese</label>
        <textarea rows="4" data-action="copilot-prompt">${esc(state.copilotPrompt)}</textarea>
      </div>
      <button class="btn btn-primary btn-sm" data-action="copilot-plan" style="margin-bottom:10px;">Generate Reviewable Plan</button>
      ${state.copilotPlan ? `
        <div class="nav-section-title">Proposed Steps (${state.copilotPlan.steps.length})</div>
        ${state.copilotPlan.steps.map(st => `
          <div class="card" style="margin-bottom:6px;font-size:11px;">
            <code>${esc(st.summary)}</code>
            ${st.destructive ? '<span class="badge badge-warn" style="margin-left:4px;">Destructive</span>' : ''}
          </div>
        `).join('')}
        ${state.copilotPlan.ambiguities.map(a => `<div style="font-size:11px;color:var(--warn);margin-bottom:6px;">⚠ ${esc(a)}</div>`).join('')}
        <button class="btn btn-ok btn-sm" data-action="copilot-approve">Approve & Append to Workflow</button>
      ` : ''}
    `;
  }

  return `
  <aside class="inspector">
    <div class="inspector-tabs">
      ${tabs.map(([id, lbl]) => `<button class="insp-tab ${state.inspectorTab === id ? 'active' : ''}" data-action="set-insp-tab" data-tab="${id}">${lbl}</button>`).join('')}
    </div>
    <div class="panel-scroll">${body}</div>
  </aside>`;
}

function renderRunLog() {
  const run = state.lastRun;
  const logs = run?.logs || [{ ts: new Date().toISOString().slice(11, 19), level: 'info', nodeId: 'studio', message: `Ready. Engine v${ENGINE_VERSION} running 100% locally.` }];
  return `
  <footer class="run-log">
    <div class="run-log-bar">
      <span>EXECUTION LOG ${run ? `· ${run.executedOrder?.length || 0} nodes · ${run.finalOutput?.rows?.length ?? 0} rows · ${run.warnings.length} warnings · ${run.errors.length} errors · ${run.durationMs}ms` : '· Idle'}</span>
      <span>Engine v${ENGINE_VERSION} · Columnar-JS · ${state.executionMode === 'worker' ? 'Web Worker' : 'Main Thread'}${state.estimatedBytes ? ` · ${(state.estimatedBytes / 1024).toFixed(1)} KB` : ''}</span>
    </div>
    <div class="run-log-lines">
      ${logs.map(l => `<div class="log-line log-${l.level}"><span>[${esc(String(l.ts).slice(11, 19) || l.ts)}]</span><strong>${esc(l.nodeId || 'sys')}</strong><span>${esc(l.message)}</span></div>`).join('')}
    </div>
  </footer>`;
}

function render() {
  document.documentElement.setAttribute('data-theme', state.theme);
  let mainHtml = '';
  if (state.mode === 'onboarding') mainHtml = renderOnboarding();
  else if (state.mode === 'table') mainHtml = renderTableMode();
  else if (state.mode === 'canvas') mainHtml = renderCanvasMode();
  else if (state.mode === 'code') mainHtml = renderCodeMode();
  else if (state.mode === 'diff') mainHtml = renderDiffMode();
  else if (state.mode === 'schema') mainHtml = renderSchemaMode();
  else if (state.mode === 'tools') mainHtml = renderToolsMode();

  document.getElementById('app').innerHTML = `
    ${renderTopbar()}
    <div class="workspace-body">
      ${renderSidebar()}
      <main class="main-stage">${mainHtml}</main>
      ${renderInspector()}
    </div>
    ${renderRunLog()}
    ${state.cmdOpen ? renderCommandPalette() : ''}
    ${state.colMenu ? renderColumnQuickMenu() : ''}
    ${state.fileDragOver ? '<div class="drop-overlay"><h2>Drop File to Open Locally</h2><p>Supports CSV, TSV, JSON, NDJSON, YAML, XML, and workflow.json · 0 bytes uploaded</p></div>' : ''}
    ${state.toast ? `<div class="toast-banner">${esc(state.toast)}</div>` : ''}
  `;
}

// Event delegation
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) { if (state.colMenu) { state.colMenu = null; render(); } return; }
  const action = el.dataset.action;

  if (action === 'set-mode') {
    state.mode = el.dataset.mode;
    render();
  } else if (action === 'toggle-theme') {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    render();
  } else if (action === 'set-insp-tab') {
    state.inspectorTab = el.dataset.tab;
    render();
  } else if (action === 'set-code-tab') {
    state.codeTab = el.dataset.tab;
    render();
  } else if (action === 'select-node') {
    state.selectedNodeId = el.dataset.id;
    render();
  } else if (action === 'add-node') {
    const def = getNodeDefinition(el.dataset.type);
    const added = state.recorder.addStep(el.dataset.type, structuredClone(def?.defaultParams || {}));
    state.selectedNodeId = added.id;
    layoutNodesAuto();
    render();
  } else if (action === 'undo') {
    if (state.recorder.undo()) { layoutNodesAuto(); render(); }
  } else if (action === 'redo') {
    if (state.recorder.redo()) { layoutNodesAuto(); render(); }
  } else if (action === 'run-workflow') {
    runCurrentWorkflow();
  } else if (action === 'cancel-workflow') {
    cancelCurrentWorkflow();
  } else if (action === 'trigger-upload') {
    document.getElementById('file-upload-input').click();
  } else if (action === 'trigger-wf-import') {
    document.getElementById('workflow-import-input').click();
  } else if (action === 'load-example') {
    const ex = el.dataset.example;
    if (ex === 'customers') {
      loadRawData('messy-customers.csv', MESSY_CUSTOMERS_CSV);
      state.recorder = new WorkflowRecorder(SAMPLE_CLEAN_WORKFLOW);
      layoutNodesAuto();
      render();
    } else if (ex === 'api') {
      loadRawData('api-response.json', API_RESPONSE_JSON);
    } else if (ex === 'catalog') {
      state.diffLeftText = PRODUCT_CATALOG_V1_CSV;
      state.diffRightText = PRODUCT_CATALOG_V2_CSV;
      state.diffKey = 'sku';
      state.diffMode = 'csv';
      state.mode = 'diff';
      runDiffTool();
    }
  } else if (action === 'filter-issue') {
    const iss = state.profile.issues[Number(el.dataset.issueIdx)];
    if (iss && iss.rowIndices?.length) {
      state.filterIssueRows = new Set(iss.rowIndices);
      render();
    }
  } else if (action === 'clear-issue-filter') {
    state.filterIssueRows = null;
    render();
  } else if (action === 'quick-step') {
    if (el.dataset.step === 'trim') {
      state.recorder.addStep('clean.text', { columns: state.dataset.columns, trim: true, normalizeNulls: true });
    } else if (el.dataset.step === 'dedupe') {
      const idCol = state.profile.columns.find(c => c.isLikelyId)?.name || state.dataset.columns[0];
      state.recorder.addStep('transform.deduplicate', { keys: [idCol], keep: 'last' });
    }
    layoutNodesAuto();
    runCurrentWorkflow();
  } else if (action === 'export-data') {
    const fmt = el.dataset.fmt;
    (async () => {
      let fullDs = state.dataset;
      if (state.dataset?.isWindowedPreview) {
        const wfDoc = state.recorder.getWorkflow();
        const firstSource = wfDoc.workflow.nodes.find(n => n.type.startsWith('source.'));
        const inputsByNodeId = firstSource ? { [firstSource.id]: state.rawInput } : {};
        const fullRun = await executeWorkflow(wfDoc, { inputsByNodeId });
        if (fullRun.finalOutput) fullDs = fullRun.finalOutput;
      }
      if (fmt === 'csv') downloadFile('cleaned-output.csv', serializeCsv(fullDs, { formulaGuard: true }), 'text/csv');
      else if (fmt === 'xlsx') downloadFile('cleaned-output.xlsx', serializeXlsx(fullDs, { sheetName: 'Cleaned', formulaGuard: true }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      else downloadFile('cleaned-output.json', formatJson(fullDs.rows, { indent: 2 }), 'application/json');
    })();
  } else if (action === 'save-visual-params') {
    const wf = state.recorder.getWorkflow().workflow;
    const node = wf.nodes.find(x => x.id === el.dataset.id);
    const collected = collectVisualFormParams(node?.params || {});
    if (collected) {
      state.recorder.updateNodeParams(el.dataset.id, collected);
      runCurrentWorkflow();
    }
  } else if (action === 'open-col-menu') {
    const rect = el.getBoundingClientRect();
    state.colMenu = { col: el.dataset.col, x: Math.min(rect.left, window.innerWidth - 230), y: Math.min(rect.bottom + 4, window.innerHeight - 280) };
    render();
  } else if (action === 'col-quick') {
    const col = el.dataset.col;
    const op = el.dataset.op;
    state.colMenu = null;
    if (op === 'sort-asc') state.recorder.addStep('transform.sort', { column: col, direction: 'asc' });
    else if (op === 'sort-desc') state.recorder.addStep('transform.sort', { column: col, direction: 'desc' });
    else if (op === 'trim-lower') state.recorder.addStep('clean.text', { columns: [col], trim: true, case: 'lower' });
    else if (op === 'dedupe') state.recorder.addStep('transform.deduplicate', { keys: [col], keep: 'last' });
    else if (op === 'date-iso') state.recorder.addStep('clean.dateNormalize', { column: col, sourceOrder: 'MDY', targetFormat: 'ISO-8601', invalidPolicy: 'keep' });
    else if (op === 'cluster') state.recorder.addStep('clean.clusterMerge', { column: col, method: 'both', maxDistance: 2 });
    else if (op === 'mask-pii') state.recorder.addStep('clean.piiMask', { columns: [col], strategy: 'mask' });
    else if (op === 'not-null') state.recorder.addStep('transform.filter', { column: col, operator: 'notNull', value: '' });
    else if (op === 'drop') state.recorder.addStep('transform.selectColumns', { exclude: [col] });
    layoutNodesAuto();
    runCurrentWorkflow();
  } else if (action === 'save-node-params') {
    try {
      const parsed = JSON.parse(document.getElementById('node-params-editor').value);
      state.recorder.updateNodeParams(el.dataset.id, parsed);
      runCurrentWorkflow();
    } catch (err) {
      alert(`Invalid JSON params: ${err.message}`);
    }
  } else if (action === 'toggle-node-disabled') {
    const wf = state.recorder.workflow.workflow;
    const n = wf.nodes.find(x => x.id === el.dataset.id);
    if (n) { n.disabled = !n.disabled; render(); }
  } else if (action === 'delete-node') {
    state.recorder.removeNode(el.dataset.id);
    state.selectedNodeId = 'input-1';
    layoutNodesAuto();
    render();
  } else if (action === 'apply-fix') {
    const fix = state.fixes[Number(el.dataset.fixIdx)];
    if (fix) {
      state.recorder.addStep(fix.nodeType, structuredClone(fix.params));
      layoutNodesAuto();
      runCurrentWorkflow();
    }
  } else if (action === 'canvas-zoom') {
    state.canvasZoom = Math.min(1.5, Math.max(0.6, Number((state.canvasZoom + Number(el.dataset.delta)).toFixed(2))));
    render();
  } else if (action === 'port-out') {
    state.wiringFrom = { nodeId: el.dataset.node, port: el.dataset.port };
    showToast(`Wiring from ${el.dataset.node}.${el.dataset.port} → click any target input port`);
    render();
  } else if (action === 'port-in') {
    if (state.wiringFrom && state.wiringFrom.nodeId !== el.dataset.node) {
      const wf = state.recorder.workflow.workflow;
      state.recorder._snapshot();
      wf.edges.push({ from: state.wiringFrom.nodeId, fromPort: state.wiringFrom.port, to: el.dataset.node, toPort: el.dataset.port });
      showToast(`Connected ${state.wiringFrom.nodeId}.${state.wiringFrom.port} → ${el.dataset.node}.${el.dataset.port}`);
      state.wiringFrom = null;
      render();
    }
  } else if (action === 'canvas-layout') {
    layoutNodesAuto();
    render();
  } else if (action === 'copy-code') {
    safeCopyText(document.getElementById('code-preview-box')?.textContent || '');
  } else if (action === 'download-workflow') {
    downloadFile(`${state.recorder.getWorkflow().workflow.id}.workflow.json`, JSON.stringify(state.recorder.getWorkflow(), null, 2), 'application/json');
  } else if (action === 'export-package') {
    const pkg = exportWorkflowPackage(state.recorder.getWorkflow(), { inputDataset: state.dataset, outputDataset: state.dataset, lastRunReport: state.lastRun });
    downloadFile(`${state.recorder.getWorkflow().workflow.id}-package.json`, JSON.stringify(pkg, null, 2), 'application/json');
  } else if (action === 'set-diff-mode') {
    state.diffMode = el.dataset.dm;
    state.diffResult = null;
    if (state.diffMode === 'json') {
      state.diffLeftText = API_RESPONSE_JSON;
      state.diffRightText = API_RESPONSE_JSON.replace('"refunded"', '"paid"').replace('310', '345');
    } else {
      state.diffLeftText = PRODUCT_CATALOG_V1_CSV;
      state.diffRightText = PRODUCT_CATALOG_V2_CSV;
    }
    render();
  } else if (action === 'run-diff') {
    runDiffTool();
  } else if (action === 'export-diff-html' && state.diffResult) {
    downloadFile('diff-report.html', formatDiffReport(state.diffResult, 'html'), 'text/html');
  } else if (action === 'save-snapshot') {
    const snap = createSchemaSnapshot(state.dataset.rows, `v${state.schemaSnapshots.length + 1}`);
    state.schemaSnapshots.push(snap);
    render();
  } else if (action === 'compare-snapshots') {
    if (state.schemaSnapshots.length < 2) {
      alert('Save at least 2 schema snapshots (e.g. before and after modifying columns) to compare drift.');
      return;
    }
    const len = state.schemaSnapshots.length;
    state.schemaDrift = diffSchemaSnapshots(state.schemaSnapshots[len - 2], state.schemaSnapshots[len - 1]);
    render();
  } else if (action === 'run-contract') {
    try {
      state.contractResult = validateDataContract(state.dataset, JSON.parse(state.contractText));
      render();
    } catch (err) { alert(`Invalid Contract JSON: ${err.message}`); }
  } else if (action === 'run-regression') {
    try {
      state.regressionResult = runRegressionTests(parseCsv(state.rawInput), state.dataset, JSON.parse(state.regressionText));
      render();
    } catch (err) { alert(`Invalid Regression JSON: ${err.message}`); }
  } else if (action === 'copilot-plan') {
    state.copilotPlan = compileNaturalLanguagePlan(state.copilotPrompt, state.dataset);
    render();
  } else if (action === 'copilot-approve' && state.copilotPlan) {
    for (const st of state.copilotPlan.steps) {
      state.recorder.addStep(st.nodeType, st.params);
    }
    state.copilotPlan = null;
    layoutNodesAuto();
    runCurrentWorkflow();
  } else if (action === 'select-tool') {
    state.activeTool = el.dataset.tool;
    state.toolOutput = '';
    if (state.activeTool === 'compare-two-csv-files') {
      state.toolInputA = PRODUCT_CATALOG_V1_CSV;
      state.toolInputB = PRODUCT_CATALOG_V2_CSV;
      state.toolParam = 'sku';
    } else if (state.activeTool === 'csv-cleaner' || state.activeTool === 'csv-to-json' || state.activeTool === 'csv-deduplicator') {
      state.toolInputA = MESSY_CUSTOMERS_CSV;
      state.toolInputB = '';
      state.toolParam = 'customer_id';
    } else {
      // json-formatter, json-validator, json-diff, json-to-csv, json-schema-generator, json-path-tester
      state.toolInputA = API_RESPONSE_JSON;
      state.toolInputB = API_RESPONSE_JSON.replace('"refunded"', '"paid"');
      state.toolParam = '$.data[?@.status == "paid"].order_id';
    }
    render();
  } else if (action === 'run-seo-tool') {
    executeSeoTool();
  } else if (action === 'open-cmd') {
    state.cmdOpen = true;
    state.cmdQuery = '';
    render();
    setTimeout(() => document.getElementById('cmd-palette-input')?.focus(), 10);
  } else if (action === 'close-cmd') {
    state.cmdOpen = false;
    render();
  } else if (action === 'share-recipe') {
    const encoded = encodeWorkflowRecipe(state.recorder.getWorkflow());
    const url = `${location.origin}${location.pathname}#recipe=${encoded}`;
    safeCopyText(url);
    showToast('Zero-data workflow recipe URL copied! (0 rows included)');
  }
  if (el.dataset.cmdClose === '1') {
    state.cmdOpen = false;
    render();
  }
});

document.addEventListener('input', (e) => {
  const act = e.target.dataset?.action;
  if (act === 'grid-search') { state.searchQuery = e.target.value; render(); }
  else if (act === 'diff-key-change') state.diffKey = e.target.value;
  else if (act === 'diff-left-change') state.diffLeftText = e.target.value;
  else if (act === 'diff-right-change') state.diffRightText = e.target.value;
  else if (act === 'contract-edit') state.contractText = e.target.value;
  else if (act === 'regression-edit') state.regressionText = e.target.value;
  else if (act === 'copilot-prompt') state.copilotPrompt = e.target.value;
  else if (act === 'tool-input-a') state.toolInputA = e.target.value;
  else if (act === 'tool-input-b') state.toolInputB = e.target.value;
  else if (act === 'tool-param-change') state.toolParam = e.target.value;
  else if (act === 'node-search') { state.nodeSearch = e.target.value; render(); const el = document.getElementById('sidebar-node-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  else if (act === 'cmd-query') { state.cmdQuery = e.target.value; render(); const inp = document.getElementById('cmd-palette-input'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
});

// Drag nodes on Canvas
let dragState = null;
document.addEventListener('mousedown', (e) => {
  const nodeEl = e.target.closest('[data-node-drag]');
  if (!nodeEl || state.mode !== 'canvas') return;
  const id = nodeEl.dataset.nodeDrag;
  const pos = state.nodePositions[id] || { x: 40, y: 40 };
  dragState = { id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
});
document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = (e.clientX - dragState.startX) / state.canvasZoom;
  const dy = (e.clientY - dragState.startY) / state.canvasZoom;
  state.nodePositions[dragState.id] = { x: Math.max(10, dragState.origX + dx), y: Math.max(10, dragState.origY + dy) };
  render();
});
document.addEventListener('mouseup', () => { dragState = null; });

// File uploads
document.getElementById('file-upload-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.xlsx')) {
    file.arrayBuffer().then(buf => parseXlsx(new Uint8Array(buf))).then(ds => {
      state.fileName = file.name;
      state.inputKind = 'xlsx';
      state.rawInput = serializeCsv(ds, { formulaGuard: false });
      state.dataset = ds;
      state.dialect = null;
      recomputeAnalysis();
      state.mode = 'table';
      showToast(`Opened Excel workbook: ${file.name} (${ds.rows.length} rows)`);
      render();
    });
  } else {
    const reader = new FileReader();
    reader.onload = () => loadRawData(file.name, String(reader.result || ''));
    reader.readAsText(file);
  }
  e.target.value = '';
});

document.getElementById('workflow-import-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const wf = JSON.parse(String(reader.result || '{}'));
      state.recorder = new WorkflowRecorder(wf);
      layoutNodesAuto();
      state.mode = 'canvas';
      render();
    } catch (err) { alert(`Invalid workflow JSON: ${err.message}`); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Hash routing for SEO tool URLs (#/csv-cleaner, #/json-diff, etc.)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    state.cmdOpen = !state.cmdOpen;
    state.cmdQuery = '';
    render();
    if (state.cmdOpen) setTimeout(() => document.getElementById('cmd-palette-input')?.focus(), 10);
  } else if (e.key === 'Escape' && state.cmdOpen) {
    state.cmdOpen = false;
    render();
  }
});

function syncHashRoute() {
  if (typeof window !== 'undefined' && window.__DW_INITIAL_TOOL__) {
    const pre = SEO_TOOLS.find(t => t.id === window.__DW_INITIAL_TOOL__);
    if (pre) {
      state.activeTool = pre.id;
      state.mode = 'tools';
      if (pre.id === 'compare-two-csv-files') {
        state.toolInputA = PRODUCT_CATALOG_V1_CSV;
        state.toolInputB = PRODUCT_CATALOG_V2_CSV;
        state.toolParam = 'sku';
      } else if (pre.id === 'csv-cleaner' || pre.id === 'csv-to-json' || pre.id === 'csv-deduplicator') {
        state.toolInputA = MESSY_CUSTOMERS_CSV;
        state.toolParam = 'customer_id';
      } else {
        state.toolInputA = API_RESPONSE_JSON;
        state.toolInputB = API_RESPONSE_JSON.replace('"refunded"', '"paid"');
        state.toolParam = '$.data[?@.status == "paid"].order_id';
      }
      return;
    }
  }
  if (location.hash.startsWith('#recipe=')) {
    try {
      const wf = decodeWorkflowRecipe(location.hash.slice('#recipe='.length));
      state.recorder = new WorkflowRecorder(wf);
      layoutNodesAuto();
      state.mode = 'canvas';
      state.toast = 'Loaded shared zero-data workflow recipe from URL.';
      return;
    } catch {}
  }
  const hash = location.hash.replace(/^#\/?/, '');
  const matched = SEO_TOOLS.find(t => t.id === hash);
  if (matched) {
    state.activeTool = matched.id;
    state.mode = 'tools';
  }
}
window.addEventListener('hashchange', () => { syncHashRoute(); render(); });

// Init
layoutNodesAuto();
recomputeAnalysis();
syncHashRoute();
render();


// Sidebar Node Library -> Canvas Drag-and-Drop
document.addEventListener('dragstart', (e) => {
  const item = e.target.closest('[data-drag-node-type]');
  if (!item) return;
  e.dataTransfer.setData('application/x-dw-node', item.dataset.dragNodeType);
  e.dataTransfer.effectAllowed = 'copy';
});

document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    if (!state.fileDragOver) { state.fileDragOver = true; render(); }
    return;
  }
  const cv = e.target.closest('.canvas-viewport');
  if (cv && e.dataTransfer?.types?.includes('application/x-dw-node')) {
    e.preventDefault();
    cv.classList.add('drag-over');
  }
});

document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null && state.fileDragOver) {
    state.fileDragOver = false;
    render();
  }
  const cv = e.target.closest('.canvas-viewport');
  if (cv) cv.classList.remove('drag-over');
});

document.addEventListener('drop', (e) => {
  // 1. Node dropped from Sidebar onto Canvas
  const nodeType = e.dataTransfer?.getData('application/x-dw-node');
  if (nodeType) {
    e.preventDefault();
    const cv = e.target.closest('.canvas-viewport');
    if (cv) {
      cv.classList.remove('drag-over');
      const rect = cv.getBoundingClientRect();
      const x = Math.max(20, Math.round((e.clientX - rect.left + cv.scrollLeft) / state.canvasZoom - 105));
      const y = Math.max(20, Math.round((e.clientY - rect.top + cv.scrollTop) / state.canvasZoom - 28));
      const def = getNodeDefinition(nodeType);
      const added = state.recorder.addStep(nodeType, structuredClone(def?.defaultParams || {}));
      state.nodePositions[added.id] = { x, y };
      state.selectedNodeId = added.id;
      showToast(`Added ${def?.label || nodeType} onto Canvas`);
      render();
    }
    return;
  }

  // 2. Local File dropped anywhere onto window
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    e.preventDefault();
    state.fileDragOver = false;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      if (file.name.endsWith('.workflow.json') || (file.name.endsWith('.json') && text.includes('"schemaVersion"'))) {
        try {
          state.recorder = new WorkflowRecorder(JSON.parse(text));
          layoutNodesAuto();
          state.mode = 'canvas';
          showToast(`Loaded workflow: ${file.name}`);
          render();
          return;
        } catch {}
      }
      loadRawData(file.name, text);
      showToast(`Opened ${file.name} locally (0 bytes uploaded)`);
    };
    reader.readAsText(file);
  }
});

let _scrollRaf = null;
window.__dwGridScroll = (top) => {
  if (Math.abs(top - state.gridScrollTop) < 120) return;
  if (_scrollRaf) return;
  _scrollRaf = setTimeout(() => {
    _scrollRaf = null;
    state.gridScrollTop = top;
    const prev = document.getElementById('virtual-grid-wrap')?.scrollTop || top;
    render();
    const next = document.getElementById('virtual-grid-wrap');
    if (next) next.scrollTop = prev;
  }, 32);
};
