#!/usr/bin/env node
/**
 * Data Workbench 2.1.2 — Zero-Dependency Local OpenAPI 3.1 REST Server (`apps/api/server.js`)
 * Localhost-only by default (127.0.0.1) for LangChain, OpenAI Function Calling, CrewAI, and custom AI agents.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /openapi.json
 *   GET  /v1/nodes
 *   POST /v1/profile
 *   POST /v1/preview
 *   POST /v1/run
 *   POST /v1/diff
 *   POST /v1/plan
 */

import http from 'node:http';
import path from 'node:path';
import { listAdapters } from '../../packages/engine-core/index.js';
import { parseCsv } from '../../packages/csv-engine/index.js';
import { validateJson, jsonToTabular } from '../../packages/json-engine/index.js';
import { profileDataset, explainDataset } from '../../packages/quality-engine/index.js';
import { diffTables, diffJson } from '../../packages/diff-engine/index.js';
import { getNodeDefinition } from '../../packages/node-registry/index.js';
import { executeWorkflow, compileNaturalLanguagePlan, ENGINE_VERSION } from '../../packages/workflow-core/index.js';
import {
  resolveNodeTypeFuzzy,
  checkColumnReferences,
  makeStructuredError,
  compactPayload,
  getAiNodeCatalog
} from '../../packages/ai-api/index.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export function buildOpenApiSpec(baseUrl = 'http://127.0.0.1:4173') {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Data Workbench Local AI API',
      version: ENGINE_VERSION,
      description: 'Local-first deterministic data cleaning, quality profiling, diffing, and workflow execution API designed for AI Agents.'
    },
    servers: [{ url: baseUrl, description: 'Localhost-only server' }],
    paths: {
      '/health': { get: { summary: 'Health & engine adapter telemetry', responses: { '200': { description: 'OK' } } } },
      '/v1/nodes': { get: { summary: 'List all 28 nodes, fuzzy aliases, ports & paramSchemas', responses: { '200': { description: 'Node catalog' } } } },
      '/v1/profile': { post: { summary: 'Run Data Quality Radar & Explain Dataset on inline CSV/JSON', responses: { '200': { description: 'Quality profile' } } } },
      '/v1/preview': { post: { summary: 'Dry-run a single transform node with fuzzy alias & typo recovery', responses: { '200': { description: 'Preview result' }, '400': { description: 'Structured self-healing error' } } } },
      '/v1/run': { post: { summary: 'Execute an inline Workflow JSON v1.0 DAG on inline data', responses: { '200': { description: 'Run result' } } } },
      '/v1/diff': { post: { summary: 'Compare two CSV or JSON payloads', responses: { '200': { description: 'Diff summary & details' } } } },
      '/v1/plan': { post: { summary: 'Compile natural language (EN/ZH) into a reviewable operation plan', responses: { '200': { description: 'Structured plan' } } } }
    }
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes limit.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function parseInlinePayload(raw) {
  if (typeof raw === 'object' && raw !== null) {
    return { kind: 'json', raw: JSON.stringify(raw), data: raw, dataset: jsonToTabular(raw) };
  }
  const str = String(raw ?? '');
  const trimmed = str.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const v = validateJson(trimmed);
    if (v.valid) return { kind: 'json', raw: str, data: v.data, dataset: jsonToTabular(v.data) };
  }
  return { kind: 'csv', raw: str, dataset: parseCsv(str) };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Data-Workbench-Version': ENGINE_VERSION,
    'X-Local-First': 'true'
  });
  res.end(body);
}

