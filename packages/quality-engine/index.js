/**
 * @module @data-workbench/quality-engine
 * Data Quality Radar, PII Sentinel, Fix Preview + Confidence, and Explain This Dataset.
 */

const REGEX_EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const REGEX_ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const REGEX_SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const REGEX_DASH_DATE = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
const REGEX_INT = /^[+-]?\d+$/;
const REGEX_FLOAT = /^[+-]?(?:\d+\.\d+|\.\d+|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/;
const REGEX_EU_NUMBER = /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/;
const REGEX_CURRENCY = /^[$€£¥]\s*[+-]?\d[\d,]*(?:\.\d{1,2})?$/;
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGEX_URL = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const REGEX_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;
const REGEX_PHONE = /^(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}$/;
const REGEX_SSN = /^\d{3}-\d{2}-\d{4}$/;
const REGEX_TOKEN = /^(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[a-zA-Z0-9._-]{16,})$/;

const NULL_TOKENS = new Set(['', 'null', 'NULL', 'N/A', 'NA', 'n/a', 'None', 'NONE', '-', 'undefined']);

export function isNullish(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && NULL_TOKENS.has(val.trim())) return true;
  return false;
}

/**
 * Classify a single non-null value into a semantic/primitive type.
 */
export function classifyValue(raw) {
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'number') return Number.isInteger(raw) ? 'integer' : 'float';
  const s = String(raw).trim();
  if (s === 'true' || s === 'false') return 'boolean';
  if (REGEX_INT.test(s)) return 'integer';
  if (REGEX_FLOAT.test(s) || REGEX_EU_NUMBER.test(s)) return 'float';
  if (REGEX_CURRENCY.test(s)) return 'currency';
  if (REGEX_UUID.test(s)) return 'uuid';
  if (REGEX_EMAIL.test(s)) return 'email';
  if (REGEX_URL.test(s)) return 'url';
  if (REGEX_IPV4.test(s)) return 'ip';
  if (REGEX_ISO_DATE.test(s) || REGEX_SLASH_DATE.test(s) || REGEX_DASH_DATE.test(s)) return 'date';
  if (REGEX_PHONE.test(s) && s.replace(/\D/g, '').length >= 7) return 'phone';
  return 'string';
}

/**
 * Deterministic lightweight hash (FNV-1a 64-bit hex) for local-first PII hashing without async crypto.
 */
