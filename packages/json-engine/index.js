/**
 * @module @data-workbench/json-engine
 * JSON Formatter/Validator, NDJSON, Flatten/Unflatten, RFC 9535 JSONPath, YAML & XML codecs.
 */

/**
 * Validate JSON string with exact line/column error location and max depth guardrail.
 * @param {string} text
 * @param {object} options
 */
export function validateJson(text, options = {}) {
  const maxDepth = options.maxDepth ?? 64;
  const maxBytes = options.maxBytes ?? 50_000_000;
  if (typeof text !== 'string') {
    return { valid: false, error: 'Input must be a string.', line: 1, column: 1 };
  }
  if (text.length > maxBytes) {
    return { valid: false, error: `Input exceeds safety limit (${maxBytes} bytes).`, line: 1, column: 1 };
  }
  try {
    const data = JSON.parse(text);
    const depth = measureDepth(data, maxDepth + 1);
    if (depth > maxDepth) {
      return { valid: false, error: `JSON nesting depth exceeds limit (${maxDepth}).`, line: 1, column: 1 };
    }
    return {
      valid: true,
      data,
      depth,
      type: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
      itemCount: Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 1)
    };
  } catch (err) {
    const msg = err.message || 'Invalid JSON';
    const posMatch = msg.match(/position\s+(\d+)/i);
    let line = 1;
    let column = 1;
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const prefix = text.slice(0, pos);
      const lines = prefix.split('\n');
      line = lines.length;
      column = lines[lines.length - 1].length + 1;
    }
    return { valid: false, error: msg, line, column };
  }
}

function measureDepth(val, limit, current = 0) {
  if (current >= limit) return current;
  if (val === null || typeof val !== 'object') return current;
  if (Array.isArray(val)) {
    let max = current + 1;
    for (let i = 0; i < Math.min(val.length, 500); i++) {
      max = Math.max(max, measureDepth(val[i], limit, current + 1));
      if (max >= limit) return max;
    }
    return max;
  }
  let max = current + 1;
  for (const k of Object.keys(val)) {
    max = Math.max(max, measureDepth(val[k], limit, current + 1));
    if (max >= limit) return max;
  }
  return max;
}

/**
 * Format JSON (pretty or minified, optional deterministic key sorting).
 */
export function formatJson(input, options = {}) {
  const indent = options.minify ? 0 : (options.indent ?? 2);
  const sortKeys = Boolean(options.sortKeys);
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const normalized = sortKeys ? sortKeysDeep(data) : data;
  return JSON.stringify(normalized, null, indent);
}

function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val).sort()) {
      out[k] = sortKeysDeep(val[k]);
    }
    return out;
  }
  return val;
}

/**
 * Parse NDJSON (Newline-Delimited JSON) with per-line error tracking.
 */
export function parseNdjson(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      errors.push({ lineNumber: i + 1, error: err.message, raw: trimmed.slice(0, 120) });
    }
  }
  return { rows, errors };
}

export function serializeNdjson(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n');
}

/**
 * Flatten a nested object into dot/delimiter-separated keys.
 */
export function flattenObject(obj, options = {}) {
  const separator = options.separator ?? '.';
  const flattenArrays = options.flattenArrays ?? false;
  const maxDepth = options.maxDepth ?? 32;
  const result = {};

  function recurse(current, prefix, depth) {
    if (current === null || current === undefined || typeof current !== 'object' || depth >= maxDepth) {
      result[prefix] = current;
      return;
    }
    if (Array.isArray(current)) {
      if (!flattenArrays) {
        result[prefix] = JSON.stringify(current);
        return;
      }
      if (current.length === 0) {
        result[prefix] = '[]';
        return;
      }
      current.forEach((item, idx) => {
        const nextKey = prefix ? `${prefix}${separator}${idx}` : String(idx);
        recurse(item, nextKey, depth + 1);
      });
      return;
    }
    const keys = Object.keys(current);
    if (keys.length === 0) {
      result[prefix] = {};
      return;
    }
    for (const key of keys) {
      const nextKey = prefix ? `${prefix}${separator}${key}` : key;
      recurse(current[key], nextKey, depth + 1);
    }
  }

  recurse(obj, '', 0);
  return result;
}

