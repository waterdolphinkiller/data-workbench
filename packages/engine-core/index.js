/**
 * @module @data-workbench/engine-core
 * Data Workbench 2.1.1 Core Execution Layer:
 *  - ColumnarTable with Selection Vector (zero-copy Filter/Dedupe/Sort views), TypedArrays,
 *    Null Validity Bitmaps, Dictionary Encoding, and Copy-on-Write column sharing
 *  - Vectorized Dictionary Predicate Pushdown (integer code comparison on DictionaryColumn)
 *  - DataHandle, ExecutionAdapter Registry (ColumnarJsAdapter + DuckDbWasmAdapter contract), OpfsStorageAdapter
 */

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(?:\d+\.\d+|\.\d+|\d+)$/;

export class DictionaryColumn {
  constructor(codes, dictionary, nullBitmap) {
    this.kind = 'dict';
    this.codes = codes; // Uint32Array
    this.dictionary = dictionary; // string[]
    this.nullBitmap = nullBitmap; // Uint8Array (1 = valid, 0 = null)
    this.length = codes.length;
  }

  get(i) {
    if (this.nullBitmap[i] === 0) return null;
    return this.dictionary[this.codes[i]];
  }

  sliceByIndices(indices) {
    const n = indices.length;
    const codes = new Uint32Array(n);
    const nulls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const src = indices[i];
      codes[i] = this.codes[src];
      nulls[i] = this.nullBitmap[src];
    }
    return new DictionaryColumn(codes, this.dictionary, nulls);
  }

  estimateBytes() {
    const dictBytes = this.dictionary.reduce((acc, s) => acc + s.length * 2 + 16, 0);
    return this.codes.byteLength + this.nullBitmap.byteLength + dictBytes;
  }
}

export class NumericColumn {
  constructor(values, nullBitmap, isInteger = false) {
    this.kind = isInteger ? 'int' : 'float';
    this.values = values; // Float64Array
    this.nullBitmap = nullBitmap; // Uint8Array (1 = valid, 0 = null)
    this.length = values.length;
  }

  get(i) {
    if (this.nullBitmap[i] === 0) return null;
    return this.values[i];
  }

  sliceByIndices(indices) {
    const n = indices.length;
    const vals = new Float64Array(n);
    const nulls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const src = indices[i];
      vals[i] = this.values[src];
      nulls[i] = this.nullBitmap[src];
    }
    return new NumericColumn(vals, nulls, this.kind === 'int');
  }

  estimateBytes() {
    return this.values.byteLength + this.nullBitmap.byteLength;
  }
}

export class GenericColumn {
  constructor(values) {
    this.kind = 'generic';
    this.values = values;
    this.length = values.length;
  }

  get(i) {
    return this.values[i];
  }

  sliceByIndices(indices) {
    const n = indices.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.values[indices[i]];
    return new GenericColumn(out);
  }

  estimateBytes() {
    let bytes = this.values.length * 8;
    const sample = Math.min(this.values.length, 500);
    if (sample > 0) {
      let avgStr = 0;
      for (let i = 0; i < sample; i++) {
        const v = this.values[i];
        if (typeof v === 'string') avgStr += v.length * 2 + 16;
      }
      bytes += (avgStr / sample) * this.values.length;
    }
    return Math.round(bytes);
  }
}

