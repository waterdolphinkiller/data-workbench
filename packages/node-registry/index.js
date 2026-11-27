/**
 * @module @data-workbench/node-registry
 * v2.1 Dynamic Plugin SDK + 28 deterministic, versioned workflow nodes.
 * Features:
 *  - Named typed inputPorts / outputPorts (including `errors` / `rejected` split ports)
 *  - Dynamic registerNode() / unregisterNode() plugin API
 *  - Strict paramSchema validation + automatic migrate(params, fromVersion) hooks
 *  - Columnar-native Copy-on-Write execution on hot-path nodes via DataHandle & ExecutionAdapter
 */

import {
  DataHandle,
  ColumnarTable,
  buildColumnVector,
  filterColumnar,
  deduplicateColumnar,
  sortColumnar
} from '../engine-core/index.js';
import { parseCsvToColumnar, serializeCsv, detectCsvDialect } from '../csv-engine/index.js';
import { parseXlsx, serializeXlsx, inspectParquetHeader } from '../xlsx-engine/index.js';
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
} from '../json-engine/index.js';
import { profileDataset, maskPiiValue, isNullish, detectTextClusters } from '../quality-engine/index.js';
import { diffTables, diffJson } from '../diff-engine/index.js';
import { validateDataContract, validateAgainstSchema, generateJsonSchema } from '../workflow-schema/index.js';

function cloneRowDataset(ds) {
  const handle = DataHandle.fromAny(ds);
  return {
    columns: [...handle.columns],
    rows: handle.rows.map(r => ({ ...r })),
    badRows: handle.badRows ? handle.badRows.map(b => ({ ...b })) : [],
    meta: handle.meta ? { ...handle.meta } : {}
  };
}

function normalizeDateString(raw, sourceOrder = 'MDY', targetFormat = 'ISO-8601') {
  if (isNullish(raw)) return { ok: true, value: null };
  const s = String(raw).trim();
  let y, m, d;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/);
  const slash = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);

  if (iso) {
    y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]);
  } else if (slash) {
    const p1 = Number(slash[1]); const p2 = Number(slash[2]); y = Number(slash[3]);
    if (p1 > 12 && p2 <= 12) { d = p1; m = p2; }
    else if (p2 > 12 && p1 <= 12) { m = p1; d = p2; }
    else if (sourceOrder === 'DMY') { d = p1; m = p2; }
    else { m = p1; d = p2; }
  } else {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return { ok: false, value: raw };
    y = parsed.getUTCFullYear(); m = parsed.getUTCMonth() + 1; d = parsed.getUTCDate();
  }

  if (m < 1 || m > 12 || d < 1 || d > 31) return { ok: false, value: raw };
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const yyyy = String(y).padStart(4, '0');
  if (targetFormat === 'MM/DD/YYYY') return { ok: true, value: `${mm}/${dd}/${yyyy}` };
  if (targetFormat === 'DD/MM/YYYY') return { ok: true, value: `${dd}/${mm}/${yyyy}` };
  return { ok: true, value: `${yyyy}-${mm}-${dd}` };
}