export function deterministicHash(input, salt = 'dw-v2') {
  const str = `${salt}:${String(input)}`;
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'h_' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * PII Sentinel — Heuristic scanner across dataset columns.
 * Explicitly reports confidence and false-positive disclaimer per Section 2 (Innovation K).
 */
export function detectPii(dataset) {
  const findings = [];
  const rows = dataset.rows || [];
  const sampleLimit = Math.min(rows.length, 2000);

  for (const col of dataset.columns || []) {
    const colLower = col.toLowerCase();
    const counts = { email: 0, phone: 0, ssn_id: 0, ip: 0, token: 0, address: 0 };
    const samples = { email: [], phone: [], ssn_id: [], ip: [], token: [], address: [] };
    let nonNull = 0;

    for (let i = 0; i < sampleLimit; i++) {
      const raw = rows[i][col];
      if (isNullish(raw)) continue;
      nonNull++;
      const s = String(raw).trim();
      if (REGEX_EMAIL.test(s)) {
        counts.email++;
        if (samples.email.length < 3) samples.email.push(s);
      } else if (REGEX_TOKEN.test(s)) {
        counts.token++;
        if (samples.token.length < 3) samples.token.push(s.slice(0, 6) + '***');
      } else if (REGEX_SSN.test(s)) {
        counts.ssn_id++;
        if (samples.ssn_id.length < 3) samples.ssn_id.push(s);
      } else if (REGEX_IPV4.test(s)) {
        counts.ip++;
        if (samples.ip.length < 3) samples.ip.push(s);
      } else if (REGEX_PHONE.test(s) && s.replace(/\D/g, '').length >= 10 && !REGEX_ISO_DATE.test(s)) {
        counts.phone++;
        if (samples.phone.length < 3) samples.phone.push(s);
      } else if (/(address|street|addr|location)/i.test(colLower) && /\d+\s+[a-zA-Z]+/.test(s)) {
        counts.address++;
        if (samples.address.length < 3) samples.address.push(s);
      }
    }

    if (nonNull === 0) continue;
    for (const [piiType, matchCount] of Object.entries(counts)) {
      const ratio = matchCount / nonNull;
      if (ratio >= 0.2 || (piiType === 'token' && matchCount > 0)) {
        findings.push({
          column: col,
          piiType,
          matchCount,
          matchRate: Number(ratio.toFixed(3)),
          confidence: ratio >= 0.8 ? 'high' : ratio >= 0.4 ? 'medium' : 'low',
          samples: samples[piiType],
          note: 'Heuristic detection — review for false positives before applying masking.'
        });
      }
    }
  }
  return findings;
}

/**
 * Mask a single value according to PII Sentinel strategy.
 * Strategies: mask | hash | remove | synthetic | keepLast
 */
export function maskPiiValue(value, strategy = 'mask', options = {}) {
  if (isNullish(value)) return value;
  const s = String(value);
  const keepLastN = options.keepLast ?? 4;

  switch (strategy) {
    case 'remove':
      return null;
    case 'hash':
      return deterministicHash(s, options.salt ?? 'dw-pii');
    case 'keepLast':
      if (s.length <= keepLastN) return '*'.repeat(s.length);
      return '*'.repeat(s.length - keepLastN) + s.slice(-keepLastN);
    case 'synthetic': {
      const h = deterministicHash(s, 'syn').slice(2, 8);
      if (REGEX_EMAIL.test(s)) return `user_${h}@example.invalid`;
      if (REGEX_IPV4.test(s)) return `192.0.2.${parseInt(h.slice(0, 2), 16) % 254 + 1}`;
      if (REGEX_PHONE.test(s)) return `+1-555-01${String(parseInt(h.slice(0, 2), 16) % 100).padStart(2, '0')}`;
      return `SYNTH_${h.toUpperCase()}`;
    }
    case 'mask':
    default: {
      if (REGEX_EMAIL.test(s)) {
        const [local, domain] = s.split('@');
        return `${local[0] || '*'}***@${domain}`;
      }
      if (s.length <= 4) return '****';
      return s.slice(0, 2) + '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-2);
    }
  }
}

/**
 * Data Quality Radar — Full explainable column and table profiling (Section 2 Innovation A & Section 6.1).
 */

/**
 * Fast Columnar-Native Data Quality Radar (v2.1.1 — zero JS row-object allocation!).
 */
function profileColumnarTable(table) {
  const columns = table.columns || [];
  const rowCount = table.rowCount;
  const sel = table.selection;
  const badRows = table.badRows || [];
  const columnProfiles = [];
  const issues = [];

  for (const col of columns) {
    const vec = table.getColumn(col);
    let nullCount = 0;
    let uniqueCount = 0;
    let inferredType = 'string';
    let typeConfidence = 1;
    let validity = 1;
    let consistency = 1;
    let invalidCount = 0;
    let whitespaceIssueCount = 0;
    const topValues = [];

    if (vec.kind === 'int' || vec.kind === 'float') {
      inferredType = vec.kind === 'int' ? 'integer' : 'float';
      const nulls = vec.nullBitmap;
      const vals = vec.values;
      const uniqSet = new Set();
      for (let i = 0; i < rowCount; i++) {
        const p = sel ? sel[i] : i;
        if (nulls[p] === 0) nullCount++;
        else if (uniqSet.size < 200000) uniqSet.add(vals[p]);
      }
      uniqueCount = uniqSet.size;
    } else if (vec.kind === 'dict') {
      const nulls = vec.nullBitmap;
      const codes = vec.codes;
      const dict = vec.dictionary;
      const counts = new Uint32Array(dict.length);
      for (let i = 0; i < rowCount; i++) {
        const p = sel ? sel[i] : i;
        if (nulls[p] === 0) nullCount++;
        else counts[codes[p]]++;
      }
      const typeCounts = new Map();
      for (let d = 0; d < dict.length; d++) {
        if (counts[d] === 0) continue;
        uniqueCount++;
        const t = classifyValue(dict[d]);
        typeCounts.set(t, (typeCounts.get(t) || 0) + counts[d]);
        if (dict[d] !== dict[d].trim()) whitespaceIssueCount += counts[d];
      }
      let dom = 0;
      for (const [t, c] of typeCounts.entries()) {
        if (c > dom) { dom = c; inferredType = t; }
      }
      const nonNull = rowCount - nullCount;
      typeConfidence = nonNull ? dom / nonNull : 0;
      consistency = nonNull ? Math.max(0, (nonNull - whitespaceIssueCount) / nonNull) : 1;
      const sortedDict = dict.map((v, d) => ({ value: v, count: counts[d] })).filter(x => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
      for (const item of sortedDict) {
        topValues.push({ value: item.value, count: item.count, ratio: Number((item.count / Math.max(nonNull, 1)).toFixed(3)) });
      }
    } else {
      const valueFreq = new Map();
      const typeCounts = new Map();
      for (let i = 0; i < rowCount; i++) {
        const p = sel ? sel[i] : i;
        const raw = vec.get(p);
        if (isNullish(raw)) { nullCount++; continue; }
        const s = String(raw);
        if (s !== s.trim()) whitespaceIssueCount++;
        const tr = s.trim();
        if (valueFreq.size < 100000) valueFreq.set(tr, (valueFreq.get(tr) || 0) + 1);
        const t = classifyValue(tr);
        typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
      }
      uniqueCount = valueFreq.size;
      let dom = 0;
      for (const [t, c] of typeCounts.entries()) {
        if (c > dom) { dom = c; inferredType = t; }
      }
      const nonNull = rowCount - nullCount;
      typeConfidence = nonNull ? dom / nonNull : 0;
      consistency = nonNull ? Math.max(0, (nonNull - whitespaceIssueCount) / nonNull) : 1;
    }

    const nonNullCount = rowCount - nullCount;
    const completeness = rowCount === 0 ? 1 : nonNullCount / rowCount;
    const uniqueness = nonNullCount === 0 ? 1 : uniqueCount / nonNullCount;
    const isLikelyId = uniqueness >= 0.99 && completeness >= 0.98 && rowCount >= 2 && (/(^id$|_id$|uuid|code|sku|key$)/i.test(col) || inferredType === 'uuid');

    columnProfiles.push({
      name: col,
      inferredType,
      typeConfidence: Number(typeConfidence.toFixed(3)),
      completeness: Number(completeness.toFixed(4)),
      uniqueness: Number(uniqueness.toFixed(4)),
      validity: Number(validity.toFixed(4)),
      consistency: Number(consistency.toFixed(4)),
      nullCount,
      nullRate: Number((1 - completeness).toFixed(4)),
      uniqueCount,
      invalidCount,
      ambiguousDateCount: 0,
      whitespaceIssueCount,
      mixedLocaleNumbers: false,
      isLikelyId,
      isHighCardinality: uniqueness >= 0.85 && uniqueCount >= 10,
      pii: null,
      topValues,
      issueRowIndices: { nulls: [], invalid: [], whitespace: [], slashDates: [] }
    });
  }

  const avgCompleteness = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.completeness, 0) / columnProfiles.length : 1;
  const avgValidity = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.validity, 0) / columnProfiles.length : 1;
  const avgConsistency = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.consistency, 0) / columnProfiles.length : 1;

  return {
    summary: {
      rowCount,
      columnCount: columns.length,
      duplicateRowCount: 0,
      duplicateRowRate: 0,
      misalignedRowCount: badRows.length,
      completeness: Number(avgCompleteness.toFixed(4)),
      validity: Number(avgValidity.toFixed(4)),
      consistency: Number(avgConsistency.toFixed(4)),
      issueCount: issues.length,
      piiColumnCount: 0
    },
    columns: columnProfiles,
    issues,
    piiFindings: [],
    duplicateRowIndices: []
  };
}

