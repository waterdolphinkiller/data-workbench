#!/usr/bin/env node
/**
 * Reproducible Performance & Memory Benchmark Suite (v2.0 Row-Objects vs v2.1 Columnar CoW)
 * Measures CSV-S (10k×12), CSV-M (100k×25), and CSV-M+ (250k×12).
 */

import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { parseCsv, parseCsvToColumnar, serializeCsv, serializeColumnarCsv } from '../packages/csv-engine/index.js';
import { filterColumnar, deduplicateColumnar } from '../packages/engine-core/index.js';
import { profileDataset } from '../packages/quality-engine/index.js';
import { generateBenchmarkCsv } from '../packages/test-fixtures/index.js';

function measure(fn) {
  const t0 = performance.now();
  const res = fn();
  return { ms: Number((performance.now() - t0).toFixed(1)), res };
}

console.log(`Data Workbench 2.1 Benchmark — Node ${process.version} on ${os.platform()} ${os.arch()} (${os.cpus().length} CPUs)\n`);

for (const spec of [
  { label: 'CSV-S (10k × 12)', rows: 10_000, cols: 12 },
  { label: 'CSV-M (100k × 25)', rows: 100_000, cols: 25 },
  { label: 'CSV-L-lite (250k × 12)', rows: 250_000, cols: 12 }
]) {
  const csv = generateBenchmarkCsv(spec.rows, spec.cols);
  const sizeMb = (Buffer.byteLength(csv, 'utf8') / (1024 * 1024)).toFixed(2);

  // v2.0 Row-Object baseline (for 10k and 100k)
  let v20Summary = '';
  if (spec.rows <= 100_000) {
    const imp20 = measure(() => parseCsv(csv));
    const flt20 = measure(() => imp20.res.rows.filter(r => r.status === 'active'));
    const exp20 = measure(() => serializeCsv({ columns: imp20.res.columns, rows: flt20.res }));
    v20Summary = `  [v2.0 Row-Objects] Import: ${imp20.ms}ms | Filter: ${flt20.ms}ms | Export: ${exp20.ms}ms`;
  }

  // v2.1 Columnar CoW Engine
  const imp21 = measure(() => parseCsvToColumnar(csv));
  const table = imp21.res.asColumnar();
  const flt21 = measure(() => filterColumnar(table, 'status', 'eq', 'active'));
  const ded21 = measure(() => deduplicateColumnar(table, ['id'], 'last'));
  const prof21 = measure(() => profileDataset(imp21.res));
  const exp21 = measure(() => serializeColumnarCsv(flt21.res.kept, { formulaGuard: true }));
  const estMb = (table.estimateBytes() / (1024 * 1024)).toFixed(2);
  const encodings = Object.values(table.getEncodingSummary());
  const numCols = encodings.filter(e => e === 'int' || e === 'float').length;
  const dictCols = encodings.filter(e => e === 'dict').length;

  console.log(`=== ${spec.label} (${sizeMb} MB CSV) ===`);
  if (v20Summary) console.log(v20Summary);
  console.log(`  [v2.1.1 Columnar]  Import: ${imp21.ms}ms | Filter: ${flt21.ms}ms | Dedupe: ${ded21.ms}ms | Profile: ${prof21.ms}ms | Export: ${exp21.ms}ms`);
  console.log(`  [v2.1 Storage]     Est. RAM: ${estMb} MB (${numCols} TypedArray cols, ${dictCols} Dictionary cols)\n`);
}