function executeSqlLite(dataset, sql) {
  const handle = DataHandle.fromAny(dataset);
  const query = String(sql || '').trim().replace(/;$/, '');
  const match = query.match(
    /^SELECT\s+(.+?)\s+FROM\s+\w+(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+([a-zA-Z0-9_]+))?(?:\s+ORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?$/i
  );
  if (!match) {
    throw new Error('SQL syntax error. Supported pattern: SELECT <cols> FROM data [WHERE ...] [GROUP BY col] [ORDER BY col ASC|DESC] [LIMIT n]');
  }
  const [, selectPart, wherePart, groupByCol, orderByCol, orderDir, limitStr] = match;
  let rows = handle.rows.map(r => ({ ...r }));

  if (wherePart) {
    const conds = wherePart.split(/\s+AND\s+/i);
    for (const cond of conds) {
      const cm = cond.trim().match(/^([a-zA-Z0-9_]+)\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(.+)$/i);
      if (!cm) throw new Error(`Unsupported WHERE clause: "${cond}"`);
      const [, col, op, rawVal] = cm;
      const val = rawVal.trim().replace(/^['"]|['"]$/g, '');
      const numVal = Number(val);
      rows = rows.filter(r => {
        const cell = r[col];
        if (op.toUpperCase() === 'LIKE') {
          const re = new RegExp('^' + val.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          return re.test(String(cell ?? ''));
        }
        if (op === '=') return String(cell ?? '') === val;
        if (op === '!=' || op === '<>') return String(cell ?? '') !== val;
        const cNum = Number(cell);
        if (Number.isNaN(cNum) || Number.isNaN(numVal)) return false;
        if (op === '>') return cNum > numVal;
        if (op === '<') return cNum < numVal;
        if (op === '>=') return cNum >= numVal;
        if (op === '<=') return cNum <= numVal;
        return false;
      });
    }
  }

  let outCols = [];
  let outRows = [];

  if (groupByCol) {
    const groups = new Map();
    for (const r of rows) {
      const k = String(r[groupByCol] ?? '');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const selectItems = selectPart.split(',').map(s => s.trim());
    for (const [gKey, gRows] of groups.entries()) {
      const out = {};
      for (const item of selectItems) {
        const agg = item.match(/^(COUNT|SUM|AVG|MIN|MAX)\(([^)]+)\)(?:\s+AS\s+([a-zA-Z0-9_]+))?$/i);
        if (agg) {
          const fn = agg[1].toUpperCase();
          const targetCol = agg[2].trim();
          const alias = agg[3] || `${fn.toLowerCase()}_${targetCol === '*' ? 'rows' : targetCol}`;
          if (fn === 'COUNT') {
            out[alias] = targetCol === '*' ? gRows.length : gRows.filter(r => !isNullish(r[targetCol])).length;
          } else {
            const nums = gRows.map(r => Number(r[targetCol])).filter(n => !Number.isNaN(n));
            if (fn === 'SUM') out[alias] = Number(nums.reduce((a, b) => a + b, 0).toFixed(4));
            if (fn === 'AVG') out[alias] = nums.length ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(4)) : null;
            if (fn === 'MIN') out[alias] = nums.length ? Math.min(...nums) : null;
            if (fn === 'MAX') out[alias] = nums.length ? Math.max(...nums) : null;
          }
        } else {
          const colAlias = item.split(/\s+AS\s+/i);
          const colName = colAlias[0].trim();
          const alias = (colAlias[1] || colName).trim();
          out[alias] = colName === groupByCol ? gKey : gRows[0][colName];
        }
      }
      outRows.push(out);
    }
    outCols = outRows[0] ? Object.keys(outRows[0]) : [groupByCol];
  } else if (selectPart.trim() === '*') {
    outCols = [...handle.columns];
    outRows = rows;
  } else {
    const specs = selectPart.split(',').map(item => {
      const parts = item.trim().split(/\s+AS\s+/i);
      return { src: parts[0].trim(), alias: (parts[1] || parts[0]).trim() };
    });
    outCols = specs.map(s => s.alias);
    outRows = rows.map(r => {
      const o = {};
      for (const s of specs) o[s.alias] = r[s.src] ?? null;
      return o;
    });
  }

  if (orderByCol) {
    const dir = (orderDir || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
    outRows.sort((a, b) => {
      const va = a[orderByCol]; const vb = b[orderByCol];
      const na = Number(va); const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') return (na - nb) * dir;
      return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
    });
  }
  if (limitStr) outRows = outRows.slice(0, Number(limitStr));
  return new DataHandle({ kind: 'rows', columns: outCols, rows: outRows, meta: { sql: query } });
}

const DEFAULT_IN = [{ name: 'in', type: 'table', required: true }];
const DEFAULT_OUT = [{ name: 'out', type: 'table' }];

export const NODE_DEFINITIONS = {
  // === SOURCES ===
  'source.csv': {
    type: 'source.csv',
    category: 'Sources',
    label: 'CSV Input',
    version: '2.1.0',
    inputPorts: [],
    outputPorts: [{ name: 'out', type: 'table' }],
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Parse CSV directly into ColumnarTable with dialect, encoding, and bad-row detection.',
    defaultParams: { delimiter: 'auto', header: true, quote: '"', formulaGuard: true },
    paramSchema: {
      type: 'object',
      properties: {
        delimiter: { type: 'string' },
        header: { type: 'boolean' },
        quote: { type: 'string' },
        formulaGuard: { type: 'boolean' }
      }
    },
    execute(inputs, params, ctx) {
      const raw = params.data ?? inputs[0]?.raw ?? inputs[0];
      if (raw && (raw.isDataHandle || raw instanceof ColumnarTable || Array.isArray(raw.rows))) {
        const h = DataHandle.fromAny(raw);
        return { output: [h], outputsByPort: { out: h }, warnings: [], errors: [], metrics: [{ name: 'rows', value: h.rowCount }, { name: 'bytes', value: h.estimateBytes() }] };
      }
      const handle = parseCsvToColumnar(raw ?? '', params);
      ctx.emitMetric({ name: 'rows', value: handle.rowCount });
      return {
        output: [handle],
        outputsByPort: { out: handle },
        warnings: (handle.meta.warnings || []).map(w => ({ message: w })),
        errors: [],
        metrics: [
          { name: 'rows', value: handle.rowCount },
          { name: 'columns', value: handle.columns.length },
          { name: 'bytes', value: handle.estimateBytes() }
        ]
      };
    }
  },
  'source.json': {
    type: 'source.json',
    category: 'Sources',
    label: 'JSON Input',
    version: '2.1.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Parse and validate JSON and convert to tabular records or raw JSON tree.',
    defaultParams: { flatten: true, separator: '.', asTabular: true },
    execute(inputs, params) {
      const raw = params.data ?? inputs[0];
      let data = raw;
      if (typeof raw === 'string') {
        const v = validateJson(raw);
        if (!v.valid) return { output: [], warnings: [], errors: [{ message: `JSON error at L${v.line}:C${v.column}: ${v.error}` }], metrics: [] };
        data = v.data;
      }
      const out = params.asTabular !== false ? DataHandle.fromAny(jsonToTabular(data, params)) : new DataHandle({ kind: 'json', rawJson: data, columns: [], rows: [] });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'source.ndjson': {
    type: 'source.ndjson',
    category: 'Sources',
    label: 'NDJSON Input',
    version: '2.1.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Parse Newline-Delimited JSON into tabular rows with per-line error reporting.',
    defaultParams: { flatten: true },
    execute(inputs, params) {
      const raw = params.data ?? inputs[0] ?? '';
      const { rows, errors } = parseNdjson(raw);
      const out = DataHandle.fromAny(jsonToTabular(rows, params));
      return { output: [out], outputsByPort: { out }, warnings: errors.map(e => ({ message: `Line ${e.lineNumber}: ${e.error}` })), errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'source.yaml': {
    type: 'source.yaml',
    category: 'Sources',
    label: 'YAML Input',
    version: '2.1.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Parse YAML documents into structured records.',
    defaultParams: { flatten: true },
    execute(inputs, params) {
      const raw = params.data ?? inputs[0] ?? '';
      const parsed = typeof raw === 'string' ? parseYaml(raw) : raw;
      const out = DataHandle.fromAny(jsonToTabular(parsed, params));
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'source.xml': {
    type: 'source.xml',
    category: 'Sources',
    label: 'XML Input',
    version: '2.1.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Parse XML elements and attributes into structured records.',
    defaultParams: { flatten: true },
    execute(inputs, params) {
      const raw = params.data ?? inputs[0] ?? '';
      const parsed = typeof raw === 'string' ? parseXml(raw) : raw;
      const out = DataHandle.fromAny(jsonToTabular(parsed, params));
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },

  'source.xlsx': {
    type: 'source.xlsx',
    category: 'Sources',
    label: 'Excel (.xlsx) Input',
    version: '2.3.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Zero-dependency Microsoft Excel (.xlsx) reader supporting sharedStrings, inlineStr, numbers & booleans.',
    defaultParams: { header: true },
    async execute(inputs, params) {
      const raw = params.data ?? inputs[0];
      const parsed = await parseXlsx(raw, params);
      const out = DataHandle.fromAny(parsed);
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'source.parquet': {
    type: 'source.parquet',
    category: 'Sources',
    label: 'Parquet Input (DuckDB Adapter)',
    version: '2.3.0',
    inputPorts: [],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Inspect Apache Parquet header and delegate reading to DuckDbWasmAdapter when bound.',
    defaultParams: {},
    async execute(inputs, params, ctx) {
      const raw = params.data ?? inputs[0];
      const info = inspectParquetHeader(raw || new Uint8Array());
      if (!info.validParquetMagic) {
        return { output: [], warnings: [], errors: [{ message: 'Invalid Parquet file: missing PAR1 magic header.' }], metrics: [] };
      }
      if (ctx?.adapter?.name === 'duckdb-wasm' && ctx.adapter.available() && typeof ctx.adapter.readParquet === 'function') {
        const out = DataHandle.fromAny(await ctx.adapter.readParquet(raw));
        return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
      }
      return {
        output: [],
        warnings: [],
        errors: [{ message: 'Valid Parquet file detected. Bind DuckDbWasmAdapter.bind(db) to query Parquet files natively.' }],
        metrics: []
      };
    }
  },

  // === CLEAN ===
  'clean.csvDetectFix': {
    type: 'clean.csvDetectFix',
    category: 'Clean',
    label: 'CSV Detect & Repair',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: [{ name: 'out', type: 'table' }, { name: 'errors', type: 'table' }],
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Inspect CSV dialect and drop or pad misaligned rows (routes dropped rows to `errors` port).',
    defaultParams: { misalignedPolicy: 'pad' },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const table = h.asColumnar();
      const warnings = [];
      let outTable = table;
      let errTable = table.takeRows([]);
      if (params.misalignedPolicy === 'drop' && table.badRows?.length) {
        const badSet = new Set(table.badRows.map(b => b.rowIndex));
        const keptIdx = [];
        const errIdx = [];
        for (let i = 0; i < table.rowCount; i++) {
          if (badSet.has(i)) errIdx.push(i);
          else keptIdx.push(i);
        }
        outTable = table.takeRows(keptIdx);
        errTable = table.takeRows(errIdx);
        warnings.push({ message: `Dropped ${badSet.size} misaligned row(s) to "errors" port.` });
      }
      const out = new DataHandle({ kind: 'columnar', columnar: outTable });
      const errorsPort = new DataHandle({ kind: 'columnar', columnar: errTable });
      return { output: [out], outputsByPort: { out, errors: errorsPort }, warnings, errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'clean.text': {
    type: 'clean.text',
    category: 'Clean',
    label: 'Clean Text / Case',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Copy-on-Write column text cleaning (trim, lower/upper/title case, collapse spaces, normalize nulls).',
    defaultParams: { columns: [], trim: true, case: 'none', collapseSpaces: false, normalizeNulls: false },
    execute(inputs, params) {
      let table = DataHandle.fromAny(inputs[0]).asColumnar().compact();
      const targetCols = params.columns?.length ? params.columns : table.columns;
      let changedCells = 0;

      for (const col of targetCols) {
        const vec = table.getColumn(col);
        if (!vec) continue;
        const n = table.rowCount;
        const nextArr = new Array(n);
        let colMutated = false;
        for (let i = 0; i < n; i++) {
          const before = vec.get(i);
          if (params.normalizeNulls && isNullish(before)) {
            nextArr[i] = null;
            if (before !== null) { changedCells++; colMutated = true; }
            continue;
          }
          if (before === null || before === undefined) { nextArr[i] = null; continue; }
          let val = String(before);
          if (params.trim) val = val.trim();
          if (params.collapseSpaces) val = val.replace(/\s+/g, ' ');
          if (params.case === 'lower') val = val.toLowerCase();
          else if (params.case === 'upper') val = val.toUpperCase();
          else if (params.case === 'title') val = val.replace(/\b\w/g, ch => ch.toUpperCase());
          nextArr[i] = val;
          if (val !== before) { changedCells++; colMutated = true; }
        }
        // Copy-on-Write: only rebuild the mutated column vector; untouched columns stay zero-copy!
        if (colMutated) {
          table = table.withColumn(col, buildColumnVector(nextArr));
        }
      }
      const out = new DataHandle({ kind: 'columnar', columnar: table });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }, { name: 'changedCells', value: changedCells }] };
    }
  },
  'clean.dateNormalize': {
    type: 'clean.dateNormalize',
    category: 'Clean',
    label: 'Normalize Dates',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: [{ name: 'out', type: 'table' }, { name: 'errors', type: 'table' }],
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Standardize dates to ISO-8601 (or target format) and route invalid rows to `errors` port.',
    defaultParams: { column: '', sourceOrder: 'MDY', targetFormat: 'ISO-8601', invalidPolicy: 'keep' },
    execute(inputs, params) {
      let table = DataHandle.fromAny(inputs[0]).asColumnar().compact();
      const col = params.column;
      if (!col || !table.columns.includes(col)) {
        const out = new DataHandle({ kind: 'columnar', columnar: table });
        return { output: [out], outputsByPort: { out, errors: new DataHandle({ kind: 'columnar', columnar: table.takeRows([]) }) }, warnings: [{ message: `Column "${col}" not found for date normalization.` }], errors: [], metrics: [] };
      }
      const vec = table.getColumn(col);
      const n = table.rowCount;
      const nextCol = new Array(n);
      const keptIdx = [];
      const errIdx = [];

      for (let i = 0; i < n; i++) {
        const raw = vec.get(i);
        const res = normalizeDateString(raw, params.sourceOrder, params.targetFormat);
        if (res.ok) {
          nextCol[i] = res.value;
          keptIdx.push(i);
        } else {
          errIdx.push(i);
          if (params.invalidPolicy === 'drop') {
            nextCol[i] = raw;
            continue;
          }
          nextCol[i] = params.invalidPolicy === 'null' ? null : raw;
          keptIdx.push(i);
        }
      }

      const errTable = table.takeRows(errIdx);
      table = table.withColumn(col, buildColumnVector(nextCol));
      const outTable = params.invalidPolicy === 'drop' ? table.takeRows(keptIdx) : table;
      const out = new DataHandle({ kind: 'columnar', columnar: outTable });
      const errorsPort = new DataHandle({ kind: 'columnar', columnar: errTable });
      const warnings = errIdx.length > 0 ? [{ message: `${errIdx.length} unparseable date value(s) in "${col}" (policy: ${params.invalidPolicy}).` }] : [];
      return { output: [out], outputsByPort: { out, errors: errorsPort }, warnings, errors: [], metrics: [{ name: 'rows', value: out.rowCount }, { name: 'invalidDates', value: errIdx.length }] };
    }
  },
  'clean.piiMask': {
    type: 'clean.piiMask',
    category: 'Clean',
    label: 'PII Sentinel Mask',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Mask, hash, remove, synthetic-replace, or keep-last-N characters on sensitive columns locally.',
    defaultParams: { columns: [], strategy: 'mask', keepLast: 4 },
    execute(inputs, params) {
      let table = DataHandle.fromAny(inputs[0]).asColumnar().compact();
      const cols = params.columns || [];
      let masked = 0;
      for (const col of cols) {
        const vec = table.getColumn(col);
        if (!vec) continue;
        const n = table.rowCount;
        const nextArr = new Array(n);
        for (let i = 0; i < n; i++) {
          const v = vec.get(i);
          if (!isNullish(v)) {
            nextArr[i] = maskPiiValue(v, params.strategy, { keepLast: params.keepLast });
            masked++;
          } else {
            nextArr[i] = null;
          }
        }
        table = table.withColumn(col, buildColumnVector(nextArr));
      }
      const out = new DataHandle({ kind: 'columnar', columnar: table });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }, { name: 'maskedCells', value: masked }] };
    }
  },
  'clean.fillNulls': {
    type: 'clean.fillNulls',
    category: 'Clean',
    label: 'Fill Null Values',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Replace null/missing values with a constant, forward-fill, or column mean.',
    defaultParams: { column: '', strategy: 'constant', value: '' },
    execute(inputs, params) {
      let table = DataHandle.fromAny(inputs[0]).asColumnar().compact();
      const col = params.column;
      const vec = table.getColumn(col);
      if (!vec) {
        const out = new DataHandle({ kind: 'columnar', columnar: table });
        return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [] };
      }
      const n = table.rowCount;
      let meanVal = 0;
      if (params.strategy === 'mean') {
        let sum = 0; let cnt = 0;
        for (let i = 0; i < n; i++) {
          const num = Number(vec.get(i));
          if (!Number.isNaN(num) && !isNullish(vec.get(i))) { sum += num; cnt++; }
        }
        meanVal = cnt ? Number((sum / cnt).toFixed(4)) : 0;
      }
      const nextArr = new Array(n);
      let lastNonNull = null;
      let filled = 0;
      for (let i = 0; i < n; i++) {
        const v = vec.get(i);
        if (isNullish(v)) {
          nextArr[i] = params.strategy === 'forward' ? lastNonNull : (params.strategy === 'mean' ? meanVal : (params.value ?? ''));
          filled++;
        } else {
          nextArr[i] = v;
          lastNonNull = v;
        }
      }
      table = table.withColumn(col, buildColumnVector(nextArr));
      const out = new DataHandle({ kind: 'columnar', columnar: table });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'filledCells', value: filled }] };
    }
  },

  'clean.clusterMerge': {
    type: 'clean.clusterMerge',
    category: 'Clean',
    label: 'Fuzzy Cluster Merge',
    version: '2.2.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'OpenRefine-style fuzzy text clustering (Fingerprint + Levenshtein) to merge near-duplicate category values.',
    defaultParams: { column: '', method: 'both', maxDistance: 2, explicitMapping: {} },
    execute(inputs, params) {
      let table = DataHandle.fromAny(inputs[0]).asColumnar().compact();
      const col = params.column;
      const vec = table.getColumn(col);
      if (!vec) {
        const out = new DataHandle({ kind: 'columnar', columnar: table });
        return { output: [out], outputsByPort: { out }, warnings: [{ message: `Column "${col}" not found for clusterMerge.` }], errors: [], metrics: [] };
      }
      const handle = new DataHandle({ kind: 'columnar', columnar: table });
      const clusters = detectTextClusters(handle, col, { method: params.method || 'both', maxDistance: params.maxDistance ?? 2 });
      const mergeMap = new Map(Object.entries(params.explicitMapping || {}));
      for (const cl of clusters) {
        for (const v of cl.variants) {
          if (!mergeMap.has(v.value)) mergeMap.set(v.value, cl.canonical);
        }
      }
      const n = table.rowCount;
      const nextArr = new Array(n);
      let mergedCells = 0;
      for (let i = 0; i < n; i++) {
        const raw = vec.get(i);
        if (raw !== null && raw !== undefined && mergeMap.has(String(raw))) {
          const target = mergeMap.get(String(raw));
          nextArr[i] = target;
          if (target !== String(raw)) mergedCells++;
        } else {
          nextArr[i] = raw;
        }
      }
      if (mergedCells > 0) {
        table = table.withColumn(col, buildColumnVector(nextArr));
      }
      const out = new DataHandle({ kind: 'columnar', columnar: table, meta: { ...table.meta, detectedClusters: clusters } });
      return {
        output: [out],
        outputsByPort: { out },
        warnings: [],
        errors: [],
        metrics: [{ name: 'clusters', value: clusters.length }, { name: 'mergedCells', value: mergedCells }]
      };
    }
  },

  // === TRANSFORM ===
  'transform.deduplicate': {
    type: 'transform.deduplicate',
    category: 'Transform',
    label: 'Remove Duplicates',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: [{ name: 'out', type: 'table' }, { name: 'errors', type: 'table' }],
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Vectorized columnar deduplication by key columns; routes removed duplicates to `errors` port.',
    defaultParams: { keys: [], keep: 'first', caseSensitive: true, nullKeyPolicy: 'keep' },
    migrate(params, fromVersion) {
      // Example migration hook: v1.0.0 used `key` (string); v2.1.0 uses `keys` (string[])
      if (fromVersion && fromVersion.startsWith('1.') && typeof params.key === 'string' && !params.keys) {
        const { key, ...rest } = params;
        return { ...rest, keys: [key] };
      }
      return params;
    },
    execute(inputs, params, ctx) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar();
      const needErrors = Boolean(ctx?.connectedOutputPorts?.has('errors'));
      const { kept, duplicates, removedCount } = deduplicateColumnar(table, params.keys, params.keep === 'last' ? 'last' : 'first', params.caseSensitive !== false, { includeDuplicates: needErrors });
      const out = new DataHandle({ kind: 'columnar', columnar: kept });
      const dupHandle = duplicates ? new DataHandle({ kind: 'columnar', columnar: duplicates }) : null;
      return {
        output: [out],
        outputsByPort: { out, errors: dupHandle },
        warnings: [],
        errors: [],
        metrics: [{ name: 'rows', value: out.rowCount }, { name: 'removedRows', value: removedCount }]
      };
    }
  },
  'transform.filter': {
    type: 'transform.filter',
    category: 'Transform',
    label: 'Filter Rows',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: [{ name: 'out', type: 'table' }, { name: 'errors', type: 'table' }],
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Vectorized columnar filter; routes non-matching rows to `errors` (rejected) port.',
    defaultParams: { column: '', operator: 'notNull', value: '' },
    execute(inputs, params, ctx) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar();
      const needErrors = Boolean(ctx?.connectedOutputPorts?.has('errors'));
      const { kept, rejected } = filterColumnar(table, params.column, params.operator, params.value, { includeRejected: needErrors });
      const out = new DataHandle({ kind: 'columnar', columnar: kept });
      const rej = rejected ? new DataHandle({ kind: 'columnar', columnar: rejected }) : null;
      return {
        output: [out],
        outputsByPort: { out, errors: rej },
        warnings: [],
        errors: [],
        metrics: [{ name: 'rows', value: out.rowCount }, { name: 'filteredOut', value: table.rowCount - kept.rowCount }]
      };
    }
  },
  'transform.sort': {
    type: 'transform.sort',
    category: 'Transform',
    label: 'Sort Rows',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Vectorized columnar sort ascending or descending by a column.',
    defaultParams: { column: '', direction: 'asc', numeric: 'auto' },
    execute(inputs, params) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar();
      const sorted = sortColumnar(table, params.column, params.direction === 'desc' ? 'desc' : 'asc');
      const out = new DataHandle({ kind: 'columnar', columnar: sorted });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'transform.renameColumns': {
    type: 'transform.renameColumns',
    category: 'Transform',
    label: 'Rename Columns',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Zero-copy columnar rename via explicit mapping.',
    defaultParams: { mapping: {} },
    execute(inputs, params) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar().renameColumns(params.mapping || {});
      const out = new DataHandle({ kind: 'columnar', columnar: table });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'columns', value: out.columns.length }] };
    }
  },
  'transform.selectColumns': {
    type: 'transform.selectColumns',
    category: 'Transform',
    label: 'Select / Drop Columns',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: false },
    description: 'Zero-copy columnar projection to keep or exclude columns.',
    defaultParams: { include: [], exclude: [] },
    execute(inputs, params) {
      const table = DataHandle.fromAny(inputs[0]).asColumnar();
      let cols = [...table.columns];
      if (params.include?.length) cols = params.include.filter(c => table.columns.includes(c));
      if (params.exclude?.length) {
        const ex = new Set(params.exclude);
        cols = cols.filter(c => !ex.has(c));
      }
      const projected = table.selectColumns(cols);
      const out = new DataHandle({ kind: 'columnar', columnar: projected });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'columns', value: out.columns.length }] };
    }
  },
  'transform.flatten': {
    type: 'transform.flatten',
    category: 'Transform',
    label: 'Flatten JSON',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Flatten nested JSON objects into dot-notation columns.',
    defaultParams: { separator: '.', flattenArrays: false },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const rows = h.rows.map(r => flattenObject(r, params));
      const colSet = new Set();
      rows.forEach(r => Object.keys(r).forEach(k => colSet.add(k)));
      const out = new DataHandle({ kind: 'rows', columns: Array.from(colSet), rows });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'columns', value: colSet.size }] };
    }
  },
  'transform.unflatten': {
    type: 'transform.unflatten',
    category: 'Transform',
    label: 'Unflatten JSON',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Reconstruct nested objects from dot-notation flat columns.',
    defaultParams: { separator: '.' },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const rows = h.rows.map(r => unflattenObject(r, params));
      const colSet = new Set();
      rows.forEach(r => Object.keys(r).forEach(k => colSet.add(k)));
      const out = new DataHandle({ kind: 'rows', columns: Array.from(colSet), rows });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: rows.length }] };
    }
  },
  'transform.jsonPath': {
    type: 'transform.jsonPath',
    category: 'Transform',
    label: 'JSONPath Query',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Query JSON data with RFC 9535 JSONPath expressions.',
    defaultParams: { expression: '$[*]' },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const target = h.rawJson !== undefined ? h.rawJson : h.rows;
      const res = queryJsonPath(target, params.expression || '$[*]');
      const tab = jsonToTabular(res.values);
      const out = new DataHandle({ kind: 'rows', columns: tab.columns, rows: tab.rows, meta: { jsonPathResult: res } });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'matches', value: res.values.length }] };
    }
  },
  'transform.sqlQuery': {
    type: 'transform.sqlQuery',
    category: 'Transform',
    label: 'SQL Query (Local / DuckDB)',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Run deterministic local SQL (automatically delegates to DuckDB-Wasm adapter when bound).',
    defaultParams: { sql: 'SELECT * FROM data LIMIT 100' },
    async execute(inputs, params, ctx) {
      const h = DataHandle.fromAny(inputs[0]);
      if (ctx?.adapter?.name === 'duckdb-wasm' && ctx.adapter.available()) {
        const out = DataHandle.fromAny(await ctx.adapter.querySql(h, params.sql));
        return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
      }
      const out = executeSqlLite(h, params.sql);
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: out.rowCount }] };
    }
  },
  'transform.merge': {
    type: 'transform.merge',
    category: 'Transform',
    label: 'Merge / Join Tables',
    version: '2.1.0',
    inputPorts: [{ name: 'left', type: 'table', required: true }, { name: 'right', type: 'table', required: false }],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Combine two tabular inputs vertically (union) or join by key via named `left` & `right` ports.',
    defaultParams: { mode: 'union', joinKey: '' },
    execute(inputs, params, ctx) {
      const left = cloneRowDataset(ctx?.inputsByPort?.left ?? inputs[0]);
      const rightRaw = ctx?.inputsByPort?.right ?? inputs[1];
      const right = rightRaw ? cloneRowDataset(rightRaw) : { columns: [], rows: [] };
      const allCols = Array.from(new Set([...left.columns, ...right.columns]));
      const mode = params.mode || 'union';
      if ((mode === 'join' || mode === 'left' || mode === 'inner' || mode === 'outer') && params.joinKey) {
        const key = params.joinKey;
        const rMap = new Map(right.rows.map(r => [String(r[key] ?? ''), r]));
        const matchedRightKeys = new Set();
        const joined = [];
        for (const lRow of left.rows) {
          const k = String(lRow[key] ?? '');
          const rMatch = rMap.get(k);
          if (rMatch) {
            matchedRightKeys.add(k);
            joined.push({ ...lRow, ...rMatch });
          } else if (mode !== 'inner') {
            const padded = { ...lRow };
            for (const c of allCols) if (!(c in padded)) padded[c] = null;
            joined.push(padded);
          }
        }
        if (mode === 'outer') {
          for (const rRow of right.rows) {
            const k = String(rRow[key] ?? '');
            if (!matchedRightKeys.has(k)) {
              const padded = { ...rRow };
              for (const c of allCols) if (!(c in padded)) padded[c] = null;
              joined.push(padded);
            }
          }
        }
        const out = new DataHandle({ kind: 'rows', columns: allCols, rows: joined });
        return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: joined.length }] };
      }
      const rows = [...left.rows, ...right.rows].map(r => {
        const o = {};
        for (const c of allCols) o[c] = r[c] ?? null;
        return o;
      });
      const out = new DataHandle({ kind: 'rows', columns: allCols, rows });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'rows', value: rows.length }] };
    }
  },

  // === VALIDATE ===
  'validate.qualityProfile': {
    type: 'validate.qualityProfile',
    category: 'Validate',
    label: 'Quality Radar Profile',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Compute completeness, uniqueness, validity, consistency, and PII findings.',
    defaultParams: {},
    execute(inputs) {
      const h = DataHandle.fromAny(inputs[0]);
      const profile = profileDataset(h);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, badRows: h.badRows, meta: { ...h.meta, qualityProfile: profile } });
      return { output: [out], outputsByPort: { out }, warnings: profile.issues.filter(i => i.severity === 'warning').map(i => ({ message: i.message })), errors: [], metrics: [{ name: 'issues', value: profile.summary.issueCount }] };
    }
  },
  'validate.dataContract': {
    type: 'validate.dataContract',
    category: 'Validate',
    label: 'Data Contract Gate',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Enforce required columns, types, primary key, row bounds, and null-rate limits.',
    defaultParams: { contract: {}, failOnError: false },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const result = validateDataContract(h, params.contract || {});
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, badRows: h.badRows, meta: { ...h.meta, contractResult: result } });
      const failed = result.checks.filter(c => !c.passed).map(c => ({ message: c.message }));
      return { output: [out], outputsByPort: { out }, warnings: params.failOnError ? [] : failed, errors: params.failOnError ? failed : [], metrics: [{ name: 'contractPassed', value: result.passed ? 1 : 0 }] };
    }
  },
  'validate.jsonSchema': {
    type: 'validate.jsonSchema',
    category: 'Validate',
    label: 'JSON Schema Validator',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Validate records against a JSON Schema 2020-12 definition (or auto-generate one).',
    defaultParams: { schema: null },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const schema = params.schema || generateJsonSchema(h.rows);
      const res = validateAgainstSchema(h.rows, schema);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, badRows: h.badRows, meta: { ...h.meta, schemaValidation: res, generatedSchema: schema } });
      return { output: [out], outputsByPort: { out }, warnings: res.errors.slice(0, 20).map(e => ({ message: `${e.path}: ${e.message}` })), errors: [], metrics: [{ name: 'schemaErrors', value: res.errors.length }] };
    }
  },

  // === COMPARE ===
  'compare.csvDiff': {
    type: 'compare.csvDiff',
    category: 'Compare',
    label: 'CSV Primary-Key Diff',
    version: '2.1.0',
    inputPorts: [{ name: 'left', type: 'table', required: true }, { name: 'right', type: 'table', required: true }],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Compare two tabular datasets via `left` & `right` ports by primary key, composite key, or row-hash.',
    defaultParams: { keys: [], trim: true, lowercase: false },
    execute(inputs, params, ctx) {
      const left = DataHandle.fromAny(ctx?.inputsByPort?.left ?? inputs[0]);
      const right = DataHandle.fromAny(ctx?.inputsByPort?.right ?? inputs[1] ?? inputs[0]);
      const diff = diffTables(left, right, {
        keys: params.keys,
        normalize: { trim: params.trim !== false, lowercase: Boolean(params.lowercase) }
      });
      const out = new DataHandle({ kind: right.kind, columnar: right._columnar, rows: right._rows, columns: right.columns, diffResult: diff });
      return {
        output: [out],
        outputsByPort: { out },
        warnings: diff.warning ? [{ message: diff.warning }] : [],
        errors: [],
        metrics: [{ name: 'added', value: diff.summary.added }, { name: 'removed', value: diff.summary.removed }, { name: 'changed', value: diff.summary.changed }]
      };
    }
  },
  'compare.jsonDiff': {
    type: 'compare.jsonDiff',
    category: 'Compare',
    label: 'JSON Diff',
    version: '2.1.0',
    inputPorts: [{ name: 'left', type: 'json', required: true }, { name: 'right', type: 'json', required: true }],
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    description: 'Path-level, value-level, and array diff between two JSON documents.',
    defaultParams: { ignorePaths: [], ignoreArrayOrder: false, numericTolerance: 0 },
    execute(inputs, params, ctx) {
      const l = DataHandle.fromAny(ctx?.inputsByPort?.left ?? inputs[0]);
      const r = DataHandle.fromAny(ctx?.inputsByPort?.right ?? inputs[1] ?? inputs[0]);
      const diff = diffJson(l.rawJson ?? l.rows, r.rawJson ?? r.rows, params);
      const out = new DataHandle({ kind: 'rows', columns: ['path', 'kind', 'before', 'after'], rows: diff.diffs, diffResult: diff });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'totalDiffs', value: diff.summary.totalDiffs }] };
    }
  },

  // === OUTPUT ===
  'output.csv': {
    type: 'output.csv',
    category: 'Output',
    label: 'CSV Output',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: true, network: false, filesystem: false, sideEffect: true },
    sideEffect: true,
    description: 'Direct columnar CSV export with configurable delimiter, line endings, and Formula Injection Guard.',
    defaultParams: { delimiter: ',', lineEnding: '\n', header: true, formulaGuard: true },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const serialized = serializeCsv(h, params);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, exportedText: serialized, exportedFormat: 'csv' });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'bytes', value: serialized.length }] };
    }
  },
  'output.json': {
    type: 'output.json',
    category: 'Output',
    label: 'JSON Output',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: true },
    sideEffect: true,
    description: 'Export clean JSON (pretty or minified, optional sorted keys).',
    defaultParams: { pretty: true, sortKeys: false },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const serialized = formatJson(h.rows, { minify: params.pretty === false, sortKeys: Boolean(params.sortKeys) });
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, exportedText: serialized, exportedFormat: 'json' });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'bytes', value: serialized.length }] };
    }
  },
  'output.ndjson': {
    type: 'output.ndjson',
    category: 'Output',
    label: 'NDJSON Output',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: true },
    sideEffect: true,
    description: 'Export Newline-Delimited JSON (one JSON record per line).',
    defaultParams: {},
    execute(inputs) {
      const h = DataHandle.fromAny(inputs[0]);
      const serialized = serializeNdjson(h.rows);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, exportedText: serialized, exportedFormat: 'ndjson' });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'bytes', value: serialized.length }] };
    }
  },
  'output.xlsx': {
    type: 'output.xlsx',
    category: 'Output',
    label: 'Excel (.xlsx) Output',
    version: '2.3.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: true },
    sideEffect: true,
    description: 'Export standards-compliant Microsoft Excel (.xlsx) workbook with Formula Injection Guard.',
    defaultParams: { sheetName: 'Data', formulaGuard: true },
    execute(inputs, params) {
      const h = DataHandle.fromAny(inputs[0]);
      const bytes = serializeXlsx(h, params);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, exportedFormat: 'xlsx' });
      out.exportedBytes = bytes;
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'bytes', value: bytes.length }] };
    }
  },
  'output.yaml': {
    type: 'output.yaml',
    category: 'Output',
    label: 'YAML Output',
    version: '2.1.0',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: true },
    sideEffect: true,
    description: 'Export clean block-style YAML.',
    defaultParams: {},
    execute(inputs) {
      const h = DataHandle.fromAny(inputs[0]);
      const serialized = serializeYaml(h.rows);
      const out = new DataHandle({ kind: h.kind, columnar: h._columnar, rows: h._rows, columns: h.columns, exportedText: serialized, exportedFormat: 'yaml' });
      return { output: [out], outputsByPort: { out }, warnings: [], errors: [], metrics: [{ name: 'bytes', value: serialized.length }] };
    }
  }
};

