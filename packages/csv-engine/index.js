/**
 * @module @data-workbench/csv-engine
 * Local-first, zero-dependency CSV dialect detector, true incremental streaming state-machine parser,
 * direct ColumnarTable loader, and formula-safe serializer (v2.1).
 */

import { ColumnarTable, DataHandle } from '../engine-core/index.js';

export const DEFAULT_NULL_TOKENS = ['', 'null', 'NULL', 'N/A', 'NA', 'n/a', 'None', 'NONE', '-', 'undefined'];
export const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];
export const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * True incremental RFC 4180 CSV chunk state machine (v2.1).
 * Handles arbitrary chunk boundaries including mid-quote, mid-CRLF, and mid-UTF-8 byte sequences.
 */
export class CsvStreamParser {
  constructor(options = {}) {
    this.delimiter = options.delimiter ?? ',';
    this.quote = options.quote ?? '"';
    this.escape = options.escape ?? this.quote;
    this.maxRows = options.maxRows ?? 5_000_000;
    this._decoder = new TextDecoder('utf-8', { fatal: false });
    this._inQuotes = false;
    this._pendingQuote = false;
    this._pendingEscape = false;
    this._pendingCR = false;
    this._field = '';
    this._row = [];
    this.rowsEmitted = 0;
  }

  /**
   * Feed a string or Uint8Array chunk and return an array of complete parsed rows from this chunk.
   */
  feed(chunk) {
    const text = chunk instanceof Uint8Array
      ? this._decoder.decode(chunk, { stream: true })
      : String(chunk ?? '');
    return this._consume(text);
  }

  /**
   * Flush any buffered UTF-8 bytes and emit the final partial row.
   */
  flush() {
    const tail = this._decoder.decode();
    const rows = tail ? this._consume(tail) : [];
    if (this._pendingQuote) {
      this._inQuotes = false;
      this._pendingQuote = false;
    }
    if (this._field.length > 0 || this._row.length > 0) {
      this._row.push(this._field);
      this._field = '';
      if (!(this._row.length === 1 && this._row[0] === '')) {
        rows.push(this._row);
        this.rowsEmitted++;
      }
      this._row = [];
    }
    return { rows, unclosedQuote: this._inQuotes };
  }

  _consume(text) {
    const out = [];
    const delim = this.delimiter;
    const quote = this.quote;
    const esc = this.escape;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (this._pendingCR) {
        this._pendingCR = false;
        if (ch === '\n') continue;
      }

      if (this._pendingEscape) {
        this._pendingEscape = false;
        this._field += ch;
        continue;
      }

      if (this._pendingQuote) {
        this._pendingQuote = false;
        if (ch === quote) {
          this._field += quote;
          continue;
        }
        this._inQuotes = false;
        // Fall through to handle `ch` outside quotes
      }

      if (this._inQuotes) {
        if (esc !== quote && ch === esc) {
          this._pendingEscape = true;
          continue;
        }
        if (ch === quote) {
          this._pendingQuote = true;
          continue;
        }
        this._field += ch;
        continue;
      }

      if (ch === quote && this._field.length === 0) {
        this._inQuotes = true;
        continue;
      }

      if (ch === delim) {
        this._row.push(this._field);
        this._field = '';
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        this._row.push(this._field);
        this._field = '';
        if (!(this._row.length === 1 && this._row[0] === '')) {
          out.push(this._row);
          this.rowsEmitted++;
          if (this.rowsEmitted >= this.maxRows) break;
        }
        this._row = [];
        if (ch === '\r') this._pendingCR = true;
        continue;
      }

      this._field += ch;
    }

    return out;
  }
}

/**
 * Detect encoding artifacts, BOM, and line endings from raw string or Uint8Array.
 */