export function buildColumnVector(rawValues) {
  const n = rawValues.length;
  if (n === 0) return new GenericColumn([]);

  let probed = 0;
  let allNumeric = true;
  let allInt = true;
  const probeDistinct = new Set();

  for (let i = 0; i < n && probed < 256; i++) {
    const v = rawValues[i];
    if (v === null || v === undefined || v === '') continue;
    probed++;
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) allInt = false;
    } else if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') continue;
      if (probeDistinct.size < 64) probeDistinct.add(s);
      if (allNumeric) {
        if (!NUM_RE.test(s) || (s.length > 1 && s[0] === '0' && s[1] !== '.')) {
          allNumeric = false;
          allInt = false;
        } else if (allInt && !INT_RE.test(s)) {
          allInt = false;
        }
      }
    } else {
      allNumeric = false;
      allInt = false;
    }
  }

  if (probed > 0 && allNumeric) {
    const vals = new Float64Array(n);
    const nulls = new Uint8Array(n);
    let failed = false;
    for (let i = 0; i < n; i++) {
      const v = rawValues[i];
      if (v === null || v === undefined || v === '') {
        nulls[i] = 0;
        continue;
      }
      const num = typeof v === 'number' ? v : Number(String(v).trim());
      if (Number.isNaN(num)) {
        failed = true;
        break;
      }
      vals[i] = num;
      nulls[i] = 1;
    }
    if (!failed) return new NumericColumn(vals, nulls, allInt);
  }

  if (probed >= 8 && probeDistinct.size <= Math.max(32, probed * 0.35)) {
    const codes = new Uint32Array(n);
    const nulls = new Uint8Array(n);
    const dict = [];
    const dictMap = new Map();
    let overflow = false;
    const maxDict = Math.min(4096, Math.max(64, Math.floor(n * 0.25)));

    for (let i = 0; i < n; i++) {
      const v = rawValues[i];
      if (v === null || v === undefined || v === '') {
        nulls[i] = 0;
        continue;
      }
      const s = String(v);
      let code = dictMap.get(s);
      if (code === undefined) {
        if (dict.length >= maxDict) {
          overflow = true;
          break;
        }
        code = dict.length;
        dict.push(s);
        dictMap.set(s, code);
      }
      codes[i] = code;
      nulls[i] = 1;
    }
    if (!overflow) return new DictionaryColumn(codes, dict, nulls);
  }

  return new GenericColumn(rawValues);
}

/**
 * Copy-on-Write ColumnarTable with Selection Vector (zero-copy row filtering/sorting/deduplication).
 */
export class ColumnarTable {
  constructor(columns, vectors, rowCount, badRows = [], meta = {}, selection = null) {
    this.columns = [...columns];
    this.vectors = vectors;
    this.selection = selection; // Int32Array | null (maps logical row i -> physical index selection[i])
    this.rowCount = selection ? selection.length : rowCount;
    this.badRows = badRows;
    this.meta = meta;
  }

  static fromRows(columns, rows, badRows = [], meta = {}) {
    const n = rows.length;
    const cols = columns && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
    const vectors = new Map();
    for (const col of cols) {
      const raw = new Array(n);
      for (let i = 0; i < n; i++) raw[i] = rows[i][col] ?? null;
      vectors.set(col, buildColumnVector(raw));
    }
    return new ColumnarTable(cols, vectors, n, badRows, meta, null);
  }

  static fromColumnArrays(columns, colArrays, rowCount, badRows = [], meta = {}) {
    const vectors = new Map();
    for (let c = 0; c < columns.length; c++) {
      vectors.set(columns[c], buildColumnVector(colArrays[c]));
    }
    return new ColumnarTable(columns, vectors, rowCount, badRows, meta, null);
  }

  getColumn(name) {
    return this.vectors.get(name) || null;
  }

  physicalIndex(logicalRow) {
    return this.selection ? this.selection[logicalRow] : logicalRow;
  }

  getCell(rowIndex, colName) {
    const vec = this.vectors.get(colName);
    if (!vec) return null;
    return vec.get(this.selection ? this.selection[rowIndex] : rowIndex);
  }

  getRow(rowIndex) {
    const phys = this.selection ? this.selection[rowIndex] : rowIndex;
    const obj = {};
    for (const col of this.columns) {
      obj[col] = this.vectors.get(col).get(phys);
    }
    return obj;
  }

  /**
   * Compact a selection-indexed table into dense vectors only when a column mutation requires alignment.
   */
  compact() {
    if (!this.selection) return this;
    const nextVectors = new Map();
    for (const col of this.columns) {
      nextVectors.set(col, this.vectors.get(col).sliceByIndices(this.selection));
    }
    return new ColumnarTable(this.columns, nextVectors, this.selection.length, [], { ...this.meta }, null);
  }