/**
 * Unflatten a flat key-value object back into nested objects/arrays.
 */
export function unflattenObject(flatObj, options = {}) {
  const separator = options.separator ?? '.';
  const root = {};

  for (const [flatKey, value] of Object.entries(flatObj)) {
    const parts = flatKey.split(separator);
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const nextPart = parts[i + 1];
      const nextIsIndex = nextPart !== undefined && /^\d+$/.test(nextPart);

      if (isLast) {
        cursor[part] = value;
      } else {
        if (cursor[part] === undefined || typeof cursor[part] !== 'object' || cursor[part] === null) {
          cursor[part] = nextIsIndex ? [] : {};
        }
        cursor = cursor[part];
      }
    }
  }
  return root;
}

/**
 * Convert arbitrary JSON payload into tabular { columns, rows }.
 */
export function jsonToTabular(data, options = {}) {
  const flatten = options.flatten !== false;
  const separator = options.separator ?? '.';
  let list = data;

  if (!Array.isArray(list)) {
    if (list && typeof list === 'object') {
      // Auto-discover primary array property (e.g. { data: [...] }, { items: [...] }, { results: [...] })
      const arrayProp = Object.keys(list).find(k => Array.isArray(list[k]) && list[k].length > 0 && typeof list[k][0] === 'object');
      list = arrayProp ? list[arrayProp] : [list];
    } else {
      list = [{ value: list }];
    }
  }

  const colSet = new Set();
  const rows = list.map(item => {
    const rowObj = (item && typeof item === 'object' && !Array.isArray(item))
      ? (flatten ? flattenObject(item, { separator, flattenArrays: Boolean(options.flattenArrays) }) : { ...item })
      : { value: item };
    for (const k of Object.keys(rowObj)) colSet.add(k);
    return rowObj;
  });

  const columns = Array.from(colSet);
  // Normalize missing keys to null
  for (const r of rows) {
    for (const c of columns) {
      if (!(c in r)) r[c] = null;
    }
  }
  return { columns, rows };
}

/**
 * RFC 9535-compatible JSONPath evaluator.
 * Supports: $, .name, ['name'], [*], [index], [-index], [start:end:step], ..name, [?@.a == 1 && @.b != 'x']
 * @param {any} root
 * @param {string} expression
 * @returns {{ values: any[], paths: string[] }}
 */
export function queryJsonPath(root, expression) {
  const expr = String(expression ?? '').trim();
  if (!expr.startsWith('$')) {
    throw new Error('RFC 9535 JSONPath must start with "$".');
  }

  const segments = parseJsonPathSegments(expr.slice(1));
  let current = [{ value: root, path: '$' }];

  for (const seg of segments) {
    const next = [];
    for (const node of current) {
      const val = node.value;
      if (seg.type === 'descendant') {
        const collected = [];
        collectDescendants(val, node.path, collected);
        for (const desc of collected) {
          applySelector(desc, seg.selector, next);
        }
      } else {
        applySelector(node, seg, next);
      }
    }
    current = next;
  }

  return {
    values: current.map(n => n.value),
    paths: current.map(n => n.path)
  };
}

function collectDescendants(val, path, out) {
  out.push({ value: val, path });
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      collectDescendants(val[i], `${path}[${i}]`, out);
    }
  } else if (val && typeof val === 'object') {
    for (const k of Object.keys(val)) {
      collectDescendants(val[k], `${path}['${k.replace(/'/g, "\\'")}']`, out);
    }
  }
}