export function detectEncodingAndLineEnding(input) {
  let encoding = 'UTF-8';
  let confidence = 'high';
  let hasBom = false;
  let mojibakeWarnings = [];
  let text = '';

  if (input instanceof Uint8Array) {
    if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
      encoding = 'UTF-8 (BOM)';
      hasBom = true;
      text = new TextDecoder('utf-8').decode(input.subarray(3));
    } else if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
      encoding = 'UTF-16LE';
      hasBom = true;
      text = new TextDecoder('utf-16le').decode(input.subarray(2));
    } else if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
      encoding = 'UTF-16BE';
      hasBom = true;
      const swapped = new Uint8Array(input.length - 2);
      for (let i = 2; i + 1 < input.length; i += 2) {
        swapped[i - 2] = input[i + 1];
        swapped[i - 1] = input[i];
      }
      text = new TextDecoder('utf-16le').decode(swapped);
    } else {
      text = new TextDecoder('utf-8', { fatal: false }).decode(input);
      if (text.includes('\uFFFD')) {
        encoding = 'Non-UTF-8 (likely Windows-1252 / Latin-1 / GBK)';
        confidence = 'medium';
        mojibakeWarnings.push('Replacement character (U+FFFD) detected — file may not be UTF-8.');
      }
    }
  } else {
    text = String(input ?? '');
    if (text.charCodeAt(0) === 0xfeff) {
      encoding = 'UTF-8 (BOM)';
      hasBom = true;
      text = text.slice(1);
    }
  }

  const mojibakePattern = /(Ã©|Ã¨|Ã¡|Ã³|Ã±|Ã¼|â€™|â€œ|â€|â€“|ï»¿|\uFFFD)/g;
  const matches = text.slice(0, 65536).match(mojibakePattern);
  if (matches && matches.length > 0) {
    confidence = 'low';
    mojibakeWarnings.push(`Found ${matches.length} suspected mojibake sequence(s) (e.g. "${matches[0]}").`);
  }

  const sample = text.slice(0, 65536);
  const crlfCount = (sample.match(/\r\n/g) || []).length;
  const lfCount = (sample.match(/(?<!\r)\n/g) || []).length;
  const crCount = (sample.match(/\r(?!\n)/g) || []).length;

  let lineEnding = '\n';
  let lineEndingLabel = 'LF (\\n)';
  if (crlfCount >= lfCount && crlfCount >= crCount && crlfCount > 0) {
    lineEnding = '\r\n';
    lineEndingLabel = 'CRLF (\\r\\n)';
  } else if (crCount > lfCount && crCount > crlfCount) {
    lineEnding = '\r';
    lineEndingLabel = 'CR (\\r)';
  }

  return {
    text,
    encoding,
    hasBom,
    encodingConfidence: confidence,
    mojibakeWarnings,
    lineEnding,
    lineEndingLabel,
    mixedLineEndings: [crlfCount, lfCount, crCount].filter(c => c > 0).length > 1
  };
}

/**
 * Low-level RFC 4180 single-pass CSV tokenizer powered by CsvStreamParser.
 */
export function tokenizeCsv(text, options = {}) {
  const maxChars = options.maxChars ?? 150_000_000;
  if (text.length > maxChars) {
    throw new Error(`Input size (${text.length} chars) exceeds safety limit (${maxChars} chars). Use CsvStreamParser.`);
  }
  const parser = new CsvStreamParser(options);
  const rows = parser.feed(text);
  const { rows: tailRows, unclosedQuote } = parser.flush();
  for (const r of tailRows) rows.push(r);
  return { rows, unclosedQuote };
}

/**
 * Automatically detect CSV dialect (delimiter, quote, header, column stability, null tokens).
 */
