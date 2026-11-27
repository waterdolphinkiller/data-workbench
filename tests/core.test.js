import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectCsvDialect, parseCsv, parseCsvChunks, serializeCsv } from '../packages/csv-engine/index.js';
import {
  validateJson, formatJson, parseNdjson, serializeNdjson,
  flattenObject, unflattenObject, queryJsonPath, parseYaml, serializeYaml, parseXml, serializeXml
} from '../packages/json-engine/index.js';
import { profileDataset, detectPii, maskPiiValue, suggestFixes, explainDataset } from '../packages/quality-engine/index.js';
import { diffTables, diffJson, formatDiffReport } from '../packages/diff-engine/index.js';
import {
  validateWorkflowDefinition, generateJsonSchema, validateAgainstSchema,
  createSchemaSnapshot, diffSchemaSnapshots, validateDataContract
} from '../packages/workflow-schema/index.js';
import { listNodes } from '../packages/node-registry/index.js';
import {
  executeWorkflow, WorkflowRecorder, runRegressionTests,
  compileNaturalLanguagePlan, generateCodeViews, exportWorkflowPackage
} from '../packages/workflow-core/index.js';
import {
  MESSY_CUSTOMERS_CSV, API_RESPONSE_JSON, PRODUCT_CATALOG_V1_CSV, PRODUCT_CATALOG_V2_CSV, SAMPLE_CLEAN_WORKFLOW
} from '../packages/test-fixtures/index.js';
import { handleToolCall, resolveSandboxedPath } from '../apps/mcp-server/src/server.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('CSV Engine: dialect detection, bad rows, chunking & formula injection guard', () => {
  const semiCsv = 'id;name;amount\n1;Alice;100\n2;Bob;200;EXTRA\n';
  const dialect = detectCsvDialect(semiCsv);
  assert.equal(dialect.delimiter, ';');
  assert.equal(dialect.hasHeader, true);

  const parsed = parseCsv(semiCsv);
  assert.equal(parsed.columns.length, 3);
  assert.equal(parsed.badRows.length, 1);
  assert.equal(parsed.badRows[0].actualColumns, 4);

  // Chunk streaming
  const chunks = Array.from(parseCsvChunks(MESSY_CUSTOMERS_CSV, { chunkSize: 4 }));
  assert.equal(chunks.length, 3);
  assert.equal(chunks.reduce((a, c) => a + c.rows.length, 0), 11);

  // Formula Injection Guard (Section 13.3)
  const messy = parseCsv(MESSY_CUSTOMERS_CSV);
  const safeCsv = serializeCsv(messy, { formulaGuard: true });
  assert.ok(safeCsv.includes(`'=HYPERLINK`), 'Expected formula-prefixed cell to be escaped with leading apostrophe');
});

test('JSON Engine: validator, formatter, NDJSON, flatten/unflatten, RFC 9535 JSONPath, YAML & XML', () => {
  const bad = validateJson('{"a": 1,\n  "b": }');
  assert.equal(bad.valid, false);
  assert.ok(bad.line >= 1);

  const formatted = formatJson('{"z":1,"a":2}', { sortKeys: true, minify: true });
  assert.equal(formatted, '{"a":2,"z":1}');

  const nd = parseNdjson('{"id":1}\n{"id":2}\nbad-json\n');
  assert.equal(nd.rows.length, 2);
  assert.equal(nd.errors.length, 1);
  assert.equal(serializeNdjson(nd.rows), '{"id":1}\n{"id":2}');

  const nested = { user: { name: 'Ada', address: { city: 'KL' } } };
  const flat = flattenObject(nested);
  assert.equal(flat['user.address.city'], 'KL');
  assert.deepEqual(unflattenObject(flat), nested);

  // RFC 9535 JSONPath
  const apiObj = JSON.parse(API_RESPONSE_JSON);
  const jp = queryJsonPath(apiObj, '$.data[?@.status == "paid"].order_id');
  assert.deepEqual(jp.values, ['ORD-5001', 'ORD-5003']);
  assert.equal(jp.paths.length, 2);

  // YAML round-trip
  const yamlStr = serializeYaml({ name: 'dw', enabled: true, tags: ['csv', 'json'] });
  const yamlParsed = parseYaml(yamlStr);
  assert.equal(yamlParsed.name, 'dw');
  assert.equal(yamlParsed.enabled, true);
  assert.deepEqual(yamlParsed.tags, ['csv', 'json']);

  // XML parse & serialize
  const xmlObj = parseXml('<catalog><item sku="A1"><price>19.99</price></item></catalog>');
  assert.equal(xmlObj.catalog.item['@sku'], 'A1');
  assert.equal(xmlObj.catalog.item.price, 19.99);
  assert.ok(serializeXml({ price: 10 }, 'item').includes('<price>10</price>'));
});

