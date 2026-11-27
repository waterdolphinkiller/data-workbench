/**
 * @module @data-workbench/diff-engine
 * CSV Primary-Key / Composite-Key / Row-Hash Diff & JSON Path/Value/Array Diff + Safe Report Exporters.
 */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeKeyPart(val, normalize = {}) {
  let s = val === null || val === undefined ? '' : String(val);
  if (normalize.trim !== false) s = s.trim();
  if (normalize.lowercase) s = s.toLowerCase();
  return s;
}

/**
 * Compare two tabular datasets by single key, composite key, or row-content hash fallback.
 * @param {{ columns: string[], rows: Record<string, any>[] }} left
 * @param {{ columns: string[], rows: Record<string, any>[] }} right
 * @param {object} options
 */
export function diffTables(left, right, options = {}) {
  const keys = Array.isArray(options.keys) ? options.keys.filter(Boolean) : (options.key ? [options.key] : []);
  const normalize = options.normalize ?? { trim: true, lowercase: false };
  const allColumns = Array.from(new Set([...(left.columns || []), ...(right.columns || [])]));

  // Fallback to row-content hash when no primary key is given
  if (keys.length === 0) {
    const leftMap = new Map();
    const rightMap = new Map();
    const leftRows = left.rows || [];
    const rightRows = right.rows || [];

    leftRows.forEach((r, idx) => {
      const sig = JSON.stringify(allColumns.map(c => r[c] ?? null));
      if (!leftMap.has(sig)) leftMap.set(sig, []);
      leftMap.get(sig).push({ rowIndex: idx, row: r });
    });
    rightRows.forEach((r, idx) => {
      const sig = JSON.stringify(allColumns.map(c => r[c] ?? null));
      if (!rightMap.has(sig)) rightMap.set(sig, []);
      rightMap.get(sig).push({ rowIndex: idx, row: r });
    });

    const added = [];
    const removed = [];
    const unchanged = [];

    for (const [sig, items] of rightMap.entries()) {
      const lItems = leftMap.get(sig) || [];
      if (lItems.length === 0) {
        items.forEach(it => added.push({ key: sig.slice(0, 32), row: it.row }));
      } else {
        const common = Math.min(items.length, lItems.length);
        for (let i = 0; i < common; i++) unchanged.push({ key: sig.slice(0, 32), row: items[i].row });
        for (let i = common; i < items.length; i++) added.push({ key: sig.slice(0, 32), row: items[i].row });
      }
    }
    for (const [sig, items] of leftMap.entries()) {
      const rItems = rightMap.get(sig) || [];
      if (rItems.length < items.length) {
        for (let i = rItems.length; i < items.length; i++) removed.push({ key: sig.slice(0, 32), row: items[i].row });
      }
    }

    return {
      mode: 'row-hash',
      warning: 'No primary key specified — using row-content hash comparison. Field-level entity updates appear as remove + add.',
      keys: [],
      columns: allColumns,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: 0,
        unchanged: unchanged.length,
        duplicateKeys: 0,
        missingKeys: 0
      },
      added,
      removed,
      changed: [],
      unchanged,
      duplicateKeys: [],
      missingKeys: []
    };
  }

  const buildIndex = (rows, side) => {
    const map = new Map();
    const duplicateKeys = [];
    const missingKeys = [];

    rows.forEach((row, rowIndex) => {
      const parts = keys.map(k => normalizeKeyPart(row[k], normalize));
      if (parts.some(p => p === '')) {
        missingKeys.push({ side, rowIndex, row });
        return;
      }
      const compositeKey = parts.join('||');
      if (map.has(compositeKey)) {
        duplicateKeys.push({ side, key: compositeKey, rowIndex });
      }
      map.set(compositeKey, { rowIndex, row });
    });
    return { map, duplicateKeys, missingKeys };
  };

  const leftIdx = buildIndex(left.rows || [], 'left');
  const rightIdx = buildIndex(right.rows || [], 'right');

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [k, rEntry] of rightIdx.map.entries()) {
    if (!leftIdx.map.has(k)) {
      added.push({ key: k, row: rEntry.row });
    } else {
      const lEntry = leftIdx.map.get(k);
      const cellChanges = [];
      for (const col of allColumns) {
        const before = lEntry.row[col] ?? null;
        const after = rEntry.row[col] ?? null;
        if (String(before ?? '') !== String(after ?? '')) {
          cellChanges.push({ column: col, before, after });
        }
      }
      if (cellChanges.length > 0) {
        changed.push({ key: k, changes: cellChanges, before: lEntry.row, after: rEntry.row });
      } else {
        unchanged.push({ key: k, row: rEntry.row });
      }
    }
  }

  for (const [k, lEntry] of leftIdx.map.entries()) {
    if (!rightIdx.map.has(k)) {
      removed.push({ key: k, row: lEntry.row });
    }
  }

  const duplicateKeys = [...leftIdx.duplicateKeys, ...rightIdx.duplicateKeys];
  const missingKeys = [...leftIdx.missingKeys, ...rightIdx.missingKeys];

  return {
    mode: 'primary-key',
    warning: duplicateKeys.length > 0 ? `${duplicateKeys.length} duplicate key(s) detected; last occurrence used.` : null,
    keys,
    columns: allColumns,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
      duplicateKeys: duplicateKeys.length,
      missingKeys: missingKeys.length
    },
    added,
    removed,
    changed,
    unchanged,
    duplicateKeys,
    missingKeys
  };
}

/**
 * JSON Path-level, Value-level, and Array-level Diff (Section 7.2).
 * Options: ignorePaths (string[]), ignoreArrayOrder (boolean), numericTolerance (number).
 */
