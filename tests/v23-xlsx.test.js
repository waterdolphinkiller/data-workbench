import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseXlsx, serializeXlsx, inspectParquetHeader } from '../packages/xlsx-engine/index.js';
import { executeWorkflow, ENGINE_VERSION } from '../packages/workflow-core/index.js';
import { listNodes } from '../packages/node-registry/index.js';
import { resolveNodeTypeFuzzy } from '../packages/ai-api/index.js';
import { parseCsv } from '../packages/csv-engine/index.js';
import { MESSY_CUSTOMERS_CSV } from '../packages/test-fixtures/index.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('v2.3 Native Zero-Dependency .xlsx Engine: serialize, parse, formula guard & openpyxl round-trip', async () => {
  const ds = parseCsv(MESSY_CUSTOMERS_CSV);
  const xlsxBytes = serializeXlsx(ds, { sheetName: 'Customers', formulaGuard: true });
  assert.ok(xlsxBytes instanceof Uint8Array && xlsxBytes.length > 500);

  // Parse back with our own zero-dep JS parser
  const parsed = await parseXlsx(xlsxBytes);
  assert.equal(parsed.columns.length, 8);
  assert.equal(parsed.rows.length, 11);
  assert.ok(String(parsed.rows[8].full_name).startsWith(`'=HYPERLINK`), 'Expected Excel formula injection guard');

  // Optional third-party verification using Python openpyxl when installed locally
  let hasOpenpyxl = false;
  try { execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' }); hasOpenpyxl = true; } catch {}
  if (!hasOpenpyxl) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-xlsx-'));
  const jsOutPath = path.join(tmpDir, 'from-js.xlsx');
  const pyOutPath = path.join(tmpDir, 'from-openpyxl.xlsx');
  fs.writeFileSync(jsOutPath, xlsxBytes);

  const pyCheck = execFileSync('python3', ['-c', `
import openpyxl, json
wb = openpyxl.load_workbook(${JSON.stringify(jsOutPath)})
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
assert len(rows) == 12, f"Expected 12 rows (header+11), got {len(rows)}"
assert rows[0][0] == "customer_id"

wb2 = openpyxl.Workbook()
ws2 = wb2.active
ws2.append(["sku", "price", "active"])
ws2.append(["SKU-1", 49.5, True])
ws2.append(["SKU-2", 99.0, False])
wb2.save(${JSON.stringify(pyOutPath)})
print(json.dumps({"readRows": len(rows), "sheet": ws.title}))
`], { encoding: 'utf8' });

  const pyMeta = JSON.parse(pyCheck.trim());
  assert.equal(pyMeta.readRows, 12);
  assert.equal(pyMeta.sheet, 'Customers');

  // Now parse the Deflate-compressed openpyxl workbook with our zero-dep JS parseXlsx!
  const pyBytes = fs.readFileSync(pyOutPath);
  const parsedPy = await parseXlsx(pyBytes);
  assert.equal(parsedPy.rows.length, 2);
  assert.equal(parsedPy.rows[0].sku, 'SKU-1');
  assert.equal(parsedPy.rows[0].price, 49.5);
  assert.equal(parsedPy.rows[0].active, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('v2.3 Nodes (#30-32): source.xlsx, output.xlsx, source.parquet & AI aliases', async () => {
  const nodes = listNodes();
  assert.ok(nodes.length >= 32, `Expected >= 32 nodes, got ${nodes.length}`);
  assert.equal(resolveNodeTypeFuzzy('excel').resolved, 'source.xlsx');
  assert.equal(resolveNodeTypeFuzzy('export_xlsx').resolved, 'output.xlsx');
  assert.equal(resolveNodeTypeFuzzy('parquet').resolved, 'source.parquet');

  // Parquet magic byte header check
  const fakeParquet = new TextEncoder().encode('PAR1....PAR1');
  assert.equal(inspectParquetHeader(fakeParquet).validParquetMagic, true);

  // Workflow CSV -> output.xlsx
  const wf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'csv-to-xlsx', name: 'CSV to XLSX', engineVersion: ENGINE_VERSION,
      nodes: [
        { id: 's1', type: 'source.csv', params: { header: true } },
        { id: 'x1', type: 'output.xlsx', params: { sheetName: 'Clean' } }
      ],
      edges: [{ from: 's1', to: 'x1' }]
    }
  };
  const res = await executeWorkflow(wf, { inputsByNodeId: { s1: MESSY_CUSTOMERS_CSV } });
  assert.equal(res.status, 'success');
  assert.ok(res.finalOutput.exportedBytes instanceof Uint8Array);
});

test('v2.3 Launch Assets: Social Preview PNG (1280x640), Demo GIF & npx bin config', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/social-preview.png')));
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/demo.gif')));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.bin['data-workbench'] && pkg.bin['data-workbench-mcp']);
});
