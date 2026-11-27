/**
 * @module @data-workbench/ai-api
 * AI-Native Ergonomics Layer for MCP Server, Local OpenAPI REST Server, and CLI:
 *  - Fuzzy node alias resolution & Levenshtein didYouMean suggestions
 *  - Structured self-healing error envelopes ({ ok: false, error: { code, message, hint, didYouMean } })
 *  - Column name typo recovery
 *  - Token-budget-aware compact response truncation
 */

import { listNodes, getNodeDefinition } from '../node-registry/index.js';

export const NODE_ALIASES = {
  csv: 'source.csv',
  json: 'source.json',
  ndjson: 'source.ndjson',
  yaml: 'source.yaml',
  xml: 'source.xml',
  xlsx: 'source.xlsx',
  excel: 'source.xlsx',
  parquet: 'source.parquet',
  trim: 'clean.text',
  lowercase: 'clean.text',
  uppercase: 'clean.text',
  clean_text: 'clean.text',
  date: 'clean.dateNormalize',
  normalize_date: 'clean.dateNormalize',
  dates: 'clean.dateNormalize',
  pii: 'clean.piiMask',
  mask: 'clean.piiMask',
  mask_pii: 'clean.piiMask',
  fill_nulls: 'clean.fillNulls',
  cluster: 'clean.clusterMerge',
  cluster_merge: 'clean.clusterMerge',
  fuzzy_merge: 'clean.clusterMerge',
  dedupe: 'transform.deduplicate',
  deduplicate: 'transform.deduplicate',
  remove_duplicates: 'transform.deduplicate',
  filter: 'transform.filter',
  sort: 'transform.sort',
  rename: 'transform.renameColumns',
  select: 'transform.selectColumns',
  flatten: 'transform.flatten',
  unflatten: 'transform.unflatten',
  jsonpath: 'transform.jsonPath',
  sql: 'transform.sqlQuery',
  query: 'transform.sqlQuery',
  merge: 'transform.merge',
  join: 'transform.merge',
  profile: 'validate.qualityProfile',
  quality: 'validate.qualityProfile',
  contract: 'validate.dataContract',
  schema: 'validate.jsonSchema',
  csv_diff: 'compare.csvDiff',
  diff: 'compare.csvDiff',
  json_diff: 'compare.jsonDiff',
  export_csv: 'output.csv',
  export_json: 'output.json',
  export_ndjson: 'output.ndjson',
  export_yaml: 'output.yaml',
  export_xlsx: 'output.xlsx',
  export_excel: 'output.xlsx'
};

export function levenshtein(a, b) {
  const s = String(a).toLowerCase();
  const t = String(b).toLowerCase();
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function findClosestMatches(input, candidates, limit = 3) {
  const query = String(input || '').toLowerCase();
  if (!query) return candidates.slice(0, limit);
  return candidates
    .map(cand => {
      const lower = cand.toLowerCase();
      const containsBonus = lower.includes(query) || query.includes(lower) ? -3 : 0;
      return { cand, score: levenshtein(query, lower) + containsBonus };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(x => x.cand);
}

/**
 * Resolve exact node type OR fuzzy AI alias (e.g. "dedupe" -> "transform.deduplicate").
 */
export function resolveNodeTypeFuzzy(rawType) {
  const key = String(rawType || '').trim();
  if (getNodeDefinition(key)) {
    return { resolved: key, aliased: false, didYouMean: [] };
  }
  const lower = key.toLowerCase().replace(/[\s-]+/g, '_');
  if (NODE_ALIASES[lower] && getNodeDefinition(NODE_ALIASES[lower])) {
    return { resolved: NODE_ALIASES[lower], aliased: true, original: key, didYouMean: [] };
  }
  const allTypes = listNodes().map(n => n.type);
  const didYouMean = findClosestMatches(key, allTypes, 3);
  return { resolved: null, aliased: false, didYouMean };
}

/**
 * Validate column references in node params and return structured recovery hints if misspelled.
 */
export function checkColumnReferences(params, availableColumns) {
  if (!params || !availableColumns || availableColumns.length === 0) return null;
  const colSet = new Set(availableColumns);
  const refs = [];
  if (typeof params.column === 'string' && params.column) refs.push(params.column);
  if (Array.isArray(params.columns)) refs.push(...params.columns.filter(Boolean));
  if (Array.isArray(params.keys)) refs.push(...params.keys.filter(Boolean));

  const missing = refs.filter(c => !colSet.has(c));
  if (missing.length === 0) return null;

  const suggestions = {};
  for (const m of missing) {
    suggestions[m] = findClosestMatches(m, availableColumns, 3);
  }
  return makeStructuredError(
    'COLUMN_NOT_FOUND',
    `Column(s) not found in dataset: ${missing.join(', ')}.`,
    {
      didYouMean: suggestions,
      availableColumns,
      hint: `Replace misspelled column names with exact matches from availableColumns.`
    }
  );
}

/**
 * Structured AI-recoverable error envelope.
 */
export function makeStructuredError(code, message, extras = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extras
    }
  };
}

/**
 * Token-budget-aware compact payload formatter to protect Agent context windows.
 */
export function compactPayload(data, options = {}) {
  const maxArrayItems = options.maxArrayItems ?? 15;
  const maxStringLength = options.maxStringLength ?? 300;
  const maxDepth = options.maxDepth ?? 6;

  function trim(val, depth) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      return val.length > maxStringLength ? val.slice(0, maxStringLength) + `… (+${val.length - maxStringLength} chars)` : val;
    }
    if (typeof val !== 'object') return val;
    if (depth >= maxDepth) return '[nested-truncated]';
    if (Array.isArray(val)) {
      if (val.length > maxArrayItems) {
        return {
          items: val.slice(0, maxArrayItems).map(v => trim(v, depth + 1)),
          truncated: true,
          totalCount: val.length
        };
      }
      return val.map(v => trim(v, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = trim(v, depth + 1);
    }
    return out;
  }

  return trim(data, 0);
}

/**
 * List node catalog enriched with AI aliases for self-discovery (`list_nodes` & `/v1/nodes`).
 */
export function getAiNodeCatalog(category = null) {
  const reverseAliases = new Map();
  for (const [alias, target] of Object.entries(NODE_ALIASES)) {
    if (!reverseAliases.has(target)) reverseAliases.set(target, []);
    reverseAliases.get(target).push(alias);
  }
  let nodes = listNodes();
  if (category) {
    nodes = nodes.filter(n => n.category.toLowerCase() === String(category).toLowerCase());
  }
  return nodes.map(n => ({
    ...n,
    aliases: reverseAliases.get(n.type) || []
  }));
}