export function detectCsvDialect(input, options = {}) {
  const sampleLines = options.sampleLines ?? 200;
  const encInfo = detectEncodingAndLineEnding(typeof input === 'string' ? input.slice(0, 131072) : input.subarray(0, 131072));
  const text = encInfo.text;

  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0).slice(0, sampleLines);
  const sampleText = lines.join('\n');

  const candidates = CANDIDATE_DELIMITERS.map(delim => {
    const { rows, unclosedQuote } = tokenizeCsv(sampleText, { delimiter: delim, quote: '"', maxRows: sampleLines });
    if (rows.length === 0) {
      return { delimiter: delim, avgCols: 0, modeCols: 0, stability: 0, score: 0, unclosedQuote };
    }
    const counts = rows.map(r => r.length);
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let modeCols = 1;
    let modeFreq = 0;
    for (const [cols, f] of freq.entries()) {
      if (f > modeFreq || (f === modeFreq && cols > modeCols)) {
        modeCols = cols;
        modeFreq = f;
      }
    }
    const stability = modeFreq / counts.length;
    const avgCols = counts.reduce((a, b) => a + b, 0) / counts.length;
    const score = modeCols > 1 ? stability * Math.min(modeCols, 50) * (unclosedQuote ? 0.5 : 1) : 0.01;
    return {
      delimiter: delim,
      label: delim === '\t' ? 'TAB (\\t)' : delim === ',' ? 'Comma (,)' : delim === ';' ? 'Semicolon (;)' : 'Pipe (|)',
      avgCols: Number(avgCols.toFixed(2)),
      modeCols,
      stability: Number(stability.toFixed(3)),
      score: Number(score.toFixed(3)),
      unclosedQuote
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const runnerUp = candidates[1];

  let delimiterConfidence = 'high';
  if (best.modeCols <= 1 || best.stability < 0.7) delimiterConfidence = 'low';
  else if (best.stability < 0.95 || (runnerUp && runnerUp.score > best.score * 0.75)) delimiterConfidence = 'medium';

  const { rows: sampleRows } = tokenizeCsv(sampleText, { delimiter: best.delimiter, quote: '"', maxRows: sampleLines });
  let hasHeader = true;
  let headerConfidence = 'high';
  let headerReason = 'First row contains unique text labels distinct from numeric/date data rows.';

  if (sampleRows.length >= 2) {
    const first = sampleRows[0];
    const rest = sampleRows.slice(1, Math.min(sampleRows.length, 20));
    const numRegex = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
    const firstNumericRatio = first.filter(v => numRegex.test(v.trim())).length / Math.max(first.length, 1);
    const restNumericRatio = rest.reduce((acc, r) => acc + r.filter(v => numRegex.test(v.trim())).length / Math.max(r.length, 1), 0) / rest.length;
    const firstUnique = new Set(first.map(v => v.trim().toLowerCase())).size === first.length;

    if (firstNumericRatio > 0.5) {
      hasHeader = false;
      headerConfidence = 'medium';
      headerReason = 'First row is predominantly numeric, suggesting data without a header row.';
    } else if (!firstUnique) {
      headerConfidence = 'medium';
      headerReason = 'First row contains duplicate column names.';
    } else if (firstNumericRatio === 0 && restNumericRatio > 0.1) {
      hasHeader = true;
      headerConfidence = 'high';
      headerReason = 'First row is all non-numeric strings while subsequent rows contain numeric values.';
    } else {
      hasHeader = true;
      headerConfidence = 'medium';
      headerReason = 'First row has unique string labels; manual verification recommended if all columns are text.';
    }
  } else {
    headerConfidence = 'low';
    headerReason = 'Insufficient rows to infer header with high confidence.';
  }

  const detectedNullTokens = new Set();
  for (const r of sampleRows.slice(hasHeader ? 1 : 0)) {
    for (const cell of r) {
      const trimmed = cell.trim();
      if (DEFAULT_NULL_TOKENS.includes(trimmed)) detectedNullTokens.add(trimmed);
    }
  }

  return {
    delimiter: best.delimiter,
    delimiterLabel: best.label,
    delimiterConfidence,
    candidates,
    quote: '"',
    escape: '"',
    hasHeader,
    headerConfidence,
    headerReason,
    expectedColumns: best.modeCols,
    columnStability: best.stability,
    encoding: encInfo.encoding,
    encodingConfidence: encInfo.encodingConfidence,
    hasBom: encInfo.hasBom,
    mojibakeWarnings: encInfo.mojibakeWarnings,
    lineEnding: encInfo.lineEnding,
    lineEndingLabel: encInfo.lineEndingLabel,
    mixedLineEndings: encInfo.mixedLineEndings,
    detectedNullTokens: Array.from(detectedNullTokens)
  };
}

function normalizeHeaders(rawHeader, expectedCols, hasHeader) {
  if (!hasHeader) {
    return Array.from({ length: expectedCols }, (_, i) => `column_${i + 1}`);
  }
  const seen = new Map();
  return rawHeader.map((col, idx) => {
    const name = col.trim() || `column_${idx + 1}`;
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count > 0 ? `${name}_${count + 1}` : name;
  });
}

/**
 * v2.1 Direct-to-Columnar CSV Parser (zero per-row JS object allocation!).
 * Returns a DataHandle backed by a ColumnarTable (TypedArrays + Dictionary Encoding).
 */
export function parseCsvToColumnar(input, options = {}) {
  const dialect = detectCsvDialect(input, { sampleLines: 200 });
  const encInfo = detectEncodingAndLineEnding(input);
  const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter : dialect.delimiter;
  const quote = options.quote ?? dialect.quote;
  const escape = options.escape ?? dialect.escape;
  const hasHeader = options.header !== undefined ? Boolean(options.header) : dialect.hasHeader;
  const maxRows = options.maxRows ?? 2_000_000;

  const { rows: rawRows, unclosedQuote } = tokenizeCsv(encInfo.text, { delimiter, quote, escape, maxRows: maxRows + 1 });
  if (rawRows.length === 0) {
    const emptyTable = ColumnarTable.fromColumnArrays([], [], 0, [], { dialect, totalRows: 0, unclosedQuote, warnings: [] });
    return new DataHandle({ kind: 'columnar', columnar: emptyTable });
  }

  const columns = normalizeHeaders(rawRows[0], Math.max(dialect.expectedColumns, rawRows[0].length), hasHeader);
  const expectedCols = columns.length;
  const dataStartIdx = hasHeader ? 1 : 0;
  const dataRowCount = rawRows.length - dataStartIdx;
  const colArrays = Array.from({ length: expectedCols }, () => new Array(dataRowCount));
  const badRows = [];
  let writeIdx = 0;

  for (let i = dataStartIdx; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (r.length === 1 && r[0].trim() === '') continue;
    if (r.length !== expectedCols) {
      badRows.push({
        rowIndex: writeIdx,
        lineNumber: i + 1,
        expectedColumns: expectedCols,
        actualColumns: r.length,
        reason: r.length < expectedCols ? 'Missing columns' : 'Extra columns (possible unquoted delimiter)',
        rawValues: r
      });
    }
    for (let c = 0; c < expectedCols; c++) {
      const val = c < r.length ? r[c] : '';
      colArrays[c][writeIdx] = val === '' ? null : val;
    }
    writeIdx++;
  }

  if (writeIdx < dataRowCount) {
    for (let c = 0; c < expectedCols; c++) colArrays[c].length = writeIdx;
  }

  const warnings = [...dialect.mojibakeWarnings];
  if (unclosedQuote) warnings.push('Unclosed quote detected at end of file.');
  if (badRows.length > 0) warnings.push(`${badRows.length} misaligned row(s) detected.`);

  const table = ColumnarTable.fromColumnArrays(columns, colArrays, writeIdx, badRows, {
    dialect: { ...dialect, delimiter, quote, escape, hasHeader },
    totalRows: writeIdx,
    unclosedQuote,
    warnings
  });
  return new DataHandle({ kind: 'columnar', columnar: table });
}

/**
 * Parse CSV text/bytes into structured Dataset ({ columns, rows, badRows, meta }).
 * Backward-compatible v2.0 API.
 */
export function parseCsv(input, options = {}) {
  const dialect = detectCsvDialect(input, { sampleLines: 200 });
  const encInfo = detectEncodingAndLineEnding(input);
  const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter : dialect.delimiter;
  const quote = options.quote ?? dialect.quote;
  const escape = options.escape ?? dialect.escape;
  const hasHeader = options.header !== undefined ? Boolean(options.header) : dialect.hasHeader;
  const maxRows = options.maxRows ?? 1_000_000;

  const { rows: rawRows, unclosedQuote } = tokenizeCsv(encInfo.text, { delimiter, quote, escape, maxRows: maxRows + 1 });
  if (rawRows.length === 0) {
    return { columns: [], rows: [], badRows: [], meta: { dialect, totalRows: 0, unclosedQuote, warnings: [] } };
  }

  const columns = normalizeHeaders(rawRows[0], Math.max(dialect.expectedColumns, rawRows[0].length), hasHeader);
  const expectedCols = columns.length;
  const dataStartIdx = hasHeader ? 1 : 0;
  const records = [];
  const badRows = [];

  for (let i = dataStartIdx; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (r.length === 1 && r[0].trim() === '') continue;
    if (r.length !== expectedCols) {
      badRows.push({
        rowIndex: records.length,
        lineNumber: i + 1,
        expectedColumns: expectedCols,
        actualColumns: r.length,
        reason: r.length < expectedCols ? 'Missing columns' : 'Extra columns (possible unquoted delimiter)',
        rawValues: r
      });
    }
    const obj = {};
    for (let c = 0; c < expectedCols; c++) {
      const val = c < r.length ? r[c] : '';
      obj[columns[c]] = val === '' ? null : val;
    }
    records.push(obj);
  }

  const warnings = [...dialect.mojibakeWarnings];
  if (unclosedQuote) warnings.push('Unclosed quote detected at end of file.');
  if (badRows.length > 0) warnings.push(`${badRows.length} misaligned row(s) detected.`);

  return {
    columns,
    rows: records,
    badRows,
    meta: {
      dialect: { ...dialect, delimiter, quote, escape, hasHeader },
      totalRows: records.length,
      unclosedQuote,
      warnings
    }
  };
}

/**
 * True incremental chunked CSV generator using CsvStreamParser (v2.1).
 */
export function* parseCsvChunks(input, options = {}) {
  const chunkSize = options.chunkSize ?? 5000;
  const byteSlice = options.byteSlice ?? 65536;
  const dialect = detectCsvDialect(input, { sampleLines: 200 });
  const encInfo = detectEncodingAndLineEnding(input);
  const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter : dialect.delimiter;
  const hasHeader = options.header !== undefined ? Boolean(options.header) : dialect.hasHeader;

  const parser = new CsvStreamParser({ delimiter, quote: options.quote ?? '"', escape: options.escape ?? '"' });
  const text = encInfo.text;
  let columns = null;
  let buffer = [];
  let offset = 0;

  const toRecords = (rawBatch) => {
    const out = [];
    for (const r of rawBatch) {
      if (!columns) {
        columns = normalizeHeaders(r, Math.max(dialect.expectedColumns, r.length), hasHeader);
        if (hasHeader) continue;
      }
      const obj = {};
      for (let c = 0; c < columns.length; c++) {
        const v = c < r.length ? r[c] : '';
        obj[columns[c]] = v === '' ? null : v;
      }
      out.push(obj);
    }
    return out;
  };

  for (let pos = 0; pos < text.length; pos += byteSlice) {
    const slice = text.slice(pos, pos + byteSlice);
    const rawRows = parser.feed(slice);
    buffer.push(...toRecords(rawRows));
    while (buffer.length >= chunkSize) {
      const batch = buffer.splice(0, chunkSize);
      yield { columns, rows: batch, offset, progress: Math.min(0.99, (pos + byteSlice) / Math.max(text.length, 1)), meta: { dialect } };
      offset += batch.length;
    }
  }

  const { rows: tailRaw } = parser.flush();
  buffer.push(...toRecords(tailRaw));
  if (buffer.length > 0) {
    yield { columns: columns || [], rows: buffer, offset, progress: 1, meta: { dialect } };
  }
}

/**
 * Direct ColumnarTable CSV serializer (skips creating intermediate row objects!).
 */
export function serializeColumnarCsv(tableOrHandle, options = {}) {
  const table = tableOrHandle instanceof ColumnarTable ? tableOrHandle : tableOrHandle.asColumnar();
  const delimiter = options.delimiter ?? ',';
  const lineEnding = options.lineEnding ?? '\n';
  const includeHeader = options.header !== false;
  const formulaGuard = options.formulaGuard !== false;
  const cols = table.columns;
  const vecs = cols.map(c => table.getColumn(c));

  const escapeCell = (raw) => {
    if (raw === null || raw === undefined) return '';
    let str = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (formulaGuard && str.length > 0 && FORMULA_PREFIXES.includes(str[0])) {
      str = `'${str}`;
    }
    if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = new Array(table.rowCount + (includeHeader ? 1 : 0));
  let idx = 0;
  if (includeHeader) lines[idx++] = cols.map(escapeCell).join(delimiter);
  const sel = table.selection;
  for (let r = 0; r < table.rowCount; r++) {
    const phys = sel ? sel[r] : r;
    const cells = new Array(cols.length);
    for (let c = 0; c < cols.length; c++) cells[c] = escapeCell(vecs[c].get(phys));
    lines[idx++] = cells.join(delimiter);
  }
  return lines.join(lineEnding);
}

/**
 * Serialize tabular dataset or DataHandle to RFC 4180 CSV with Formula Injection Protection.
 */
export function serializeCsv(dataset, options = {}) {
  if (dataset instanceof ColumnarTable || (dataset?.isDataHandle && dataset._columnar)) {
    return serializeColumnarCsv(dataset, options);
  }
  const delimiter = options.delimiter ?? ',';
  const lineEnding = options.lineEnding ?? '\n';
  const includeHeader = options.header !== false;
  const formulaGuard = options.formulaGuard !== false;
  const columns = dataset.columns && dataset.columns.length > 0
    ? dataset.columns
    : (dataset.rows[0] ? Object.keys(dataset.rows[0]) : []);

  const escapeCell = (raw) => {
    if (raw === null || raw === undefined) return '';
    let str = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (formulaGuard && str.length > 0 && FORMULA_PREFIXES.includes(str[0])) {
      str = `'${str}`;
    }
    const needsQuote = str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r');
    if (needsQuote) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };

  const lines = [];
  if (includeHeader && columns.length > 0) {
    lines.push(columns.map(escapeCell).join(delimiter));
  }
  for (const row of dataset.rows) {
    lines.push(columns.map(col => escapeCell(row[col])).join(delimiter));
  }
  return lines.join(lineEnding);
}