function applySelector(node, seg, out) {
  const val = node.value;
  if (val === null || typeof val !== 'object') return;

  if (seg.type === 'name') {
    if (!Array.isArray(val) && Object.prototype.hasOwnProperty.call(val, seg.name)) {
      out.push({ value: val[seg.name], path: `${node.path}['${seg.name.replace(/'/g, "\\'")}']` });
    }
  } else if (seg.type === 'wildcard') {
    if (Array.isArray(val)) {
      val.forEach((v, i) => out.push({ value: v, path: `${node.path}[${i}]` }));
    } else {
      Object.keys(val).forEach(k => out.push({ value: val[k], path: `${node.path}['${k.replace(/'/g, "\\'")}']` }));
    }
  } else if (seg.type === 'index') {
    if (Array.isArray(val)) {
      const idx = seg.index < 0 ? val.length + seg.index : seg.index;
      if (idx >= 0 && idx < val.length) {
        out.push({ value: val[idx], path: `${node.path}[${idx}]` });
      }
    }
  } else if (seg.type === 'slice') {
    if (Array.isArray(val)) {
      const len = val.length;
      const step = seg.step ?? 1;
      if (step === 0) return;
      const defaultStart = step > 0 ? 0 : len - 1;
      const defaultEnd = step > 0 ? len : -len - 1;
      let start = seg.start === null ? defaultStart : (seg.start < 0 ? Math.max(len + seg.start, 0) : Math.min(seg.start, len));
      let end = seg.end === null ? defaultEnd : (seg.end < 0 ? Math.max(len + seg.end, -1) : Math.min(seg.end, len));
      if (step > 0) {
        for (let i = start; i < end; i += step) {
          out.push({ value: val[i], path: `${node.path}[${i}]` });
        }
      } else {
        for (let i = start; i > end; i += step) {
          out.push({ value: val[i], path: `${node.path}[${i}]` });
        }
      }
    }
  } else if (seg.type === 'filter') {
    const items = Array.isArray(val)
      ? val.map((v, i) => ({ value: v, path: `${node.path}[${i}]` }))
      : Object.keys(val).map(k => ({ value: val[k], path: `${node.path}['${k.replace(/'/g, "\\'")}']` }));
    for (const item of items) {
      if (evaluateFilter(item.value, seg.expr)) {
        out.push(item);
      }
    }
  }
}

function parseJsonPathSegments(str) {
  const segs = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '.' && str[i + 1] === '.') {
      i += 2;
      if (str[i] === '*') {
        segs.push({ type: 'descendant', selector: { type: 'wildcard' } });
        i += 1;
      } else if (str[i] === '[') {
        const end = findClosingBracket(str, i);
        const inner = str.slice(i + 1, end).trim();
        segs.push({ type: 'descendant', selector: parseBracketSelector(inner) });
        i = end + 1;
      } else {
        const start = i;
        while (i < str.length && !'.['.includes(str[i])) i++;
        segs.push({ type: 'descendant', selector: { type: 'name', name: str.slice(start, i) } });
      }
    } else if (str[i] === '.') {
      i += 1;
      if (str[i] === '*') {
        segs.push({ type: 'wildcard' });
        i += 1;
      } else {
        const start = i;
        while (i < str.length && !'.['.includes(str[i])) i++;
        segs.push({ type: 'name', name: str.slice(start, i) });
      }
    } else if (str[i] === '[') {
      const end = findClosingBracket(str, i);
      const inner = str.slice(i + 1, end).trim();
      segs.push(parseBracketSelector(inner));
      i = end + 1;
    } else {
      throw new Error(`Unexpected token "${str[i]}" in JSONPath at position ${i + 1}.`);
    }
  }
  return segs;
}

function findClosingBracket(str, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  throw new Error('Unclosed "[" in JSONPath expression.');
}

function parseBracketSelector(inner) {
  if (inner === '*') return { type: 'wildcard' };
  if (inner.startsWith('?')) return { type: 'filter', expr: inner.slice(1).trim() };
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    return { type: 'name', name: inner.slice(1, -1) };
  }
  if (inner.includes(':')) {
    const [s, e, st] = inner.split(':').map(p => (p.trim() === '' ? null : Number(p.trim())));
    return { type: 'slice', start: s, end: e, step: st ?? 1 };
  }
  if (/^-?\d+$/.test(inner)) {
    return { type: 'index', index: Number(inner) };
  }
  throw new Error(`Unsupported JSONPath bracket selector: [${inner}]`);
}

