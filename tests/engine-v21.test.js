import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ColumnarTable,
  DataHandle,
  DictionaryColumn,
  NumericColumn,
  DuckDbWasmAdapter,
  selectBestAdapter,
  OpfsStorageAdapter,
  buildColumnVector
} from '../packages/engine-core/index.js';
import { CsvStreamParser, parseCsvToColumnar, serializeColumnarCsv } from '../packages/csv-engine/index.js';
import { registerNode, unregisterNode } from '../packages/node-registry/index.js';
import { executeWorkflow, ENGINE_VERSION } from '../packages/workflow-core/index.js';
import { MESSY_CUSTOMERS_CSV, PRODUCT_CATALOG_V1_CSV, PRODUCT_CATALOG_V2_CSV } from '../packages/test-fixtures/index.js';

test('v2.1 ColumnarTable: TypedArray, Dictionary Encoding & Zero-Copy Copy-on-Write', () => {
  const handle = parseCsvToColumnar(MESSY_CUSTOMERS_CSV);
  const table = handle.asColumnar();

  assert.equal(table.rowCount, 11);
  assert.ok(table.getColumn('customer_id') instanceof NumericColumn, 'customer_id should use NumericColumn (Float64Array)');
  assert.ok(table.getColumn('plan') instanceof DictionaryColumn, 'plan should use DictionaryColumn');

  // Copy-on-Write: mutating one column must reuse exact reference for untouched columns!
  const beforePlanVec = table.getColumn('plan');
  const nextTable = table.withColumn('status', buildColumnVector(Array(11).fill('verified')));
  assert.strictEqual(nextTable.getColumn('plan'), beforePlanVec, 'Untouched column vector must be shared zero-copy');
  assert.notStrictEqual(nextTable.getColumn('status'), table.getColumn('status'));

  // Zero-copy rename & select
  const renamed = table.renameColumns({ plan: 'tier' });
  assert.strictEqual(renamed.getColumn('tier'), beforePlanVec);

  // Direct columnar CSV export with formula guard
  const csvOut = serializeColumnarCsv(table, { formulaGuard: true });
  assert.ok(csvOut.includes(`'=HYPERLINK`));
});

test('v2.1 CsvStreamParser: true incremental chunking across quotes, CRLF & UTF-8 bytes', () => {
  const parser = new CsvStreamParser({ delimiter: ',' });
  const enc = new TextEncoder();
  const fullBytes = enc.encode('id,name,note\r\n1,"Alice, Bob","中文测试"\r\n2,"Line1\nLine2",ok');

  // Feed 2 bytes at a time to intentionally split UTF-8 chars, quotes, and CRLF!
  const rows = [];
  for (let i = 0; i < fullBytes.length; i += 2) {
    rows.push(...parser.feed(fullBytes.subarray(i, i + 2)));
  }
  const flushed = parser.flush();
  rows.push(...flushed.rows);

  assert.equal(flushed.unclosedQuote, false);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['id', 'name', 'note']);
  assert.deepEqual(rows[1], ['1', 'Alice, Bob', '中文测试']);
  assert.deepEqual(rows[2], ['2', 'Line1\nLine2', 'ok']);
});

test('v2.1 Multi-Port DAG: named `out` vs `errors` branching and `left`/`right` diff ports', async () => {
  // 1. Date normalize splits invalid dates (`not-a-date`) to `errors` port
  const branchWf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'multiport-error-split',
      name: 'Multi-port Error Split',
      engineVersion: ENGINE_VERSION,
      nodes: [
        { id: 'src', type: 'source.csv', version: '2.1.0', params: { header: true } },
        { id: 'dates', type: 'clean.dateNormalize', version: '2.1.0', params: { column: 'signup_date', invalidPolicy: 'drop' } },
        { id: 'valid-out', type: 'output.json', version: '2.1.0', params: {} },
        { id: 'err-out', type: 'output.json', version: '2.1.0', params: {} }
      ],
      edges: [
        { from: 'src', fromPort: 'out', to: 'dates', toPort: 'in' },
        { from: 'dates', fromPort: 'out', to: 'valid-out', toPort: 'in' },
        { from: 'dates', fromPort: 'errors', to: 'err-out', toPort: 'in' }
      ]
    }
  };

  const res = await executeWorkflow(branchWf, { inputsByNodeId: { src: MESSY_CUSTOMERS_CSV } });
  assert.equal(res.nodeResults['valid-out'].rowCount, 10);
  assert.equal(res.nodeResults['err-out'].rowCount, 1, 'Expected 1 invalid date row routed to errors port');
  assert.equal(res.nodeResults['err-out'].output.rows[0].signup_date, 'not-a-date');

  // 2. Named `left` and `right` ports on compare.csvDiff
  const diffWf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'multiport-diff',
      name: 'Multi-port Catalog Diff',
      engineVersion: ENGINE_VERSION,
      nodes: [
        { id: 'v1', type: 'source.csv', version: '2.1.0', params: { header: true } },
        { id: 'v2', type: 'source.csv', version: '2.1.0', params: { header: true } },
        { id: 'cmp', type: 'compare.csvDiff', version: '2.1.0', params: { keys: ['sku'] } }
      ],
      edges: [
        { from: 'v1', fromPort: 'out', to: 'cmp', toPort: 'left' },
        { from: 'v2', fromPort: 'out', to: 'cmp', toPort: 'right' }
      ]
    }
  };
  const diffRes = await executeWorkflow(diffWf, {
    inputsByNodeId: { v1: PRODUCT_CATALOG_V1_CSV, v2: PRODUCT_CATALOG_V2_CSV }
  });
  assert.equal(diffRes.finalOutput.diffResult.summary.changed, 3);
  assert.equal(diffRes.finalOutput.diffResult.summary.added, 1);
  assert.equal(diffRes.finalOutput.diffResult.summary.removed, 1);
});