test('Quality Engine: Data Quality Radar, PII Sentinel, Fix Preview & Explain Dataset', () => {
  const ds = parseCsv(MESSY_CUSTOMERS_CSV);
  const prof = profileDataset(ds);
  assert.equal(prof.summary.rowCount, 11);
  assert.ok(prof.summary.piiColumnCount >= 2, 'Expected email and phone PII detection');
  assert.ok(prof.issues.length > 0);

  const pii = detectPii(ds);
  assert.ok(pii.some(p => p.column === 'email' && p.piiType === 'email'));
  assert.equal(maskPiiValue('alice@example.com', 'mask'), 'a***@example.com');
  assert.ok(maskPiiValue('alice@example.com', 'hash').startsWith('h_'));
  assert.equal(maskPiiValue('1234567890', 'keepLast', { keepLast: 4 }), '******7890');
  assert.equal(maskPiiValue('secret', 'remove'), null);

  const fixes = suggestFixes(ds, prof);
  assert.ok(fixes.length >= 3, 'Expected multiple fix proposals');
  assert.ok(fixes.every(f => f.confidence && Array.isArray(f.beforeAfterSamples)));

  const exp = explainDataset(ds, prof);
  assert.ok(exp.disclaimer.includes('guesses'));
  assert.ok(exp.columnExplanations.length === ds.columns.length);
});

