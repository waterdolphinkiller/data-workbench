/**
 * @module @data-workbench/workflow-schema
 * Workflow JSON v1.0 validation, JSON Schema 2020-12 generator/validator,
 * Schema Guardian (Snapshot & Drift / Breaking Change detection), and Data Contract validation.
 */

const REGEX_EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const REGEX_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGEX_URI = /^https?:\/\/[^\s]+$/i;

/**
 * Validate Workflow JSON v1.0 definition including DAG acyclicity check.
 */
export function validateWorkflowDefinition(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['Workflow definition must be a JSON object.'] };
  }
  if (doc.schemaVersion !== '1.0') {
    errors.push(`Unsupported schemaVersion "${doc.schemaVersion}". Expected "1.0".`);
  }
  const wf = doc.workflow;
  if (!wf || typeof wf !== 'object') {
    errors.push('Missing "workflow" object.');
    return { valid: false, errors };
  }
  if (!wf.id || typeof wf.id !== 'string') errors.push('workflow.id must be a non-empty string.');
  if (!wf.name || typeof wf.name !== 'string') errors.push('workflow.name must be a non-empty string.');
  if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) errors.push('workflow.nodes must be a non-empty array.');
  if (!Array.isArray(wf.edges)) errors.push('workflow.edges must be an array.');

  const nodeIds = new Set();
  for (const node of wf.nodes || []) {
    if (!node.id || typeof node.id !== 'string') {
      errors.push('Every node must have a string "id".');
    } else if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}".`);
    } else {
      nodeIds.add(node.id);
    }
    if (!node.type || typeof node.type !== 'string') {
      errors.push(`Node "${node.id || '?'}" missing string "type".`);
    }
    if (node.params !== undefined && (typeof node.params !== 'object' || node.params === null)) {
      errors.push(`Node "${node.id}" params must be an object.`);
    }
  }

  // Edge validation & cycle detection (Kahn's algorithm)
  const adj = new Map();
  const inDegree = new Map();
  for (const id of nodeIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const edge of wf.edges || []) {
    if (!nodeIds.has(edge.from)) errors.push(`Edge references unknown source node "${edge.from}".`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge references unknown target node "${edge.to}".`);
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      adj.get(edge.from).push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift();
    visited++;
    for (const nxt of adj.get(cur) || []) {
      inDegree.set(nxt, inDegree.get(nxt) - 1);
      if (inDegree.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (visited !== nodeIds.size && nodeIds.size > 0) {
    errors.push('Workflow graph contains a cycle; workflows must be a Directed Acyclic Graph (DAG).');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate a JSON Schema 2020-12 document from a sample JSON value or array of records.
 */
export function generateJsonSchema(sample, options = {}) {
  const title = options.title || 'Generated Data Schema';
  const schema = inferNodeSchema(sample);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    ...schema
  };
}

function inferNodeSchema(val) {
  if (val === null) return { type: 'null' };
  if (Array.isArray(val)) {
    if (val.length === 0) return { type: 'array', items: {} };
    if (val.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      return { type: 'array', items: mergeObjectSchemas(val) };
    }
    const itemTypes = Array.from(new Set(val.map(v => getJsonType(v))));
    return {
      type: 'array',
      items: itemTypes.length === 1 ? inferNodeSchema(val[0]) : { type: itemTypes }
    };
  }
  if (typeof val === 'object') {
    return mergeObjectSchemas([val]);
  }
  if (typeof val === 'string') {
    const out = { type: 'string' };
    if (REGEX_EMAIL.test(val)) out.format = 'email';
    else if (REGEX_DATE.test(val)) out.format = 'date';
    else if (REGEX_DATETIME.test(val)) out.format = 'date-time';
    else if (REGEX_UUID.test(val)) out.format = 'uuid';
    else if (REGEX_URI.test(val)) out.format = 'uri';
    return out;
  }
  if (typeof val === 'number') return { type: Number.isInteger(val) ? 'integer' : 'number' };
  if (typeof val === 'boolean') return { type: 'boolean' };
  return {};
}

function getJsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function mergeObjectSchemas(objects) {
  const propStats = new Map();
  const total = objects.length;

  for (const obj of objects) {
    for (const [k, v] of Object.entries(obj)) {
      if (!propStats.has(k)) {
        propStats.set(k, { count: 0, types: new Set(), formats: new Set(), values: new Set(), nested: [] });
      }
      const st = propStats.get(k);
      st.count++;
      const t = getJsonType(v);
      st.types.add(t);
      if (typeof v === 'string') {
        if (st.values.size < 20) st.values.add(v);
        if (REGEX_EMAIL.test(v)) st.formats.add('email');
        else if (REGEX_DATE.test(v)) st.formats.add('date');
        else if (REGEX_DATETIME.test(v)) st.formats.add('date-time');
        else if (REGEX_UUID.test(v)) st.formats.add('uuid');
        else if (REGEX_URI.test(v)) st.formats.add('uri');
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        st.nested.push(v);
      }
    }
  }

  const properties = {};
  const required = [];

  for (const [k, st] of propStats.entries()) {
    if (st.count === total && !st.types.has('null')) {
      required.push(k);
    }
    const types = Array.from(st.types);
    // Merge integer + number into number
    if (types.includes('integer') && types.includes('number')) {
      types.splice(types.indexOf('integer'), 1);
    }
    const propSchema = { type: types.length === 1 ? types[0] : types };
    if (st.formats.size === 1 && types.includes('string')) {
      propSchema.format = Array.from(st.formats)[0];
    }
    if (st.nested.length > 0 && types.includes('object')) {
      const sub = mergeObjectSchemas(st.nested);
      propSchema.properties = sub.properties;
      if (sub.required.length) propSchema.required = sub.required;
    }
    properties[k] = propSchema;
  }

  const res = { type: 'object', properties };
  if (required.length > 0) res.required = required;
  return res;
}

/**
 * Validate JSON data against a JSON Schema 2020-12 subset.
 */
export function validateAgainstSchema(data, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };

  const actualType = getJsonType(data);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = allowed.includes(actualType) || (allowed.includes('number') && actualType === 'integer');
    if (!ok) {
      errors.push({ path, message: `Expected type ${allowed.join(' | ')}, got ${actualType}.` });
      return { valid: false, errors };
    }
  }

  if (schema.enum && !schema.enum.includes(data)) {
    errors.push({ path, message: `Value ${JSON.stringify(data)} is not in enum [${schema.enum.join(', ')}].` });
  }

  if (actualType === 'string' && schema.format) {
    const fmtOk =
      (schema.format === 'email' && REGEX_EMAIL.test(data)) ||
      (schema.format === 'date' && REGEX_DATE.test(data)) ||
      (schema.format === 'date-time' && REGEX_DATETIME.test(data)) ||
      (schema.format === 'uuid' && REGEX_UUID.test(data)) ||
      (schema.format === 'uri' && REGEX_URI.test(data));
    if (!fmtOk) {
      errors.push({ path, message: `String "${data}" failed format "${schema.format}".` });
    }
  }

  if (actualType === 'object') {
    for (const req of schema.required || []) {
      if (!(req in data) || data[req] === undefined) {
        errors.push({ path: `${path}.${req}`, message: `Missing required property "${req}".` });
      }
    }
    for (const [k, propSchema] of Object.entries(schema.properties || {})) {
      if (k in data) {
        const sub = validateAgainstSchema(data[k], propSchema, `${path}.${k}`);
        errors.push(...sub.errors);
      }
    }
  }

  if (actualType === 'array' && schema.items) {
    data.forEach((item, idx) => {
      const sub = validateAgainstSchema(item, schema.items, `${path}[${idx}]`);
      errors.push(...sub.errors);
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Schema Guardian — Create a flattened Schema Snapshot for version tracking (Section 7.3).
 */
export function createSchemaSnapshot(data, label = 'snapshot') {
  const schema = generateJsonSchema(data, { title: label });
  const now = new Date().toISOString();
  const fields = [];

  function extractFields(node, prefix, isRequired) {
    if (!node) return;
    if (node.type === 'array' && node.items) {
      extractFields(node.items, `${prefix}[]`, true);
      return;
    }
    if (node.properties) {
      const reqSet = new Set(node.required || []);
      for (const [k, prop] of Object.entries(node.properties)) {
        const fieldPath = prefix === '$' ? `$.${k}` : `${prefix}.${k}`;
        const types = Array.isArray(prop.type) ? prop.type : [prop.type || 'any'];
        const nullable = types.includes('null');
        const primaryType = types.filter(t => t !== 'null').join('|') || 'null';
        fields.push({
          fieldPath,
          type: primaryType,
          required: reqSet.has(k),
          nullable,
          format: prop.format || null,
          firstSeen: now,
          lastSeen: now
        });
        if (prop.properties || (prop.type === 'array' && prop.items)) {
          extractFields(prop, fieldPath, reqSet.has(k));
        }
      }
    }
  }

  extractFields(schema, '$', true);
  return { label, createdAt: now, schema, fields };
}

/**
 * Schema Guardian — Compare two Schema Snapshots and classify Breaking Changes (Section 7.3).
 */
export function diffSchemaSnapshots(oldSnap, newSnap) {
  const oldMap = new Map((oldSnap.fields || []).map(f => [f.fieldPath, f]));
  const newMap = new Map((newSnap.fields || []).map(f => [f.fieldPath, f]));
  const changes = [];

  for (const [path, oldF] of oldMap.entries()) {
    if (!newMap.has(path)) {
      changes.push({
        fieldPath: path,
        changeType: 'removed',
        risk: oldF.required ? 'critical' : 'medium',
        breaking: oldF.required,
        message: oldF.required
          ? `Required field "${path}" was removed.`
          : `Optional field "${path}" was removed.`
      });
    } else {
      const newF = newMap.get(path);
      if (oldF.type !== newF.type) {
        const widening = oldF.type === 'integer' && newF.type === 'number';
        changes.push({
          fieldPath: path,
          changeType: 'type_changed',
          before: oldF.type,
          after: newF.type,
          risk: widening ? 'low' : 'critical',
          breaking: !widening,
          message: `Field "${path}" type changed from "${oldF.type}" to "${newF.type}".`
        });
      }
      if (oldF.nullable !== newF.nullable) {
        changes.push({
          fieldPath: path,
          changeType: 'nullable_changed',
          before: oldF.nullable,
          after: newF.nullable,
          risk: 'high',
          breaking: !oldF.nullable && newF.nullable,
          message: `Field "${path}" nullable changed from ${oldF.nullable} to ${newF.nullable}.`
        });
      }
      if (oldF.format !== newF.format) {
        changes.push({
          fieldPath: path,
          changeType: 'format_changed',
          before: oldF.format,
          after: newF.format,
          risk: 'medium',
          breaking: Boolean(oldF.format && !newF.format),
          message: `Field "${path}" format changed from "${oldF.format || 'none'}" to "${newF.format || 'none'}".`
        });
      }
    }
  }

  for (const [path, newF] of newMap.entries()) {
    if (!oldMap.has(path)) {
      changes.push({
        fieldPath: path,
        changeType: 'added',
        risk: newF.required ? 'medium' : 'low',
        breaking: false,
        message: `${newF.required ? 'Required' : 'Optional'} field "${path}" (${newF.type}) was added.`
      });
    }
  }

  const breakingCount = changes.filter(c => c.breaking).length;
  return {
    compatible: breakingCount === 0,
    breakingCount,
    summary: {
      totalChanges: changes.length,
      critical: changes.filter(c => c.risk === 'critical').length,
      high: changes.filter(c => c.risk === 'high').length,
      medium: changes.filter(c => c.risk === 'medium').length,
      low: changes.filter(c => c.risk === 'low').length
    },
    changes
  };
}

/**
 * Data Contract / Input Contract Validator (Section 2 Innovation F).
 */
export function validateDataContract(dataset, contract) {
  const checks = [];
  const columns = dataset.columns || [];
  const rows = dataset.rows || [];
  const colSet = new Set(columns);

  if (contract.requiredColumns) {
    const missing = contract.requiredColumns.filter(c => !colSet.has(c));
    checks.push({
      rule: 'requiredColumns',
      passed: missing.length === 0,
      message: missing.length === 0 ? 'All required columns are present.' : `Missing required column(s): ${missing.join(', ')}.`,
      details: { missing }
    });
  }

  if (typeof contract.minRows === 'number') {
    const ok = rows.length >= contract.minRows;
    checks.push({
      rule: 'minRows',
      passed: ok,
      message: ok ? `Row count (${rows.length}) meets minRows (${contract.minRows}).` : `Row count (${rows.length}) is below minRows (${contract.minRows}).`
    });
  }

  if (typeof contract.maxRows === 'number') {
    const ok = rows.length <= contract.maxRows;
    checks.push({
      rule: 'maxRows',
      passed: ok,
      message: ok ? `Row count (${rows.length}) within maxRows (${contract.maxRows}).` : `Row count (${rows.length}) exceeds maxRows (${contract.maxRows}).`
    });
  }

  if (contract.primaryKey && Array.isArray(contract.primaryKey) && contract.primaryKey.length > 0) {
    const seen = new Set();
    let dupes = 0;
    let nulls = 0;
    for (const r of rows) {
      const parts = contract.primaryKey.map(k => r[k]);
      if (parts.some(v => v === null || v === undefined || String(v).trim() === '')) {
        nulls++;
        continue;
      }
      const key = parts.join('||');
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    const ok = dupes === 0 && nulls === 0;
    checks.push({
      rule: 'primaryKey',
      passed: ok,
      message: ok
        ? `Primary key (${contract.primaryKey.join(', ')}) is unique and non-null.`
        : `Primary key (${contract.primaryKey.join(', ')}) violation: ${dupes} duplicate(s), ${nulls} null(s).`
    });
  }

  if (contract.maxNullRate && typeof contract.maxNullRate === 'object') {
    for (const [col, maxRate] of Object.entries(contract.maxNullRate)) {
      if (!colSet.has(col)) continue;
      let nullCount = 0;
      for (const r of rows) {
        if (r[col] === null || r[col] === undefined || String(r[col]).trim() === '') nullCount++;
      }
      const rate = rows.length === 0 ? 0 : nullCount / rows.length;
      const ok = rate <= maxRate;
      checks.push({
        rule: `maxNullRate:${col}`,
        passed: ok,
        message: ok
          ? `Column "${col}" null rate (${(rate * 100).toFixed(1)}%) <= ${(maxRate * 100).toFixed(1)}%.`
          : `Column "${col}" null rate (${(rate * 100).toFixed(1)}%) exceeds limit (${(maxRate * 100).toFixed(1)}%).`
      });
    }
  }

  if (contract.uniqueColumns && Array.isArray(contract.uniqueColumns)) {
    for (const col of contract.uniqueColumns) {
      if (!colSet.has(col)) continue;
      const seen = new Set();
      let dupes = 0;
      for (const r of rows) {
        const v = r[col];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const s = String(v);
        if (seen.has(s)) dupes++;
        seen.add(s);
      }
      checks.push({
        rule: `unique:${col}`,
        passed: dupes === 0,
        message: dupes === 0 ? `Column "${col}" has 100% unique non-null values.` : `Column "${col}" has ${dupes} duplicate value(s).`
      });
    }
  }

  if (contract.columnTypes && typeof contract.columnTypes === 'object') {
    for (const [col, expectedType] of Object.entries(contract.columnTypes)) {
      if (!colSet.has(col)) continue;
      let bad = 0;
      for (const r of rows) {
        const v = r[col];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const s = String(v).trim();
        let ok = true;
        if (expectedType === 'number' || expectedType === 'float') ok = !Number.isNaN(Number(s));
        else if (expectedType === 'integer') ok = /^[+-]?\d+$/.test(s);
        else if (expectedType === 'email') ok = REGEX_EMAIL.test(s);
        else if (expectedType === 'date') ok = REGEX_DATE.test(s) || REGEX_DATETIME.test(s);
        else if (expectedType === 'boolean') ok = s === 'true' || s === 'false' || typeof v === 'boolean';
        if (!ok) bad++;
      }
      checks.push({
        rule: `columnType:${col}`,
        passed: bad === 0,
        message: bad === 0 ? `Column "${col}" matches type "${expectedType}".` : `Column "${col}" has ${bad} value(s) failing type "${expectedType}".`
      });
    }
  }

  const failedCount = checks.filter(c => !c.passed).length;
  return {
    passed: failedCount === 0,
    status: failedCount === 0 ? 'PASS' : 'FAIL',
    totalChecks: checks.length,
    failedCount,
    checks
  };
}