export function profileDataset(dataset) {
  // Fast columnar path for large datasets (> 5,000 rows) to avoid row-object materialization
  if (dataset?.isDataHandle && dataset._columnar && dataset._columnar.rowCount > 5000) {
    return profileColumnarTable(dataset._columnar);
  }
  if (dataset?.vectors instanceof Map && dataset.rowCount > 5000) {
    return profileColumnarTable(dataset);
  }
  const columns = dataset.columns || [];
  const rows = dataset.rows || [];
  const badRows = dataset.badRows || [];
  const rowCount = rows.length;

  // Duplicate row detection (full row signature)
  const rowSigSeen = new Map();
  const duplicateRowIndices = [];
  for (let i = 0; i < rowCount; i++) {
    const sig = JSON.stringify(columns.map(c => rows[i][c] ?? null));
    if (rowSigSeen.has(sig)) {
      duplicateRowIndices.push(i);
    } else {
      rowSigSeen.set(sig, i);
    }
  }

  const piiFindings = detectPii(dataset);
  const piiByCol = new Map();
  for (const f of piiFindings) piiByCol.set(f.column, f);

  const columnProfiles = [];
  const issues = [];

  for (const col of columns) {
    let nullCount = 0;
    const valueFreq = new Map();
    const typeCounts = new Map();
    const nullRowIndices = [];
    const invalidRowIndices = [];
    const slashDateRows = [];
    let ambiguousDates = 0;
    let mixedCaseEmails = 0;
    let whitespaceIssueRows = [];
    let usNumberCount = 0;
    let euNumberCount = 0;

    for (let i = 0; i < rowCount; i++) {
      const raw = rows[i][col];
      if (isNullish(raw)) {
        nullCount++;
        if (nullRowIndices.length < 500) nullRowIndices.push(i);
        continue;
      }
      const str = String(raw);
      if (str !== str.trim()) {
        if (whitespaceIssueRows.length < 500) whitespaceIssueRows.push(i);
      }
      const trimmed = str.trim();
      valueFreq.set(trimmed, (valueFreq.get(trimmed) || 0) + 1);

      const t = classifyValue(trimmed);
      typeCounts.set(t, (typeCounts.get(t) || 0) + 1);

      if (t === 'email' && trimmed !== trimmed.toLowerCase()) {
        mixedCaseEmails++;
      }
      if (REGEX_SLASH_DATE.test(trimmed)) {
        slashDateRows.push(i);
        const [, p1, p2] = trimmed.match(REGEX_SLASH_DATE);
        if (Number(p1) <= 12 && Number(p2) <= 12 && Number(p1) !== Number(p2)) {
          ambiguousDates++;
        }
      }
      if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed)) usNumberCount++;
      if (REGEX_EU_NUMBER.test(trimmed)) euNumberCount++;
    }

    const nonNullCount = rowCount - nullCount;
    const uniqueCount = valueFreq.size;
    const completeness = rowCount === 0 ? 1 : nonNullCount / rowCount;
    const uniqueness = nonNullCount === 0 ? 1 : uniqueCount / nonNullCount;

    // Infer dominant type
    let inferredType = 'string';
    let dominantCount = 0;
    for (const [t, c] of typeCounts.entries()) {
      if (c > dominantCount) {
        dominantCount = c;
        inferredType = t;
      }
    }
    // Promote integer+float mix to float
    if ((typeCounts.get('integer') || 0) > 0 && (typeCounts.get('float') || 0) > 0) {
      const numTotal = (typeCounts.get('integer') || 0) + (typeCounts.get('float') || 0);
      if (numTotal >= dominantCount) {
        inferredType = 'float';
        dominantCount = numTotal;
      }
    }

    const typeConfidence = nonNullCount === 0 ? 0 : dominantCount / nonNullCount;

    // Compute validity & collect invalidRowIndices against inferredType
    if (inferredType !== 'string' && nonNullCount > 0) {
      for (let i = 0; i < rowCount; i++) {
        const raw = rows[i][col];
        if (isNullish(raw)) continue;
        const t = classifyValue(String(raw).trim());
        const ok = t === inferredType || (inferredType === 'float' && t === 'integer');
        if (!ok && invalidRowIndices.length < 500) {
          invalidRowIndices.push(i);
        }
      }
    }

    const validity = nonNullCount === 0 ? 1 : (nonNullCount - invalidRowIndices.length) / nonNullCount;

    // Consistency: check format uniformity (e.g. ISO vs slash dates, case consistency for emails, leading/trailing spaces)
    let inconsistentCount = whitespaceIssueRows.length;
    if (inferredType === 'date') inconsistentCount += slashDateRows.length;
    if (inferredType === 'email') inconsistentCount += mixedCaseEmails;
    const consistency = nonNullCount === 0 ? 1 : Math.max(0, (nonNullCount - inconsistentCount) / nonNullCount);

    const topValues = Array.from(valueFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([value, count]) => ({ value, count, ratio: Number((count / Math.max(nonNullCount, 1)).toFixed(3)) }));

    const isLikelyId = uniqueness >= 0.99 && completeness >= 0.98 && rowCount >= 2 && (/(^id$|_id$|uuid|code|sku|key$)/i.test(col) || inferredType === 'uuid');
    const isHighCardinality = uniqueness >= 0.85 && uniqueCount >= 10;
    const pii = piiByCol.get(col) || null;

    columnProfiles.push({
      name: col,
      inferredType,
      typeConfidence: Number(typeConfidence.toFixed(3)),
      completeness: Number(completeness.toFixed(4)),
      uniqueness: Number(uniqueness.toFixed(4)),
      validity: Number(validity.toFixed(4)),
      consistency: Number(consistency.toFixed(4)),
      nullCount,
      nullRate: Number((1 - completeness).toFixed(4)),
      uniqueCount,
      invalidCount: invalidRowIndices.length,
      ambiguousDateCount: ambiguousDates,
      whitespaceIssueCount: whitespaceIssueRows.length,
      mixedLocaleNumbers: usNumberCount > 0 && euNumberCount > 0,
      isLikelyId,
      isHighCardinality,
      pii,
      topValues,
      issueRowIndices: {
        nulls: nullRowIndices,
        invalid: invalidRowIndices,
        whitespace: whitespaceIssueRows,
        slashDates: slashDateRows
      }
    });

    // Record explainable issues traceable to row indices
    if (nullCount > 0) {
      issues.push({
        id: `nulls:${col}`,
        severity: (nullCount / Math.max(rowCount, 1)) > 0.1 ? 'warning' : 'info',
        category: 'completeness',
        column: col,
        message: `${nullCount} missing/null value(s) (${((nullCount / Math.max(rowCount, 1)) * 100).toFixed(1)}%)`,
        affectedCount: nullCount,
        rowIndices: nullRowIndices
      });
    }
    if (invalidRowIndices.length > 0) {
      issues.push({
        id: `invalid:${col}`,
        severity: 'error',
        category: 'validity',
        column: col,
        message: `${invalidRowIndices.length} value(s) do not match inferred type "${inferredType}"`,
        affectedCount: invalidRowIndices.length,
        rowIndices: invalidRowIndices
      });
    }
    if (inferredType === 'date' && slashDateRows.length > 0) {
      issues.push({
        id: `date_format:${col}`,
        severity: ambiguousDates > 0 ? 'warning' : 'info',
        category: 'consistency',
        column: col,
        message: `${slashDateRows.length} non-ISO date(s) detected${ambiguousDates > 0 ? ` (${ambiguousDates} ambiguous DD/MM vs MM/DD)` : ''}`,
        affectedCount: slashDateRows.length,
        rowIndices: slashDateRows
      });
    }
    if (mixedCaseEmails > 0) {
      issues.push({
        id: `email_case:${col}`,
        severity: 'info',
        category: 'consistency',
        column: col,
        message: `${mixedCaseEmails} uppercase/mixed-case email(s)`,
        affectedCount: mixedCaseEmails,
        rowIndices: rows.map((r, idx) => (typeof r[col] === 'string' && r[col] !== r[col].toLowerCase() ? idx : -1)).filter(x => x >= 0).slice(0, 500)
      });
    }
    if (whitespaceIssueRows.length > 0) {
      issues.push({
        id: `whitespace:${col}`,
        severity: 'info',
        category: 'consistency',
        column: col,
        message: `${whitespaceIssueRows.length} cell(s) have leading or trailing whitespace`,
        affectedCount: whitespaceIssueRows.length,
        rowIndices: whitespaceIssueRows
      });
    }
    if (usNumberCount > 0 && euNumberCount > 0) {
      issues.push({
        id: `locale_num:${col}`,
        severity: 'warning',
        category: 'consistency',
        column: col,
        message: `Mixed numeric locale formats detected (US "1,234.56" and EU "1.234,56")`,
        affectedCount: usNumberCount + euNumberCount,
        rowIndices: []
      });
    }
    if (pii) {
      issues.push({
        id: `pii:${col}`,
        severity: 'warning',
        category: 'privacy',
        column: col,
        message: `Suspected PII (${pii.piiType}) in ${(pii.matchRate * 100).toFixed(0)}% of rows`,
        affectedCount: pii.matchCount,
        rowIndices: []
      });
    }
  }

  if (duplicateRowIndices.length > 0) {
    issues.unshift({
      id: 'duplicates:table',
      severity: 'warning',
      category: 'uniqueness',
      column: null,
      message: `${duplicateRowIndices.length} exact duplicate row(s) (${((duplicateRowIndices.length / Math.max(rowCount, 1)) * 100).toFixed(1)}%)`,
      affectedCount: duplicateRowIndices.length,
      rowIndices: duplicateRowIndices
    });
  }

  if (badRows.length > 0) {
    issues.unshift({
      id: 'bad_rows:table',
      severity: 'error',
      category: 'structure',
      column: null,
      message: `${badRows.length} misaligned CSV row(s) with unexpected column count`,
      affectedCount: badRows.length,
      rowIndices: badRows.map(b => b.rowIndex)
    });
  }

  const avgCompleteness = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.completeness, 0) / columnProfiles.length : 1;
  const avgValidity = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.validity, 0) / columnProfiles.length : 1;
  const avgConsistency = columnProfiles.length ? columnProfiles.reduce((a, c) => a + c.consistency, 0) / columnProfiles.length : 1;

  return {
    summary: {
      rowCount,
      columnCount: columns.length,
      duplicateRowCount: duplicateRowIndices.length,
      duplicateRowRate: rowCount === 0 ? 0 : Number((duplicateRowIndices.length / rowCount).toFixed(4)),
      misalignedRowCount: badRows.length,
      completeness: Number(avgCompleteness.toFixed(4)),
      validity: Number(avgValidity.toFixed(4)),
      consistency: Number(avgConsistency.toFixed(4)),
      issueCount: issues.length,
      piiColumnCount: piiFindings.length
    },
    columns: columnProfiles,
    issues,
    piiFindings,
    duplicateRowIndices
  };
}