  withColumn(name, newVector) {
    const base = this.selection ? this.compact() : this;
    const nextVectors = new Map(base.vectors);
    nextVectors.set(name, newVector);
    const nextCols = base.columns.includes(name) ? base.columns : [...base.columns, name];
    return new ColumnarTable(nextCols, nextVectors, base.rowCount, base.badRows, { ...base.meta }, null);
  }

  selectColumns(colNames) {
    const nextVectors = new Map();
    const validCols = [];
    for (const c of colNames) {
      if (this.vectors.has(c)) {
        nextVectors.set(c, this.vectors.get(c));
        validCols.push(c);
      }
    }
    return new ColumnarTable(validCols, nextVectors, this.rowCount, this.badRows, { ...this.meta }, this.selection);
  }

  renameColumns(mapping) {
    const nextCols = [];
    const nextVectors = new Map();
    for (const c of this.columns) {
      const target = mapping[c] || c;
      nextCols.push(target);
      nextVectors.set(target, this.vectors.get(c));
    }
    return new ColumnarTable(nextCols, nextVectors, this.rowCount, this.badRows, { ...this.meta }, this.selection);
  }

  /**
   * Zero-copy Selection Vector projection (O(K) Int32Array only — shares ALL column buffers!).
   */
  takeRows(indices) {
    const len = indices.length;
    const nextSel = new Int32Array(len);
    const curSel = this.selection;
    if (curSel) {
      for (let i = 0; i < len; i++) nextSel[i] = curSel[indices[i]];
    } else {
      for (let i = 0; i < len; i++) nextSel[i] = indices[i];
    }
    return new ColumnarTable(this.columns, this.vectors, len, [], { ...this.meta }, nextSel);
  }

  toRows(offset = 0, limit = this.rowCount) {
    const start = Math.max(0, offset);
    const end = Math.min(this.rowCount, start + limit);
    const out = new Array(Math.max(0, end - start));
    const cols = this.columns;
    const vecs = cols.map(c => this.vectors.get(c));
    const sel = this.selection;
    for (let i = start; i < end; i++) {
      const phys = sel ? sel[i] : i;
      const obj = {};
      for (let c = 0; c < cols.length; c++) {
        obj[cols[c]] = vecs[c].get(phys);
      }
      out[i - start] = obj;
    }
    return out;
  }

  estimateBytes() {
    let total = this.selection ? this.selection.byteLength : 0;
    for (const vec of this.vectors.values()) total += vec.estimateBytes();
    return total;
  }

  getEncodingSummary() {
    const out = {};
    for (const [k, v] of this.vectors.entries()) out[k] = v.kind;
    return out;
  }
}

/**
 * Vectorized columnar filter with Selection Vector + Dictionary/Numeric Predicate Pushdown
 * + Lazy `rejected` materialization (zero wasted copies when `errors` port is unconnected).
 */