function evaluateFilter(item, expr) {
  // Split by || then && (safe deterministic evaluator without eval/Function!)
  const orParts = expr.split(/\s*\|\|\s*/);
  return orParts.some(orPart => {
    const andParts = orPart.split(/\s*&&\s*/);
    return andParts.every(cond => evaluateAtomicCondition(item, cond.trim()));
  });
}

function evaluateAtomicCondition(item, cond) {
  const match = cond.match(/^(@\.[a-zA-Z0-9_.\[\]'"]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    // Existence check: @.field
    if (cond.startsWith('@.')) {
      const v = resolveRelativePath(item, cond.slice(2));
      return v !== undefined && v !== null && v !== false;
    }
    return false;
  }
  const [, leftPath, op, rightRaw] = match;
  const leftVal = resolveRelativePath(item, leftPath.slice(2));
  const rightVal = parseLiteral(rightRaw.trim());

  switch (op) {
    case '==': return leftVal === rightVal;
    case '!=': return leftVal !== rightVal;
    case '>': return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal > rightVal;
    case '<': return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal < rightVal;
    case '>=': return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal >= rightVal;
    case '<=': return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal <= rightVal;
    default: return false;
  }
}

function resolveRelativePath(obj, pathStr) {
  let cur = obj;
  for (const part of pathStr.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function parseLiteral(raw) {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Lightweight YAML serializer (clean block-style YAML).
 */
export function serializeYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value === '' || /[:#\n\r\t{}[\],&*?|<>=!%@`]|^\s|\s$/.test(value) || /^(true|false|null|\d+(\.\d+)?)$/i.test(value)) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const inner = serializeYaml(item, indent + 1).trimStart();
        return `${pad}- ${inner}`;
      }
      return `${pad}- ${serializeYaml(item, indent + 1)}`;
    }).join('\n');
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return keys.map(k => {
    const v = value[k];
    if (v && typeof v === 'object' && ((Array.isArray(v) && v.length > 0) || (!Array.isArray(v) && Object.keys(v).length > 0))) {
      return `${pad}${k}:\n${serializeYaml(v, indent + 1)}`;
    }
    return `${pad}${k}: ${serializeYaml(v, indent + 1)}`;
  }).join('\n');
}

/**
 * Lightweight YAML parser supporting nested mappings, sequences, and scalars.
 */
export function parseYaml(text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  const lines = [];
  for (const l of rawLines) {
    const stripped = l.replace(/\s+#.*$/, '');
    if (stripped.trim() === '' || stripped.trim().startsWith('#') || stripped.trim() === '---') continue;
    const indent = stripped.match(/^ */)[0].length;
    lines.push({ indent, content: stripped.trim() });
  }
  if (lines.length === 0) return null;

  let idx = 0;
  function parseBlock(minIndent) {
    if (idx >= lines.length) return null;
    if (lines[idx].content.startsWith('- ')) {
      const arr = [];
      const seqIndent = lines[idx].indent;
      while (idx < lines.length && lines[idx].indent === seqIndent && lines[idx].content.startsWith('- ')) {
        const rest = lines[idx].content.slice(2).trim();
        idx++;
        if (rest === '') {
          arr.push(parseBlock(seqIndent + 1));
        } else if (rest.includes(': ')) {
          const [k, ...vParts] = rest.split(': ');
          const obj = { [k.trim()]: parseYamlScalar(vParts.join(': ').trim()) };
          while (idx < lines.length && lines[idx].indent > seqIndent) {
            const subLine = lines[idx];
            const colonIdx = subLine.content.indexOf(':');
            if (colonIdx > 0) {
              const sk = subLine.content.slice(0, colonIdx).trim();
              const sv = subLine.content.slice(colonIdx + 1).trim();
              idx++;
              obj[sk] = sv === '' ? parseBlock(subLine.indent + 1) : parseYamlScalar(sv);
            } else {
              break;
            }
          }
          arr.push(obj);
        } else {
          arr.push(parseYamlScalar(rest));
        }
      }
      return arr;
    }

    const obj = {};
    const mapIndent = lines[idx].indent;
    while (idx < lines.length && lines[idx].indent === mapIndent && !lines[idx].content.startsWith('- ')) {
      const line = lines[idx];
      const colonIdx = line.content.indexOf(':');
      if (colonIdx === -1) {
        idx++;
        continue;
      }
      const key = line.content.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
      const valStr = line.content.slice(colonIdx + 1).trim();
      idx++;
      if (valStr === '') {
        obj[key] = (idx < lines.length && lines[idx].indent > mapIndent) ? parseBlock(mapIndent + 1) : null;
      } else {
        obj[key] = parseYamlScalar(valStr);
      }
    }
    return obj;
  }

  return parseBlock(0);
}

function parseYamlScalar(s) {
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Lightweight XML parser (tag/attribute/text/array) & serializer.
 */
export function parseXml(xmlText) {
  const cleaned = String(xmlText ?? '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  let pos = 0;

  function parseElement() {
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos++;
    if (cleaned[pos] !== '<') return null;
    const tagEnd = cleaned.indexOf('>', pos);
    if (tagEnd === -1) throw new Error('Malformed XML: unclosed tag.');
    const rawTag = cleaned.slice(pos + 1, tagEnd).trim();
    const selfClosing = rawTag.endsWith('/');
    const tagBody = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const parts = tagBody.match(/^([^\s/]+)([\s\S]*)$/);
    const tagName = parts[1];
    const attrStr = parts[2] || '';
    const attrs = {};
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRegex.exec(attrStr)) !== null) {
      attrs[`@${m[1]}`] = unescapeXml(m[2] ?? m[3] ?? '');
    }
    pos = tagEnd + 1;
    if (selfClosing) return { name: tagName, value: Object.keys(attrs).length ? attrs : '' };

    const children = {};
    let textContent = '';
    while (pos < cleaned.length) {
      if (cleaned.startsWith(`</${tagName}`, pos)) {
        const closeEnd = cleaned.indexOf('>', pos);
        pos = closeEnd + 1;
        break;
      }
      if (cleaned.startsWith('<![CDATA[', pos)) {
        const cEnd = cleaned.indexOf(']]>', pos);
        textContent += cleaned.slice(pos + 9, cEnd);
        pos = cEnd + 3;
        continue;
      }
      if (cleaned[pos] === '<') {
        const child = parseElement();
        if (child) {
          if (child.name in children) {
            if (!Array.isArray(children[child.name])) children[child.name] = [children[child.name]];
            children[child.name].push(child.value);
          } else {
            children[child.name] = child.value;
          }
        }
      } else {
        const nextTag = cleaned.indexOf('<', pos);
        textContent += cleaned.slice(pos, nextTag === -1 ? cleaned.length : nextTag);
        pos = nextTag === -1 ? cleaned.length : nextTag;
      }
    }

    const trimmedText = unescapeXml(textContent.trim());
    const hasChildren = Object.keys(children).length > 0;
    const hasAttrs = Object.keys(attrs).length > 0;

    if (!hasChildren && !hasAttrs) {
      return { name: tagName, value: parseYamlScalar(trimmedText) };
    }
    const obj = { ...attrs, ...children };
    if (trimmedText) obj['#text'] = trimmedText;
    return { name: tagName, value: obj };
  }

  const root = parseElement();
  return root ? { [root.name]: root.value } : {};
}

export function serializeXml(obj, rootName = 'root', indent = 0) {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return `${pad}<${rootName}/>`;
  if (typeof obj !== 'object') {
    return `${pad}<${rootName}>${escapeXml(String(obj))}</${rootName}>`;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => serializeXml(item, rootName, indent)).join('\n');
  }
  const attrs = [];
  const children = [];
  let text = '';
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) attrs.push(`${k.slice(1)}="${escapeXml(String(v))}"`);
    else if (k === '#text') text = escapeXml(String(v));
    else children.push(serializeXml(v, k, indent + 1));
  }
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (children.length === 0) {
    return `${pad}<${rootName}${attrStr}>${text}</${rootName}>`;
  }
  return `${pad}<${rootName}${attrStr}>\n${children.join('\n')}\n${pad}</${rootName}>`;
}

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescapeXml(s) {
  return String(s).replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