/**
 * Fix Preview + Confidence (Section 2 Innovation B).
 * Generates non-destructive, reviewable fix proposals with before/after samples and information-loss warnings.
 */
export function suggestFixes(dataset, profile = null) {
  const prof = profile || profileDataset(dataset);
  const rows = dataset.rows || [];
  const proposals = [];

  // 1. Duplicate rows
  if (prof.summary.duplicateRowCount > 0) {
    const idCol = prof.columns.find(c => c.isLikelyId)?.name;
    proposals.push({
      id: 'fix-deduplicate',
      issue: `${prof.summary.duplicateRowCount} duplicate row(s) found`,
      recommendedAction: idCol ? `Deduplicate rows using key "${idCol}" (keep last)` : 'Remove exact duplicate rows',
      nodeType: 'transform.deduplicate',
      params: { keys: idCol ? [idCol] : dataset.columns, keep: 'last', caseSensitive: true },
      confidence: 'high',
      affectedRowCount: prof.summary.duplicateRowCount,
      informationLossRisk: 'medium',
      destructive: true,
      beforeAfterSamples: prof.duplicateRowIndices.slice(0, 3).map(idx => ({
        rowIndex: idx,
        before: JSON.stringify(rows[idx]),
        after: '(row removed)'
      }))
    });
  }

  for (const col of prof.columns) {
    // 2. Leading/trailing whitespace
    if (col.whitespaceIssueCount > 0) {
      proposals.push({
        id: `fix-trim-${col.name}`,
        issue: `${col.whitespaceIssueCount} value(s) in "${col.name}" have extra whitespace`,
        recommendedAction: `Trim leading/trailing whitespace in "${col.name}"`,
        nodeType: 'clean.text',
        params: { columns: [col.name], trim: true },
        confidence: 'high',
        affectedRowCount: col.whitespaceIssueCount,
        informationLossRisk: 'none',
        destructive: false,
        beforeAfterSamples: col.issueRowIndices.whitespace.slice(0, 3).map(idx => ({
          rowIndex: idx,
          column: col.name,
          before: JSON.stringify(rows[idx][col.name]),
          after: JSON.stringify(String(rows[idx][col.name]).trim())
        }))
      });
    }

    // 3. Mixed-case emails
    if (col.inferredType === 'email') {
      const upperRows = [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][col.name];
        if (typeof v === 'string' && v !== v.toLowerCase()) upperRows.push(i);
      }
      if (upperRows.length > 0) {
        proposals.push({
          id: `fix-lowercase-email-${col.name}`,
          issue: `${upperRows.length} email(s) in "${col.name}" use mixed/uppercase characters`,
          recommendedAction: `Normalize "${col.name}" to lowercase`,
          nodeType: 'clean.text',
          params: { columns: [col.name], trim: true, case: 'lower' },
          confidence: 'high',
          affectedRowCount: upperRows.length,
          informationLossRisk: 'none',
          destructive: false,
          beforeAfterSamples: upperRows.slice(0, 3).map(idx => ({
            rowIndex: idx,
            column: col.name,
            before: rows[idx][col.name],
            after: String(rows[idx][col.name]).trim().toLowerCase()
          }))
        });
      }
    }

    // 4. Non-ISO dates with explicit ambiguity check
    if (col.inferredType === 'date' && col.issueRowIndices.slashDates.length > 0) {
      const hasAmbiguity = col.ambiguousDateCount > 0;
      proposals.push({
        id: `fix-date-${col.name}`,
        issue: `${col.issueRowIndices.slashDates.length} non-ISO date(s) in "${col.name}"${hasAmbiguity ? ` (${col.ambiguousDateCount} ambiguous DD/MM vs MM/DD)` : ''}`,
        recommendedAction: hasAmbiguity
          ? `Review date locale before normalizing "${col.name}" to ISO-8601`
          : `Normalize "${col.name}" to ISO-8601 (YYYY-MM-DD)`,
        nodeType: 'clean.dateNormalize',
        params: { column: col.name, sourceOrder: 'MDY', targetFormat: 'ISO-8601', invalidPolicy: 'keep' },
        confidence: hasAmbiguity ? 'low' : 'high',
        affectedRowCount: col.issueRowIndices.slashDates.length,
        informationLossRisk: hasAmbiguity ? 'high' : 'low',
        destructive: false,
        beforeAfterSamples: col.issueRowIndices.slashDates.slice(0, 3).map(idx => {
          const raw = String(rows[idx][col.name]).trim();
          const m = raw.match(REGEX_SLASH_DATE);
          const preview = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : raw;
          return { rowIndex: idx, column: col.name, before: raw, after: preview + (hasAmbiguity ? ' (verify MDY vs DMY)' : '') };
        })
      });
    }

    // 5. PII masking suggestion
    if (col.pii) {
      proposals.push({
        id: `fix-pii-${col.name}`,
        issue: `Suspected PII (${col.pii.piiType}) detected in "${col.name}"`,
        recommendedAction: `Mask "${col.name}" locally using PII Sentinel`,
        nodeType: 'clean.piiMask',
        params: { columns: [col.name], strategy: 'mask' },
        confidence: col.pii.confidence,
        affectedRowCount: col.pii.matchCount,
        informationLossRisk: 'high',
        destructive: true,
        beforeAfterSamples: col.pii.samples.slice(0, 3).map(s => ({
          column: col.name,
          before: s,
          after: maskPiiValue(s, 'mask')
        }))
      });
    }
  }

  return proposals;
}