/**
 * Dynamic Plugin SDK Registry (v2.1).
 */
export function registerNode(def) {
  if (!def || !def.type || typeof def.execute !== 'function') {
    throw new Error('Plugin node definition must include string "type" and function "execute".');
  }
  NODE_DEFINITIONS[def.type] = {
    version: '1.0.0',
    category: 'Custom',
    label: def.type,
    description: '',
    inputPorts: DEFAULT_IN,
    outputPorts: DEFAULT_OUT,
    capabilities: { columnarNative: false, network: false, filesystem: false, sideEffect: false },
    defaultParams: {},
    ...def
  };
  return NODE_DEFINITIONS[def.type];
}

export function unregisterNode(type) {
  return delete NODE_DEFINITIONS[type];
}

export function validateNodeParams(def, params) {
  if (!def?.paramSchema) return { valid: true, errors: [] };
  return validateAgainstSchema(params || {}, def.paramSchema, `params(${def.type})`);
}

export function migrateNodeParams(def, params, fromVersion) {
  if (typeof def?.migrate === 'function') {
    return def.migrate(params || {}, fromVersion || '1.0.0');
  }
  return params || {};
}

export function listNodes() {
  return Object.values(NODE_DEFINITIONS).map(({ type, category, label, version, description, defaultParams, sideEffect, inputPorts, outputPorts, capabilities }) => ({
    type,
    category,
    label,
    version,
    description,
    defaultParams,
    inputPorts: inputPorts || DEFAULT_IN,
    outputPorts: outputPorts || DEFAULT_OUT,
    capabilities: capabilities || { columnarNative: false, network: false, filesystem: false, sideEffect: Boolean(sideEffect) },
    sideEffect: Boolean(sideEffect || capabilities?.sideEffect)
  }));
}

export function getNodeDefinition(type) {
  return NODE_DEFINITIONS[type] || null;
}

export { detectCsvDialect };