export function diffJson(left, right, options = {}) {
  const ignorePaths = new Set(options.ignorePaths || []);
  const ignoreArrayOrder = Boolean(options.ignoreArrayOrder);
  const numericTolerance = typeof options.numericTolerance === 'number' ? options.numericTolerance : 0;
  const diffs = [];

  function walk(a, b, path) {
    if (ignorePaths.has(path)) return;
    if (a === b) return;

    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) <= numericTolerance) return;
      diffs.push({ path, kind: 'changed', before: a, after: b });
      return;
    }

    const typeA = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const typeB = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;

    if (typeA !== typeB) {
      diffs.push({ path, kind: 'typeChanged', beforeType: typeA, afterType: typeB, before: a, after: b });
      return;
    }

    if (typeA === 'array') {
      const arrA = ignoreArrayOrder ? [...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : a;
      const arrB = ignoreArrayOrder ? [...b].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : b;
      const maxLen = Math.max(arrA.length, arrB.length);
      for (let i = 0; i < maxLen; i++) {
        const itemPath = `${path}[${i}]`;
        if (i >= arrA.length) {
          diffs.push({ path: itemPath, kind: 'added', before: undefined, after: arrB[i] });
        } else if (i >= arrB.length) {
          diffs.push({ path: itemPath, kind: 'removed', before: arrA[i], after: undefined });
        } else {
          walk(arrA[i], arrB[i], itemPath);
        }
      }
      return;
    }

    if (typeA === 'object') {
      const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
      for (const k of keys) {
        const childPath = path === '$' ? `$.${k}` : `${path}.${k}`;
        if (ignorePaths.has(childPath)) continue;
        if (!(k in a)) {
          diffs.push({ path: childPath, kind: 'added', before: undefined, after: b[k] });
        } else if (!(k in b)) {
          diffs.push({ path: childPath, kind: 'removed', before: a[k], after: undefined });
        } else {
          walk(a[k], b[k], childPath);
        }
      }
      return;
    }

    diffs.push({ path, kind: 'changed', before: a, after: b });
  }

  walk(left, right, '$');

  return {
    summary: {
      totalDiffs: diffs.length,
      added: diffs.filter(d => d.kind === 'added').length,
      removed: diffs.filter(d => d.kind === 'removed').length,
      changed: diffs.filter(d => d.kind === 'changed').length,
      typeChanged: diffs.filter(d => d.kind === 'typeChanged').length
    },
    diffs
  };
}

/**
 * Format table or JSON diff report to Markdown or XSS-safe HTML.
 */
export function formatDiffReport(diffResult, format = 'markdown') {
  if (format === 'json') return JSON.stringify(diffResult, null, 2);

  const isTable = 'mode' in diffResult;
  if (format === 'markdown') {
    if (isTable) {
      const s = diffResult.summary;
      const lines = [
        `# Table Diff Report (${diffResult.mode})`,
        diffResult.keys.length ? `**Primary Key:** \`${diffResult.keys.join(', ')}\`` : '**Mode:** Row Hash Fallback',
        '',
        `| Added | Removed | Changed | Unchanged | Duplicate Keys | Missing Keys |`,
        `|---:|---:|---:|---:|---:|---:|`,
        `| ${s.added} | ${s.removed} | ${s.changed} | ${s.unchanged} | ${s.duplicateKeys} | ${s.missingKeys} |`,
        ''
      ];
      if (diffResult.changed.length > 0) {
        lines.push('## Changed Rows');
        for (const c of diffResult.changed.slice(0, 50)) {
          const detail = c.changes.map(ch => `${ch.column}: \`${ch.before}\` → \`${ch.after}\``).join('; ');
          lines.push(`- **${c.key}**: ${detail}`);
        }
      }
      return lines.join('\n');
    } else {
      const s = diffResult.summary;
      const lines = [
        '# JSON Diff Report',
        `- Added: ${s.added} | Removed: ${s.removed} | Changed: ${s.changed} | Type Changed: ${s.typeChanged}`,
        ''
      ];
      for (const d of diffResult.diffs.slice(0, 100)) {
        lines.push(`- \`${d.path}\` (**${d.kind}**): ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`);
      }
      return lines.join('\n');
    }
  }

  // XSS-safe HTML report
  const title = isTable ? 'Data Workbench — Table Diff Report' : 'Data Workbench — JSON Diff Report';
  const rowsHtml = isTable
    ? diffResult.changed.slice(0, 100).map(c =>
        `<tr><td>${escapeHtml(c.key)}</td><td>Changed</td><td>${c.changes.map(ch => `<strong>${escapeHtml(ch.column)}</strong>: ${escapeHtml(ch.before)} &rarr; ${escapeHtml(ch.after)}`).join('<br>')}</td></tr>`
      ).join('')
    : diffResult.diffs.slice(0, 200).map(d =>
        `<tr><td><code>${escapeHtml(d.path)}</code></td><td>${escapeHtml(d.kind)}</td><td>${escapeHtml(JSON.stringify(d.before))} &rarr; ${escapeHtml(JSON.stringify(d.after))}</td></tr>`
      ).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#111318;color:#e4e7ec;padding:24px;}table{border-collapse:collapse;width:100%;margin-top:16px;}th,td{border:1px solid #2b303b;padding:8px 10px;text-align:left;font-size:13px;}th{background:#1b1f27;}</style>
</head><body><h1>${title}</h1><pre>${escapeHtml(JSON.stringify(diffResult.summary, null, 2))}</pre>
<table><thead><tr><th>Key / Path</th><th>Kind</th><th>Details</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
}