/**
 * Explain This Dataset (Section 2 Innovation L).
 * All inferences are explicitly tagged as heuristic guesses with confidence levels.
 */
export function explainDataset(dataset, profile = null) {
  const prof = profile || profileDataset(dataset);
  const columnExplanations = prof.columns.map(col => {
    let semanticGuess = 'General text attribute';
    let confidence = 'low';

    if (col.isLikelyId) {
      semanticGuess = 'Primary or Entity Identifier (ID)';
      confidence = 'high';
    } else if (col.inferredType === 'email') {
      semanticGuess = 'Contact Email Address (PII)';
      confidence = 'high';
    } else if (col.inferredType === 'date') {
      semanticGuess = 'Timestamp / Calendar Date';
      confidence = col.typeConfidence > 0.85 ? 'high' : 'medium';
    } else if (col.inferredType === 'currency' || /(price|amount|total|revenue|cost|salary)/i.test(col.name)) {
      semanticGuess = 'Monetary Amount / Financial Metric';
      confidence = 'medium';
    } else if (col.inferredType === 'phone') {
      semanticGuess = 'Telephone Number (PII)';
      confidence = 'medium';
    } else if (col.uniqueness < 0.15 && col.uniqueCount <= 15 && prof.summary.rowCount >= 10) {
      semanticGuess = `Categorical Status / Dimension (${col.uniqueCount} distinct values)`;
      confidence = 'high';
    } else if (col.inferredType === 'integer' || col.inferredType === 'float') {
      semanticGuess = 'Quantitative Numeric Measure';
      confidence = 'medium';
    }

    return {
      column: col.name,
      inferredType: col.inferredType,
      semanticGuess,
      confidence,
      isHeuristic: true
    };
  });

  // Detect high-duplication columns & potential functional associations
  const highlyRepeatedColumns = prof.columns
    .filter(c => c.uniqueness < 0.2 && prof.summary.rowCount >= 5)
    .map(c => ({ column: c.name, uniqueCount: c.uniqueCount, topValue: c.topValues[0]?.value ?? null }));

  const idCandidates = prof.columns.filter(c => c.isLikelyId).map(c => c.name);
  const dateCandidates = prof.columns.filter(c => c.inferredType === 'date').map(c => c.name);
  const currencyCandidates = prof.columns.filter(c => c.inferredType === 'currency' || /(price|amount|total|revenue|cost)/i.test(c.name)).map(c => c.name);

  const risks = prof.issues
    .filter(i => i.severity === 'error' || i.severity === 'warning')
    .slice(0, 8)
    .map(i => `${i.column ? `[${i.column}] ` : ''}${i.message}`);

  return {
    disclaimer: 'All semantic labels and structural observations are statistical guesses with confidence levels, not verified business facts.',
    overview: `Dataset has ${prof.summary.rowCount} row(s) and ${prof.summary.columnCount} column(s). Completeness: ${(prof.summary.completeness * 100).toFixed(1)}%, Validity: ${(prof.summary.validity * 100).toFixed(1)}%, Consistency: ${(prof.summary.consistency * 100).toFixed(1)}%.`,
    idCandidates,
    dateCandidates,
    currencyCandidates,
    highlyRepeatedColumns,
    columnExplanations,
    qualityRisks: risks
  };
}


