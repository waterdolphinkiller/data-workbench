import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { listXlsxSheets, parseXlsx } from '../packages/xlsx-engine/index.js';
import { executeWorkflow, ENGINE_VERSION } from '../packages/workflow-core/index.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('v2.4 Multi-Sheet Excel (.xlsx): listXlsxSheets & named sheet selection + CLI .xlsx I/O', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-v24-xlsx-'));
  const multiPath = path.join(ROOT, 'tests/fixtures/multi-sheet.xlsx');
  const outXlsxPath = path.join(tmpDir, 'cleaned.xlsx');
  const bytes = new Uint8Array(fs.readFileSync(multiPath));
  const sheets = await listXlsxSheets(bytes);
  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets.map(s => s.name), ['Summary', 'Orders']);

  const ordersDs = await parseXlsx(bytes, { sheetName: 'Orders' });
  assert.equal(ordersDs.rows.length, 3);
  assert.equal(ordersDs.rows[0].order_id, 'O-1');

  // CLI end-to-end: .xlsx input -> .xlsx output
  const cli = path.join(ROOT, 'apps/cli/bin/dw.js');
  const wfPath = path.join(ROOT, 'examples/05-yaml-export-pipeline/workflow.json');
  const sampleCsv = path.join(ROOT, 'examples/01-messy-customers-cleanup/sample-input.csv');
  execFileSync('node', [cli, 'run', wfPath, '--input', sampleCsv, '--output', outXlsxPath], { encoding: 'utf8' });
  assert.ok(fs.existsSync(outXlsxPath));
  const cliParsed = await parseXlsx(new Uint8Array(fs.readFileSync(outXlsxPath)));
  assert.equal(cliParsed.rows.length, 11);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('v2.4 Multi-Table Joins: inner, left, and outer joins via named left/right ports', async () => {
  const leftCsv = 'id,name\n1,Alice\n2,Bob\n3,Carol';
  const rightCsv = 'id,tier\n2,Pro\n3,Enterprise\n4,Starter';

  const runJoin = async (mode) => {
    const wf = {
      schemaVersion: '1.0',
      workflow: {
        id: `join-${mode}`, name: `Join ${mode}`, engineVersion: ENGINE_VERSION,
        nodes: [
          { id: 'l', type: 'source.csv', params: { header: true } },
          { id: 'r', type: 'source.csv', params: { header: true } },
          { id: 'm', type: 'transform.merge', params: { mode, joinKey: 'id' } }
        ],
        edges: [
          { from: 'l', fromPort: 'out', to: 'm', toPort: 'left' },
          { from: 'r', fromPort: 'out', to: 'm', toPort: 'right' }
        ]
      }
    };
    return executeWorkflow(wf, { inputsByNodeId: { l: leftCsv, r: rightCsv } });
  };

  const innerRes = await runJoin('inner');
  assert.equal(innerRes.finalOutput.rows.length, 2);

  const leftRes = await runJoin('left');
  assert.equal(leftRes.finalOutput.rows.length, 3);
  assert.equal(leftRes.finalOutput.rows[0].tier, null);

  const outerRes = await runJoin('outer');
  assert.equal(outerRes.finalOutput.rows.length, 4);
});
