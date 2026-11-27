import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveNodeTypeFuzzy, checkColumnReferences, compactPayload } from '../packages/ai-api/index.js';
import { handleToolCall, MCP_TOOLS } from '../apps/mcp-server/src/server.js';
import { createApiServer } from '../apps/api/server.js';
import { MESSY_CUSTOMERS_CSV, PRODUCT_CATALOG_V1_CSV, PRODUCT_CATALOG_V2_CSV } from '../packages/test-fixtures/index.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('AI-Native Ergonomics: fuzzy node aliases, didYouMean recovery & token-budget compactPayload', () => {
  assert.equal(resolveNodeTypeFuzzy('dedupe').resolved, 'transform.deduplicate');
  assert.equal(resolveNodeTypeFuzzy('mask_pii').resolved, 'clean.piiMask');
  const typo = resolveNodeTypeFuzzy('transform.deduplicat');
  assert.equal(typo.resolved, null);
  assert.ok(typo.didYouMean.includes('transform.deduplicate'));

  const colErr = checkColumnReferences({ column: 'emial' }, ['customer_id', 'email', 'signup_date']);
  assert.equal(colErr.ok, false);
  assert.equal(colErr.error.code, 'COLUMN_NOT_FOUND');
  assert.equal(colErr.error.didYouMean.emial[0], 'email');

  const big = { rows: Array.from({ length: 100 }, (_, i) => i) };
  const compacted = compactPayload(big, { maxArrayItems: 5 });
  assert.equal(compacted.rows.truncated, true);
  assert.equal(compacted.rows.totalCount, 100);
  assert.equal(compacted.rows.items.length, 5);
});

test('AI-Native MCP Server: 10 tools, list_nodes, compile_plan, fuzzy preview & inline dry-run workflow', async () => {
  assert.equal(MCP_TOOLS.length, 10);

  const catalog = await handleToolCall('list_nodes', { category: 'Transform' }, ROOT);
  assert.equal(catalog.ok, true);
  assert.ok(catalog.nodes.some(n => n.type === 'transform.deduplicate' && n.aliases.includes('dedupe')));

  // Misspelled nodeType returns structured self-healing error instead of throwing
  const badNode = await handleToolCall('preview_transform', { inlineData: MESSY_CUSTOMERS_CSV, nodeType: 'deduplicat' }, ROOT);
  assert.equal(badNode.ok, false);
  assert.equal(badNode.error.code, 'UNKNOWN_NODE_TYPE');
  assert.ok(badNode.error.didYouMean.includes('transform.deduplicate'));

  // Fuzzy alias ("dedupe") + inlineData works directly without writing a file to disk!
  const preview = await handleToolCall('preview_transform', {
    inlineData: MESSY_CUSTOMERS_CSV,
    nodeType: 'dedupe',
    params: { keys: ['customer_id'], keep: 'last' }
  }, ROOT);
  assert.equal(preview.ok, true);
  assert.equal(preview.nodeType, 'transform.deduplicate');
  assert.equal(preview.beforeRows, 11);
  assert.equal(preview.afterRows, 9);

  // Inline workflow execution with dryRun: true and fuzzy aliases inside workflow JSON
  const inlineRun = await handleToolCall('run_workflow', {
    dryRun: true,
    inlineData: MESSY_CUSTOMERS_CSV,
    workflow: {
      schemaVersion: '1.0',
      workflow: {
        id: 'agent-inline-test',
        name: 'Agent Inline Test',
        nodes: [
          { id: 's1', type: 'csv', params: { header: true } },
          { id: 'd1', type: 'dedupe', params: { keys: ['customer_id'], keep: 'last' } }
        ],
        edges: [{ from: 's1', to: 'd1' }]
      }
    }
  }, ROOT);
  assert.equal(inlineRun.ok, true);
  assert.equal(inlineRun.dryRun, true);
  assert.equal(inlineRun.outputRowCount, 9);

  // NL compile_plan tool
  const planRes = await handleToolCall('compile_plan', {
    prompt: 'lowercase email and deduplicate by customer_id keep last',
    inlineData: MESSY_CUSTOMERS_CSV
  }, ROOT);
  assert.equal(planRes.ok, true);
  assert.ok(planRes.plan.steps.length >= 2);
});

test('Local OpenAPI 3.1 REST Server: /openapi.json, /v1/nodes, /v1/preview (error recovery), /v1/run & /v1/diff', async () => {
  const server = createApiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const oaRes = await fetch(`${base}/openapi.json`);
    assert.equal(oaRes.status, 200);
    const oa = await oaRes.json();
    assert.equal(oa.openapi, '3.1.0');
    assert.ok(oa.paths['/v1/run']);

    // Structured 400 error recovery on misspelled column
    const badColRes = await fetch(`${base}/v1/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: MESSY_CUSTOMERS_CSV, nodeType: 'filter', params: { column: 'emial', operator: 'notNull' } })
    });
    assert.equal(badColRes.status, 400);
    const badCol = await badColRes.json();
    assert.equal(badCol.error.code, 'COLUMN_NOT_FOUND');
    assert.equal(badCol.error.didYouMean.emial[0], 'email');

    // Valid /v1/diff
    const diffRes = await fetch(`${base}/v1/diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ left: PRODUCT_CATALOG_V1_CSV, right: PRODUCT_CATALOG_V2_CSV, keys: ['sku'] })
    });
    assert.equal(diffRes.status, 200);
    const diff = await diffRes.json();
    assert.equal(diff.summary.changed, 3);
    assert.equal(diff.summary.added, 1);
  } finally {
    server.close();
  }
});