test('v2.1 Plugin SDK: registerNode, paramSchema validation & version migration hooks', async () => {
  registerNode({
    type: 'custom.addTag',
    category: 'Custom',
    label: 'Add Constant Tag',
    version: '2.0.0',
    paramSchema: {
      type: 'object',
      required: ['tag'],
      properties: { tag: { type: 'string' } }
    },
    execute(inputs, params) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar();
      const next = table.withColumn('_tag', buildColumnVector(Array(table.rowCount).fill(params.tag)));
      const out = new DataHandle({ kind: 'columnar', columnar: next });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [] };
    }
  });

  // Invalid params (missing required `tag`) should fail cleanly before execution
  const badWf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'bad-param', name: 'Bad Param',
      nodes: [
        { id: 'src', type: 'source.csv', params: {} },
        { id: 'tag', type: 'custom.addTag', params: { tag: 123 } }
      ],
      edges: [{ from: 'src', to: 'tag' }]
    }
  };
  const badRes = await executeWorkflow(badWf, { inputsByNodeId: { src: 'id\n1\n2' } });
  assert.equal(badRes.status, 'failed');
  assert.ok(badRes.errors[0].message.includes('Invalid param'));

  // Legacy v1.0.0 workflow using `key: "customer_id"` auto-migrates to `keys: ["customer_id"]`
  const legacyWf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'legacy-migrate', name: 'Legacy Migrate',
      nodes: [
        { id: 'src', type: 'source.csv', version: '1.0.0', params: {} },
        { id: 'dedupe', type: 'transform.deduplicate', version: '1.0.0', params: { key: 'customer_id', keep: 'last' } },
        { id: 'tag', type: 'custom.addTag', version: '2.0.0', params: { tag: 'clean-v21' } }
      ],
      edges: [{ from: 'src', to: 'dedupe' }, { from: 'dedupe', to: 'tag' }]
    }
  };
  const okRes = await executeWorkflow(legacyWf, { inputsByNodeId: { src: MESSY_CUSTOMERS_CSV } });
  assert.equal(okRes.finalOutput.rowCount, 9);
  assert.equal(okRes.finalOutput.rows[0]._tag, 'clean-v21');

  unregisterNode('custom.addTag');
});

test('v2.1 ExecutionAdapter: DuckDbWasmAdapter contract & automatic fallback + OPFS adapter', async () => {
  assert.equal(selectBestAdapter('auto').name, 'columnar-js');

  // Bind a mock DuckDB-Wasm instance and verify SQL delegation
  DuckDbWasmAdapter.bind({
    async query(sql, handle) {
      return { columns: ['mock_sql', 'rows'], rows: [{ mock_sql: sql, rows: handle.rowCount }] };
    }
  });
  assert.equal(selectBestAdapter('auto', 'sql').name, 'duckdb-wasm');

  const sqlWf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'duckdb-adapter-test', name: 'DuckDB Adapter Test',
      nodes: [
        { id: 'src', type: 'source.csv', params: {} },
        { id: 'sql', type: 'transform.sqlQuery', params: { sql: 'SELECT COUNT(*) FROM data' } }
      ],
      edges: [{ from: 'src', to: 'sql' }]
    }
  };
  const res = await executeWorkflow(sqlWf, { inputsByNodeId: { src: 'a\n1\n2\n3' } });
  assert.equal(res.adapter, 'duckdb-wasm');
  assert.equal(res.finalOutput.rows[0].rows, 3);
  DuckDbWasmAdapter.unbind();

  // OPFS storage fallback check
  const store = new OpfsStorageAdapter();
  await store.write('temp-batch', 'a,b\n1,2');
  assert.equal(await store.read('temp-batch'), 'a,b\n1,2');
  await store.clear('temp-batch');
  assert.equal(await store.read('temp-batch'), null);
});