test('Diff Engine: CSV Primary-Key Diff, Row-Hash Fallback, JSON Diff & XSS-safe HTML Report', () => {
  const v1 = parseCsv(PRODUCT_CATALOG_V1_CSV);
  const v2 = parseCsv(PRODUCT_CATALOG_V2_CSV);
  const diff = diffTables(v1, v2, { keys: ['sku'] });
  assert.equal(diff.mode, 'primary-key');
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.changed, 3);
  assert.equal(diff.summary.unchanged, 1);

  const hashDiff = diffTables(v1, v2, { keys: [] });
  assert.equal(hashDiff.mode, 'row-hash');
  assert.ok(hashDiff.warning.includes('row-content hash'));

  const jDiff = diffJson({ a: 1, b: [1, 2], ts: 100 }, { a: 1.001, b: [2, 1], ts: 200 }, {
    ignorePaths: ['$.ts'],
    ignoreArrayOrder: true,
    numericTolerance: 0.01
  });
  assert.equal(jDiff.summary.totalDiffs, 0);

  // XSS escaping in HTML report
  const xssDiff = diffJson({ a: '<script>alert(1)</script>' }, { a: 'safe' });
  const html = formatDiffReport(xssDiff, 'html');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('Workflow Schema: DAG cycle rejection, JSON Schema 2020-12, Schema Guardian Drift & Data Contract', () => {
  const cyclic = {
    schemaVersion: '1.0',
    workflow: {
      id: 'cyc', name: 'Cyclic',
      nodes: [{ id: 'a', type: 'source.csv' }, { id: 'b', type: 'clean.text' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]
    }
  };
  const val = validateWorkflowDefinition(cyclic);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some(e => e.includes('cycle')));

  const snap1 = createSchemaSnapshot([{ id: 1, email: 'a@b.com', note: 'hi' }], 'v1');
  const snap2 = createSchemaSnapshot([{ id: 'one', added_col: true }], 'v2');
  const drift = diffSchemaSnapshots(snap1, snap2);
  assert.equal(drift.compatible, false);
  assert.ok(drift.breakingCount >= 2);

  const schema = generateJsonSchema([{ id: 1, email: 'a@b.com' }]);
  assert.equal(validateAgainstSchema([{ id: 2, email: 'bad-email' }], schema).valid, false);

  const ds = parseCsv(MESSY_CUSTOMERS_CSV);
  const contractRes = validateDataContract(ds, { requiredColumns: ['customer_id', 'missing_col'], minRows: 5 });
  assert.equal(contractRes.passed, false);
});

test('Workflow Core: 24+ nodes, DAG Execution, Before/After Diff, Recorder Undo/Redo, Copilot, Regression & Package', async () => {
  const nodes = listNodes();
  assert.ok(nodes.length >= 24, `Expected >=24 nodes, got ${nodes.length}`);

  const run = await executeWorkflow(SAMPLE_CLEAN_WORKFLOW, {
    inputsByNodeId: { 'input-1': MESSY_CUSTOMERS_CSV }
  });
  assert.ok(run.status === 'success' || run.status === 'warning');
  assert.equal(run.finalOutput.rows.length, 9, 'Expected 11 rows deduplicated down to 9 unique customer_id rows');
  assert.equal(run.finalOutput.rows[0].email, 'alice@example.com');
  assert.ok(run.nodeResults['dedupe-1'].diff.rowsRemoved === 2);

  // AbortSignal cancellation
  const ac = new AbortController();
  ac.abort();
  const cancelled = await executeWorkflow(SAMPLE_CLEAN_WORKFLOW, {
    inputsByNodeId: { 'input-1': MESSY_CUSTOMERS_CSV },
    signal: ac.signal
  });
  assert.equal(cancelled.status, 'cancelled');

  // WorkflowRecorder Undo / Redo
  const rec = new WorkflowRecorder();
  rec.addStep('clean.text', { trim: true });
  assert.equal(rec.getWorkflow().workflow.nodes.length, 2);
  assert.equal(rec.undo(), true);
  assert.equal(rec.getWorkflow().workflow.nodes.length, 1);
  assert.equal(rec.redo(), true);
  assert.equal(rec.getWorkflow().workflow.nodes.length, 2);

  // Regression Tests
  const reg = runRegressionTests(parseCsv(MESSY_CUSTOMERS_CSV), run.finalOutput, {
    expectedColumns: ['customer_id', 'email'],
    uniqueKeys: ['customer_id'],
    maxRowDropRatio: 0.5
  });
  assert.equal(reg.overallStatus, 'PASS');

  // AI Rule Copilot (Chinese prompt)
  const plan = compileNaturalLanguagePlan('把邮箱统一转小写，删除重复订单，日期统一成 ISO 格式，最后导出 JSON', parseCsv(MESSY_CUSTOMERS_CSV));
  assert.equal(plan.dataSentExternally, false);
  assert.equal(plan.requiresApproval, true);
  assert.ok(plan.steps.length >= 4);

  // Code views & Workflow Package
  const code = generateCodeViews(SAMPLE_CLEAN_WORKFLOW);
  assert.ok(code.sqlPreview.includes('SELECT'));
  assert.ok(code.cliCommand.includes('dw run'));
  const pkg = exportWorkflowPackage(SAMPLE_CLEAN_WORKFLOW, { outputDataset: run.finalOutput });
  assert.ok(pkg['workflow.json'] && pkg['README.md'] && pkg['schemas/output.schema.json']);
});

test('CLI (`dw`) end-to-end: run, validate, diff, test & no-overwrite guard', () => {
  const cli = path.join(ROOT, 'apps/cli/bin/dw.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cli-'));
  const wfPath = path.join(ROOT, 'examples/01-messy-customers-cleanup/workflow.json');
  const inPath = path.join(ROOT, 'examples/01-messy-customers-cleanup/sample-input.csv');
  const contractPath = path.join(ROOT, 'examples/01-messy-customers-cleanup/contract.json');
  const expPath = path.join(ROOT, 'examples/01-messy-customers-cleanup/expectations.json');
  const outPath = path.join(tmpDir, 'clean.json');
  const reportPath = path.join(tmpDir, 'report.json');

  execFileSync('node', [cli, 'run', wfPath, '--input', inPath, '--output', outPath, '--report', reportPath], { encoding: 'utf8' });
  assert.ok(fs.existsSync(outPath));
  assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).length, 9);

  // Refuses to overwrite without --force
  assert.throws(() => {
    execFileSync('node', [cli, 'run', wfPath, '--input', inPath, '--output', outPath], { stdio: 'pipe' });
  });

  // Validate contract
  const valOut = execFileSync('node', [cli, 'validate', inPath, '--contract', contractPath], { encoding: 'utf8' });
  assert.equal(JSON.parse(valOut).passed, true);

  // Regression test
  const testOut = execFileSync('node', [cli, 'test', wfPath, '--input', inPath, '--expectations', expPath], { encoding: 'utf8' });
  assert.equal(JSON.parse(testOut).overallStatus, 'PASS');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('MCP Server: sandbox security, PII redaction, workflow execution & run reports', async () => {
  // Path traversal must be rejected
  assert.throws(() => resolveSandboxedPath('../../etc/passwd', ROOT), /outside authorized sandbox/);

  const inspect = await handleToolCall('inspect_file', { filePath: 'examples/01-messy-customers-cleanup/sample-input.csv' }, ROOT);
  assert.equal(inspect.rowCount, 11);
  assert.ok(inspect.redactedSample[0].email.includes('***'), 'Expected PII email to be redacted in MCP preview');

  const run = await handleToolCall('run_workflow', {
    workflowPath: 'examples/01-messy-customers-cleanup/workflow.json',
    inputPath: 'examples/01-messy-customers-cleanup/sample-input.csv'
  }, ROOT);
  assert.equal(run.outputRowCount, 9);

  const fetched = await handleToolCall('get_run_report', { runId: run.runId }, ROOT);
  assert.equal(fetched.runId, run.runId);
});