/**
 * OpenRefine-style Key-Collision Fingerprint (lowercase, trim, strip punctuation, sort unique tokens).
 */
export function textFingerprint(str) {
  const tokens = String(str ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Array.from(new Set(tokens)).sort().join(' ');
}

function editDistance(a, b, maxDist = 2) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length;
  const n = b.length;
  const dp = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = dp[0];
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return dp[n];
}

/**
 * Detect fuzzy text clusters (Fingerprint + optional Levenshtein) for OpenRefine-style 1-click merging.
 */
export function detectTextClusters(dataset, column, options = {}) {
  const method = options.method || 'both'; // fingerprint | levenshtein | both
  const maxDistance = options.maxDistance ?? 2;
  const minLength = options.minLength ?? 4;

  const freq = new Map();
  if (dataset?.isDataHandle && dataset._columnar) {
    const t = dataset._columnar;
    const vec = t.getColumn(column);
    if (!vec) return [];
    const sel = t.selection;
    for (let i = 0; i < t.rowCount; i++) {
      const v = vec.get(sel ? sel[i] : i);
      if (isNullish(v)) continue;
      const s = String(v);
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  } else {
    for (const r of dataset.rows || []) {
      const v = r[column];
      if (isNullish(v)) continue;
      const s = String(v);
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  }

  // Phase 1: Fingerprint buckets
  const fpBuckets = new Map();
  for (const [val, count] of freq.entries()) {
    const fp = textFingerprint(val);
    if (!fp) continue;
    if (!fpBuckets.has(fp)) fpBuckets.set(fp, []);
    fpBuckets.get(fp).push({ value: val, count });
  }

  const clusters = [];
  const clusteredValues = new Set();

  if (method === 'fingerprint' || method === 'both') {
    for (const [fp, items] of fpBuckets.entries()) {
      if (items.length < 2) continue;
      items.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      const canonical = items[0].value.trim();
      const totalAffected = items.filter(x => x.value !== canonical).reduce((a, b) => a + b.count, 0);
      if (totalAffected > 0) {
        clusters.push({ method: 'fingerprint', key: fp, canonical, variants: items, totalAffected });
        items.forEach(x => clusteredValues.add(x.value));
      }
    }
  }

  // Phase 2: Levenshtein clustering on remaining distinct values (bounded to 500 unique strings for speed)
  if (method === 'levenshtein' || method === 'both') {
    const remaining = Array.from(freq.entries())
      .filter(([v]) => !clusteredValues.has(v) && v.trim().length >= minLength)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500);

    const used = new Set();
    for (let i = 0; i < remaining.length; i++) {
      const [baseVal, baseCount] = remaining[i];
      if (used.has(baseVal)) continue;
      const baseLower = baseVal.trim().toLowerCase();
      const group = [{ value: baseVal, count: baseCount }];
      for (let j = i + 1; j < remaining.length; j++) {
        const [candVal, candCount] = remaining[j];
        if (used.has(candVal)) continue;
        const candLower = candVal.trim().toLowerCase();
        if (editDistance(baseLower, candLower, maxDistance) <= maxDistance) {
          group.push({ value: candVal, count: candCount });
          used.add(candVal);
        }
      }
      if (group.length >= 2) {
        used.add(baseVal);
        const canonical = group[0].value.trim();
        const totalAffected = group.filter(x => x.value !== canonical).reduce((a, b) => a + b.count, 0);
        if (totalAffected > 0) {
          clusters.push({ method: 'levenshtein', key: baseLower, canonical, variants: group, totalAffected });
        }
      }
    }
  }

  return clusters;
}