export function createApiServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, { ok: true, engineVersion: ENGINE_VERSION, localOnly: true, adapters: listAdapters() });
      }

      if (req.method === 'GET' && pathname === '/openapi.json') {
        const host = req.headers.host || '127.0.0.1:4173';
        return sendJson(res, 200, buildOpenApiSpec(`http://${host}`));
      }

      if (req.method === 'GET' && pathname === '/v1/nodes') {
        const cat = url.searchParams.get('category');
        const nodes = getAiNodeCatalog(cat);
        return sendJson(res, 200, { ok: true, count: nodes.length, nodes });
      }

      if (req.method === 'POST' && pathname === '/v1/profile') {
        const body = await readJsonBody(req);
        const loaded = parseInlinePayload(body.data);
        const profile = profileDataset(loaded.dataset);
        const explanation = explainDataset(loaded.dataset, profile);
        const out = { ok: true, summary: profile.summary, issues: profile.issues, explanation };
        return sendJson(res, 200, body.compact !== false ? compactPayload(out) : out);
      }

      if (req.method === 'POST' && pathname === '/v1/preview') {
        const body = await readJsonBody(req);
        const loaded = parseInlinePayload(body.data);
        const resolved = resolveNodeTypeFuzzy(body.nodeType);
        if (!resolved.resolved) {
          return sendJson(res, 400, makeStructuredError('UNKNOWN_NODE_TYPE', `Unknown nodeType "${body.nodeType}".`, {
            didYouMean: resolved.didYouMean,
            hint: 'GET /v1/nodes to inspect all 28 node types and fuzzy aliases.'
          }));
        }
        const colErr = checkColumnReferences(body.params, loaded.dataset.columns);
        if (colErr) return sendJson(res, 400, colErr);

        const def = getNodeDefinition(resolved.resolved);
        const r = await def.execute([loaded.dataset], { ...(def.defaultParams || {}), ...(body.params || {}) }, {
          signal: new AbortController().signal,
          reportProgress: () => {},
          emitMetric: () => {}
        });
        const outDs = r.output?.[0];
        const out = {
          ok: r.errors.length === 0,
          nodeType: resolved.resolved,
          aliasedFrom: resolved.aliased ? resolved.original : undefined,
          beforeRows: loaded.dataset.rows.length,
          afterRows: outDs?.rowCount ?? outDs?.rows?.length ?? 0,
          previewRows: outDs ? (typeof outDs.sliceRows === 'function' ? outDs.sliceRows(0, 10) : outDs.rows.slice(0, 10)) : [],
          warnings: r.warnings,
          errors: r.errors
        };
        return sendJson(res, 200, body.compact !== false ? compactPayload(out) : out);
      }

      if (req.method === 'POST' && pathname === '/v1/run') {
        const body = await readJsonBody(req);
        if (!body.workflow) {
          return sendJson(res, 400, makeStructuredError('MISSING_WORKFLOW', 'Missing "workflow" JSON v1.0 object in request body.', {
            hint: 'Provide { workflow: { schemaVersion: "1.0", workflow: { ... } }, data: "..." }.'
          }));
        }
        const wfDoc = structuredClone(body.workflow);
        for (const n of wfDoc?.workflow?.nodes || []) {
          const r = resolveNodeTypeFuzzy(n.type);
          if (r.resolved) n.type = r.resolved;
        }
        const firstSource = wfDoc.workflow?.nodes?.find(n => n.type.startsWith('source.'));
        const inputsByNodeId = firstSource && body.data !== undefined ? { [firstSource.id]: body.data } : {};
        const runRes = await executeWorkflow(wfDoc, { inputsByNodeId });
        const outDs = runRes.finalOutput;
        const out = {
          ok: runRes.status !== 'failed',
          status: runRes.status,
          adapter: runRes.adapter,
          durationMs: runRes.durationMs,
          outputRowCount: outDs?.rowCount ?? outDs?.rows?.length ?? 0,
          previewRows: outDs ? (typeof outDs.sliceRows === 'function' ? outDs.sliceRows(0, 20) : outDs.rows.slice(0, 20)) : [],
          exportedText: body.includeExport ? outDs?.exportedText : undefined,
          warnings: runRes.warnings,
          errors: runRes.errors
        };
        return sendJson(res, runRes.status === 'failed' ? 400 : 200, body.compact !== false ? compactPayload(out) : out);
      }

      if (req.method === 'POST' && pathname === '/v1/diff') {
        const body = await readJsonBody(req);
        const left = parseInlinePayload(body.left);
        const right = parseInlinePayload(body.right);
        if (left.kind === 'json' && right.kind === 'json' && !(body.keys?.length)) {
          const d = diffJson(left.data, right.data, body.options || {});
          return sendJson(res, 200, { ok: true, mode: 'json', summary: d.summary, diffs: d.diffs.slice(0, 50) });
        }
        const d = diffTables(left.dataset, right.dataset, { keys: body.keys || [] });
        return sendJson(res, 200, { ok: true, mode: d.mode, warning: d.warning, summary: d.summary, changed: d.changed.slice(0, 50) });
      }

      if (req.method === 'POST' && pathname === '/v1/plan') {
        const body = await readJsonBody(req);
        const ds = body.data ? parseInlinePayload(body.data).dataset : null;
        return sendJson(res, 200, { ok: true, plan: compileNaturalLanguagePlan(body.prompt || '', ds) });
      }

      return sendJson(res, 404, makeStructuredError('NOT_FOUND', `Route ${req.method} ${pathname} not found.`, {
        hint: 'GET /openapi.json for all supported endpoints.'
      }));
    } catch (err) {
      return sendJson(res, 400, makeStructuredError('BAD_REQUEST', err.message || String(err)));
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : Number(process.env.PORT || 4173);
  const host = process.argv.includes('--allow-remote') ? '0.0.0.0' : '127.0.0.1';
  const server = createApiServer();
  server.listen(port, host, () => {
    console.log(`Data Workbench Local AI API v${ENGINE_VERSION} listening on http://${host}:${port} (OpenAPI: /openapi.json)`);
  });
}