export function filterColumnar(table, column, operator, value, options = {}) {
  const vec = table.getColumn(column);
  if (!vec) return { kept: table, rejected: table.takeRows([]) };
  const includeRejected = Boolean(options.includeRejected);
  const n = table.rowCount;
  const sel = table.selection;
  const keptIdx = [];
  const rejectedIdx = includeRejected ? [] : null;

  // Fast Path A: DictionaryColumn integer-code predicate pushdown for eq / neq!
  if (vec.kind === 'dict' && (operator === 'eq' || operator === 'neq')) {
    const targetCode = vec.dictionary.indexOf(String(value ?? ''));
    const codes = vec.codes;
    const nulls = vec.nullBitmap;
    const isEq = operator === 'eq';
    for (let i = 0; i < n; i++) {
      const p = sel ? sel[i] : i;
      const match = targetCode !== -1 && nulls[p] === 1 && codes[p] === targetCode;
      if (isEq ? match : !match) keptIdx.push(i);
      else if (rejectedIdx) rejectedIdx.push(i);
    }
    return {
      kept: table.takeRows(keptIdx),
      rejected: rejectedIdx ? table.takeRows(rejectedIdx) : null
    };
  }

  // Fast Path B: NumericColumn direct Float64Array comparison!
  if ((vec.kind === 'int' || vec.kind === 'float') && (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte' || operator === 'eq' || operator === 'neq')) {
    const numTarget = Number(value);
    const vals = vec.values;
    const nulls = vec.nullBitmap;
    for (let i = 0; i < n; i++) {
      const p = sel ? sel[i] : i;
      let pass = false;
      if (nulls[p] === 1) {
        const v = vals[p];
        if (operator === 'gt') pass = v > numTarget;
        else if (operator === 'gte') pass = v >= numTarget;
        else if (operator === 'lt') pass = v < numTarget;
        else if (operator === 'lte') pass = v <= numTarget;
        else if (operator === 'eq') pass = v === numTarget;
        else if (operator === 'neq') pass = v !== numTarget;
      } else if (operator === 'neq') {
        pass = true;
      }
      if (pass) keptIdx.push(i);
      else if (rejectedIdx) rejectedIdx.push(i);
    }
    return {
      kept: table.takeRows(keptIdx),
      rejected: rejectedIdx ? table.takeRows(rejectedIdx) : null
    };
  }

  // General Path
  const numTarget = Number(value);
  const strTarget = String(value ?? '');
  const strTargetLower = strTarget.toLowerCase();

  for (let i = 0; i < n; i++) {
    const p = sel ? sel[i] : i;
    const cell = vec.get(p);
    const isNull = cell === null || cell === undefined || cell === '';
    let pass = true;
    switch (operator) {
      case 'isNull': pass = isNull; break;
      case 'notNull': pass = !isNull; break;
      case 'eq': pass = !isNull && String(cell) === strTarget; break;
      case 'neq': pass = isNull || String(cell) !== strTarget; break;
      case 'contains': pass = !isNull && String(cell).toLowerCase().includes(strTargetLower); break;
      case 'startsWith': pass = !isNull && String(cell).toLowerCase().startsWith(strTargetLower); break;
      case 'endsWith': pass = !isNull && String(cell).toLowerCase().endsWith(strTargetLower); break;
      case 'gt': pass = !isNull && Number(cell) > numTarget; break;
      case 'gte': pass = !isNull && Number(cell) >= numTarget; break;
      case 'lt': pass = !isNull && Number(cell) < numTarget; break;
      case 'lte': pass = !isNull && Number(cell) <= numTarget; break;
      default: pass = true;
    }
    if (pass) keptIdx.push(i);
    else if (rejectedIdx) rejectedIdx.push(i);
  }
  return {
    kept: table.takeRows(keptIdx),
    rejected: rejectedIdx ? table.takeRows(rejectedIdx) : null
  };
}

/**
 * Vectorized columnar deduplication with Selection Vector + lazy `duplicates` port.
 */
export function deduplicateColumnar(table, keys, keep = 'first', caseSensitive = true, options = {}) {
  const keyCols = keys && keys.length ? keys : table.columns;
  const keyVecs = keyCols.map(k => table.getColumn(k)).filter(Boolean);
  const includeDuplicates = Boolean(options.includeDuplicates);
  const n = table.rowCount;
  const sel = table.selection;
  if (keyVecs.length === 0) return { kept: table, duplicates: includeDuplicates ? table.takeRows([]) : null, removedCount: 0 };

  const singleNumeric = keyVecs.length === 1 && (keyVecs[0].kind === 'int' || keyVecs[0].kind === 'float');
  const getKey = (i) => {
    const p = sel ? sel[i] : i;
    if (singleNumeric) {
      return keyVecs[0].nullBitmap[p] === 0 ? '__NULL__' : keyVecs[0].values[p];
    }
    let k = '';
    for (let j = 0; j < keyVecs.length; j++) {
      const v = keyVecs[j].get(p);
      const s = v === null || v === undefined ? '' : (caseSensitive ? String(v) : String(v).toLowerCase());
      k = j === 0 ? s : `${k}||${s}`;
    }
    return k;
  };

  const keptIdx = [];
  const dupIdx = includeDuplicates ? [] : null;
  let removedCount = 0;

  if (keep === 'first') {
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const k = getKey(i);
      if (seen.has(k)) {
        removedCount++;
        if (dupIdx) dupIdx.push(i);
      } else {
        seen.add(k);
        keptIdx.push(i);
      }
    }
  } else {
    const lastPos = new Map();
    for (let i = 0; i < n; i++) lastPos.set(getKey(i), i);
    for (let i = 0; i < n; i++) {
      if (lastPos.get(getKey(i)) === i) keptIdx.push(i);
      else {
        removedCount++;
        if (dupIdx) dupIdx.push(i);
      }
    }
  }

  return {
    kept: table.takeRows(keptIdx),
    duplicates: dupIdx ? table.takeRows(dupIdx) : null,
    removedCount
  };
}

