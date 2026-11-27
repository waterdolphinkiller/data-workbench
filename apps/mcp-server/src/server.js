#!/usr/bin/env node
/**
 * Data Workbench 2.1.2 AI-Native MCP Server (JSON-RPC 2.0 over stdio)
 * 10 sandboxed tools with fuzzy alias resolution, structured self-healing errors,
 * inline workflow & dry-run support, PII-safe previews, and token-budget compact mode:
 *   list_nodes, validate_workflow, compile_plan, inspect_file, profile_dataset,
 *   validate_schema, preview_transform, run_workflow, compare_files, get_run_report
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseCsv, detectCsvDialect } from '../../../packages/csv-engine/index.js';
import { validateJson, jsonToTabular } from '../../../packages/json-engine/index.js';
import { profileDataset, explainDataset, detectPii, maskPiiValue } from '../../../packages/quality-engine/index.js';
import { diffTables, diffJson } from '../../../packages/diff-engine/index.js';
import { validateAgainstSchema, generateJsonSchema, validateWorkflowDefinition } from '../../../packages/workflow-schema/index.js';
import { executeWorkflow, compileNaturalLanguagePlan, ENGINE_VERSION } from '../../../packages/workflow-core/index.js';
import { getNodeDefinition } from '../../../packages/node-registry/index.js';
import {
  resolveNodeTypeFuzzy,
  checkColumnReferences,
  makeStructuredError,
  compactPayload,
  getAiNodeCatalog
} from '../../../packages/ai-api/index.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RUN_REPORTS = 100;
const runReports = new Map();

function getSandboxRoot() {
  const idx = process.argv.indexOf('--sandbox');
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.DW_SANDBOX_DIR) return path.resolve(process.env.DW_SANDBOX_DIR);
  return process.cwd();
}

export function resolveSandboxedPath(relOrAbs, sandboxRoot) {
  const absRoot = path.resolve(sandboxRoot);
  const candidate = path.resolve(absRoot, relOrAbs);
  if (candidate !== absRoot && !candidate.startsWith(absRoot + path.sep)) {
    throw new Error(`Access denied: "${relOrAbs}" is outside authorized sandbox directory.`);
  }
  return candidate;
}

function parseInlineOrFileDataset(args, sandboxRoot, pathKey = 'filePath', inlineKey = 'inlineData') {
  if (args[inlineKey] !== undefined) {
    const raw = typeof args[inlineKey] === 'string' ? args[inlineKey] : JSON.stringify(args[inlineKey]);
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const v = validateJson(trimmed);
      if (v.valid) return { kind: 'json', sizeBytes: raw.length, raw, data: v.data, dataset: jsonToTabular(v.data) };
    }
    return { kind: 'csv', sizeBytes: raw.length, raw, dataset: parseCsv(raw) };
  }
  const filePath = args[pathKey];
  if (!filePath) throw new Error(`Provide either "${pathKey}" or "${inlineKey}".`);
  const abs = resolveSandboxedPath(filePath, sandboxRoot);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds MCP safety limit (${MAX_FILE_BYTES} bytes).`);
  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    const v = validateJson(raw);
    if (!v.valid) throw new Error(`Invalid JSON at L${v.line}:C${v.column}: ${v.error}`);
    return { kind: 'json', abs, sizeBytes: stat.size, raw, data: v.data, dataset: jsonToTabular(v.data) };
  }
  return { kind: 'csv', abs, sizeBytes: stat.size, raw, dataset: parseCsv(raw) };
}

function redactPreviewRows(dataset, maxRows = 5) {
  const pii = detectPii(dataset);
  const piiCols = new Set(pii.map(p => p.column));
  const slice = typeof dataset.sliceRows === 'function' ? dataset.sliceRows(0, maxRows) : (dataset.rows || []).slice(0, maxRows);
  return slice.map(row => {
    const safe = {};
    for (const [k, v] of Object.entries(row)) {
      safe[k] = piiCols.has(k) ? maskPiiValue(v, 'mask') : v;
    }
    return safe;
  });
}

export const MCP_TOOLS = [
  {
    name: 'list_nodes',
    description: 'Discover all 28 available workflow nodes, fuzzy aliases, ports, defaultParams, and capabilities. Call this before building workflows.',
    inputSchema: { type: 'object', properties: { category: { type: 'string' } } }
  },
  {
    name: 'validate_workflow',
    description: 'Validate a Workflow JSON v1.0 definition (inline object or file path) with self-healing node/port suggestions.',
    inputSchema: { type: 'object', properties: { workflow: { type: 'object' }, workflowPath: { type: 'string' } } }
  },
  {
    name: 'compile_plan',
    description: 'Compile a natural-language cleaning request (English or Chinese) into a deterministic, reviewable operation plan.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, filePath: { type: 'string' }, inlineData: { type: 'string' } }, required: ['prompt'] }
  },
  {
    name: 'inspect_file',
    description: 'Inspect file metadata, CSV dialect/encoding detection, columns, and PII-redacted sample rows.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, inlineData: { type: 'string' }, sampleRows: { type: 'number' }, compact: { type: 'boolean' } } }
  },
  {
    name: 'profile_dataset',
    description: 'Run Data Quality Radar and Explain This Dataset on a sandboxed CSV/JSON file or inline data.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, inlineData: { type: 'string' }, compact: { type: 'boolean' } } }
  },
  {
    name: 'validate_schema',
    description: 'Validate a dataset against a JSON Schema 2020-12 object (or auto-generate one if omitted).',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, inlineData: { type: 'string' }, schema: { type: 'object' }, compact: { type: 'boolean' } } }
  },
  {
    name: 'preview_transform',
    description: 'Preview a single deterministic transform node (supports fuzzy aliases like "dedupe", "filter", "mask_pii") without modifying source files.',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' }, inlineData: { type: 'string' }, nodeType: { type: 'string' }, params: { type: 'object' }, compact: { type: 'boolean' } },
      required: ['nodeType']
    }
  },
  {
    name: 'run_workflow',
    description: 'Execute a Workflow JSON v1.0 pipeline (accepts inline `workflow` object OR `workflowPath`, and `inlineData` OR `inputPath`, plus `dryRun`).',
    inputSchema: {
      type: 'object',
      properties: { workflow: { type: 'object' }, workflowPath: { type: 'string' }, inputPath: { type: 'string' }, inlineData: { type: 'string' }, dryRun: { type: 'boolean' }, compact: { type: 'boolean' } }
    }
  },
  {
    name: 'compare_files',
    description: 'Compare two CSV or JSON files (primary-key diff for CSV, path/value diff for JSON).',
    inputSchema: {
      type: 'object',
      properties: { leftPath: { type: 'string' }, rightPath: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, compact: { type: 'boolean' } },
      required: ['leftPath', 'rightPath']
    }
  },
  {
    name: 'get_run_report',
    description: 'Retrieve a previously recorded workflow run report by runId.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }
  }
];

export async function handleToolCall(name, args = {}, sandboxRoot = getSandboxRoot()) {
  const useCompact = args.compact !== false; // Compact by default to protect Agent context window

  if (name === 'list_nodes') {
    const catalog = getAiNodeCatalog(args.category);
    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      count: catalog.length,
      nodes: catalog
    };
  }

  if (name === 'validate_workflow') {
    const wfDoc = args.workflow || JSON.parse(fs.readFileSync(resolveSandboxedPath(args.workflowPath, sandboxRoot), 'utf8'));
    const val = validateWorkflowDefinition(wfDoc);
    const nodeSuggestions = {};
    for (const n of wfDoc?.workflow?.nodes || []) {
      const r = resolveNodeTypeFuzzy(n.type);
      if (!r.resolved) nodeSuggestions[n.id] = { invalidType: n.type, didYouMean: r.didYouMean };
    }
    return { ok: val.valid && Object.keys(nodeSuggestions).length === 0, ...val, nodeSuggestions };
  }

  if (name === 'compile_plan') {
    let ds = null;
    if (args.filePath || args.inlineData) {
      ds = parseInlineOrFileDataset(args, sandboxRoot).dataset;
    }
    return { ok: true, plan: compileNaturalLanguagePlan(args.prompt, ds) };
  }

  if (name === 'inspect_file') {
    const loaded = parseInlineOrFileDataset(args, sandboxRoot);
    const res = {
      ok: true,
      filePath: args.filePath || '(inline)',
      kind: loaded.kind,
      sizeBytes: loaded.sizeBytes,
      rowCount: loaded.dataset.rows.length,
      columns: loaded.dataset.columns,
      dialect: loaded.kind === 'csv' ? detectCsvDialect(loaded.raw) : null,
      redactedSample: redactPreviewRows(loaded.dataset, Math.min(args.sampleRows ?? 5, 10)),
      privacyNote: 'Suspected PII columns are automatically masked in MCP previews.'
    };
    return useCompact ? compactPayload(res) : res;
  }

  if (name === 'profile_dataset') {
    const loaded = parseInlineOrFileDataset(args, sandboxRoot);
    const profile = profileDataset(loaded.dataset);
    const explanation = explainDataset(loaded.dataset, profile);
    const res = { ok: true, summary: profile.summary, issues: profile.issues.slice(0, 20), explanation };
    return useCompact ? compactPayload(res) : res;
  }

  if (name === 'validate_schema') {
    const loaded = parseInlineOrFileDataset(args, sandboxRoot);
    const target = loaded.kind === 'json' ? loaded.data : loaded.dataset.rows;
    const schema = args.schema || generateJsonSchema(target, { title: args.filePath ? path.basename(args.filePath) : 'inline' });
    const validation = validateAgainstSchema(target, schema);
    const res = { ok: validation.valid, valid: validation.valid, errorCount: validation.errors.length, errors: validation.errors.slice(0, 20), schema };
    return useCompact ? compactPayload(res) : res;
  }

  if (name === 'preview_transform') {
    const loaded = parseInlineOrFileDataset(args, sandboxRoot);
    const resolved = resolveNodeTypeFuzzy(args.nodeType);
    if (!resolved.resolved) {
      return makeStructuredError('UNKNOWN_NODE_TYPE', `Unknown nodeType "${args.nodeType}".`, {
        didYouMean: resolved.didYouMean,
        hint: 'Call `list_nodes` to inspect all 28 supported node types and fuzzy aliases.'
      });
    }
    const colErr = checkColumnReferences(args.params, loaded.dataset.columns);
    if (colErr) return colErr;

    const def = getNodeDefinition(resolved.resolved);
    const res = await def.execute([loaded.dataset], { ...(def.defaultParams || {}), ...(args.params || {}) }, {
      signal: new AbortController().signal,
      reportProgress: () => {},
      emitMetric: () => {}
    });
    const outDs = res.output?.[0];
    const payload = {
      ok: res.errors.length === 0,
      nodeType: resolved.resolved,
      aliasedFrom: resolved.aliased ? resolved.original : undefined,
      beforeRows: loaded.dataset.rows.length,
      afterRows: outDs?.rowCount ?? outDs?.rows?.length ?? 0,
      warnings: res.warnings,
      errors: res.errors,
      redactedPreview: outDs ? redactPreviewRows(outDs, 5) : []
    };
    return useCompact ? compactPayload(payload) : payload;
  }

  if (name === 'run_workflow') {
    const wfDoc = args.workflow
      ? structuredClone(args.workflow)
      : JSON.parse(fs.readFileSync(resolveSandboxedPath(args.workflowPath, sandboxRoot), 'utf8'));

    // Auto-resolve fuzzy node aliases inside inline AI workflows
    for (const n of wfDoc?.workflow?.nodes || []) {
      const r = resolveNodeTypeFuzzy(n.type);
      if (r.resolved) n.type = r.resolved;
    }

    const loaded = parseInlineOrFileDataset(args, sandboxRoot, 'inputPath', 'inlineData');
    const firstSource = wfDoc.workflow?.nodes?.find(n => n.type.startsWith('source.'));
    const inputsByNodeId = firstSource ? { [firstSource.id]: loaded.raw } : {};
    const runRes = await executeWorkflow(wfDoc, { inputsByNodeId });
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const report = {
      ok: runRes.status !== 'failed',
      runId,
      dryRun: Boolean(args.dryRun),
      status: runRes.status,
      adapter: runRes.adapter,
      workflowId: runRes.workflowId,
      durationMs: runRes.durationMs,
      outputRowCount: runRes.finalOutput?.rowCount ?? runRes.finalOutput?.rows?.length ?? 0,
      warnings: runRes.warnings,
      errors: runRes.errors,
      logs: runRes.logs,
      redactedPreview: runRes.finalOutput ? redactPreviewRows(runRes.finalOutput, 5) : []
    };
    runReports.set(runId, report);
    if (runReports.size > MAX_RUN_REPORTS) runReports.delete(runReports.keys().next().value);
    return useCompact ? compactPayload(report) : report;
  }

  if (name === 'compare_files') {
    const left = parseInlineOrFileDataset({ filePath: args.leftPath }, sandboxRoot);
    const right = parseInlineOrFileDataset({ filePath: args.rightPath }, sandboxRoot);
    if (left.kind === 'json' && right.kind === 'json' && !(args.keys?.length)) {
      const d = diffJson(left.data, right.data);
      const res = { ok: true, mode: 'json', summary: d.summary, diffs: d.diffs.slice(0, 50) };
      return useCompact ? compactPayload(res) : res;
    }
    const d = diffTables(left.dataset, right.dataset, { keys: args.keys || [] });
    const res = {
      ok: true,
      mode: d.mode,
      warning: d.warning,
      summary: d.summary,
      sampleChanged: d.changed.slice(0, 20).map(c => ({ key: c.key, changes: c.changes }))
    };
    return useCompact ? compactPayload(res) : res;
  }

  if (name === 'get_run_report') {
    const report = runReports.get(args.runId);
    if (!report) {
      return makeStructuredError('RUN_NOT_FOUND', `Run report "${args.runId}" not found.`, {
        availableRunIds: Array.from(runReports.keys()).slice(-5),
        hint: 'Call `run_workflow` first to generate a runId.'
      });
    }
    return report;
  }

  return makeStructuredError('UNKNOWN_TOOL', `Unknown MCP tool "${name}".`, {
    validTools: MCP_TOOLS.map(t => t.name),
    hint: 'Use one of the validTools returned above.'
  });
}

async function handleJsonRpc(msg, sandboxRoot) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'data-workbench-mcp', version: ENGINE_VERSION }
        }
      };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }
    if (method === 'tools/call') {
      const data = await handleToolCall(params?.name, params?.arguments || {}, sandboxRoot);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message || String(err) } };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const sandboxRoot = getSandboxRoot();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id === undefined) return;
      const reply = await handleJsonRpc(msg, sandboxRoot);
      process.stdout.write(JSON.stringify(reply) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } }) + '\n');
    }
  });
}