/**
 * Vectorized columnar sort (zero-copy Selection Vector output).
 */
export function sortColumnar(table, column, direction = 'asc') {
  const vec = table.getColumn(column);
  if (!vec) return table;
  const n = table.rowCount;
  const sel = table.selection;
  const indices = new Int32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  const dir = direction === 'desc' ? -1 : 1;

  if (vec.kind === 'int' || vec.kind === 'float') {
    const vals = vec.values;
    const nulls = vec.nullBitmap;
    indices.sort((a, b) => {
      const pa = sel ? sel[a] : a;
      const pb = sel ? sel[b] : b;
      if (nulls[pa] === 0 && nulls[pb] === 0) return 0;
      if (nulls[pa] === 0) return 1;
      if (nulls[pb] === 0) return -1;
      return (vals[pa] - vals[pb]) * dir;
    });
  } else {
    indices.sort((a, b) => {
      const va = vec.get(sel ? sel[a] : a);
      const vb = vec.get(sel ? sel[b] : b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }
  return table.takeRows(indices);
}

export class DataHandle {
  constructor({ kind = 'columnar', columnar = null, rows = null, columns = null, rawJson = undefined, badRows = [], meta = {}, exportedText = undefined, exportedFormat = undefined, diffResult = undefined }) {
    this.isDataHandle = true;
    this.kind = kind;
    this._columnar = columnar;
    this._rows = rows;
    this.columns = columns || columnar?.columns || (rows?.[0] ? Object.keys(rows[0]) : []);
    this.rawJson = rawJson;
    this.badRows = badRows || columnar?.badRows || [];
    this.meta = meta || columnar?.meta || {};
    this.exportedText = exportedText;
    this.exportedFormat = exportedFormat;
    this.diffResult = diffResult;
  }

  get rowCount() {
    if (this._columnar) return this._columnar.rowCount;
    return this._rows ? this._rows.length : 0;
  }

  get rows() {
    if (!this._rows && this._columnar) {
      this._rows = this._columnar.toRows();
    }
    return this._rows || [];
  }

  asColumnar() {
    if (!this._columnar) {
      this._columnar = ColumnarTable.fromRows(this.columns, this._rows || [], this.badRows, this.meta);
    }
    return this._columnar;
  }

  sliceRows(offset = 0, limit = 200) {
    if (this._columnar) return this._columnar.toRows(offset, limit);
    return (this._rows || []).slice(offset, offset + limit);
  }

  estimateBytes() {
    if (this._columnar) return this._columnar.estimateBytes();
    return (this._rows?.length || 0) * Math.max(this.columns.length, 1) * 48;
  }

  static fromAny(input) {
    if (!input) return new DataHandle({ kind: 'rows', columns: [], rows: [] });
    if (input.isDataHandle) return input;
    if (input instanceof ColumnarTable) return new DataHandle({ kind: 'columnar', columnar: input });
    if (Array.isArray(input.rows)) {
      return new DataHandle({
        kind: 'rows',
        columns: input.columns || [],
        rows: input.rows,
        rawJson: input.rawJson,
        badRows: input.badRows || [],
        meta: input.meta || {},
        exportedText: input.exportedText,
        exportedFormat: input.exportedFormat,
        diffResult: input.diffResult
      });
    }
    return new DataHandle({ kind: 'json', rawJson: input, columns: [], rows: [] });
  }
}

const ADAPTERS = new Map();

export const ColumnarJsAdapter = {
  name: 'columnar-js',
  version: '2.1.1',
  tier: 1,
  description: 'Zero-cold-start vectorized JS ColumnarTable engine (Selection Vectors + TypedArrays + Dictionary Pushdown + CoW).',
  available: () => true,
  supports: (op) => ['filter', 'deduplicate', 'sort', 'select', 'rename'].includes(op),
  filter: filterColumnar,
  deduplicate: deduplicateColumnar,
  sort: sortColumnar
};

export const DuckDbWasmAdapter = {
  name: 'duckdb-wasm',
  version: '1.0.0-adapter',
  tier: 2,
  description: 'Optional high-scale SQL / Parquet / Arrow adapter powered by DuckDB-Wasm.',
  _instance: null,
  bind(duckdbInstance) { this._instance = duckdbInstance; },
  unbind() { this._instance = null; },
  available() { return this._instance !== null; },
  supports: (op) => ['sql', 'parquet', 'filter', 'deduplicate', 'sort', 'join'].includes(op),
  async querySql(handle, sql) {
    if (!this._instance) throw new Error('DuckDbWasmAdapter is not bound.');
    return this._instance.query(sql, handle);
  }
};

ADAPTERS.set(ColumnarJsAdapter.name, ColumnarJsAdapter);
ADAPTERS.set(DuckDbWasmAdapter.name, DuckDbWasmAdapter);

export function registerAdapter(adapter) {
  if (!adapter?.name) throw new Error('ExecutionAdapter must have a "name".');
  ADAPTERS.set(adapter.name, adapter);
}
export function getAdapter(name) { return ADAPTERS.get(name) || null; }
export function selectBestAdapter(preferred = 'auto', op = 'filter') {
  if (preferred !== 'auto') {
    const exact = ADAPTERS.get(preferred);
    if (exact && exact.available()) return exact;
  }
  if (DuckDbWasmAdapter.available() && DuckDbWasmAdapter.supports(op)) return DuckDbWasmAdapter;
  return ColumnarJsAdapter;
}
export function listAdapters() {
  return Array.from(ADAPTERS.values()).map(a => ({ name: a.name, version: a.version, tier: a.tier, available: a.available(), description: a.description }));
}

export class OpfsStorageAdapter {
  constructor() { this._memFallback = new Map(); }
  hasNativeOpfs() { return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'; }
  async write(key, textOrBytes) {
    if (this.hasNativeOpfs()) {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(key.replace(/[^a-zA-Z0-9._-]/g, '_'), { create: true });
      const writable = await fh.createWritable();
      await writable.write(textOrBytes);
      await writable.close();
      return { backend: 'opfs', key };
    }
    this._memFallback.set(key, textOrBytes);
    return { backend: 'memory-fallback', key };
  }
  async read(key) {
    if (this.hasNativeOpfs()) {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(key.replace(/[^a-zA-Z0-9._-]/g, '_'));
      const file = await fh.getFile();
      return file.text();
    }
    return this._memFallback.get(key) ?? null;
  }
  async clear(key) {
    if (this.hasNativeOpfs()) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(key.replace(/[^a-zA-Z0-9._-]/g, '_')).catch(() => {});
    }
    this._memFallback.delete(key);
  }
}
