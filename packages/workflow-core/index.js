/**
 * @module @data-workbench/workflow-core
 * v2.1 Deterministic Multi-Port DAG Executor with DataHandle Zero-Copy Pass-Through,
 * Plugin Parameter Validation & Version Migration, ExecutionAdapter Dispatch,
 * Before/After Data Diff, Workflow Recorder (Undo/Redo), Regression Tests, AI Rule Copilot,
 * Code Mode Generators, and Portable Workflow Packages.
 */

import { DataHandle, selectBestAdapter } from '../engine-core/index.js';
import { getNodeDefinition, validateNodeParams, migrateNodeParams } from '../node-registry/index.js';
import { validateWorkflowDefinition, generateJsonSchema, createSchemaSnapshot } from '../workflow-schema/index.js';
import { profileDataset, isNullish } from '../quality-engine/index.js';

export const ENGINE_VERSION = '2.1.0';

/**
 * Compute lightweight Before / After Data Diff between two DataHandles or datasets (Section 2 Innovation D).
 */
export function computeNodeDiff(beforeDs, afterDs) {
  if (!beforeDs || !afterDs) return null;
  const bHandle = DataHandle.fromAny(beforeDs);
  const aHandle = DataHandle.fromAny(afterDs);
  const beforeRowCount = bHandle.rowCount;
  const afterRowCount = aHandle.rowCount;
  const rowsDelta = afterRowCount - beforeRowCount;
  const addedCols = (aHandle.columns || []).filter(c => !(bHandle.columns || []).includes(c));
  const removedCols = (bHandle.columns || []).filter(c => !(aHandle.columns || []).includes(c));

  let changedCells = 0;
  const sampleChanges = [];
  const compareLen = Math.min(beforeRowCount, afterRowCount, 500);
  const bSample = bHandle.sliceRows(0, compareLen);
  const aSample = aHandle.sliceRows(0, compareLen);
  const sharedCols = (aHandle.columns || []).filter(c => (bHandle.columns || []).includes(c));

  for (let i = 0; i < compareLen; i++) {
    for (const col of sharedCols) {
      const b = bSample[i]?.[col];
      const a = aSample[i]?.[col];
      if (String(b ?? '') !== String(a ?? '')) {
        changedCells++;
        if (sampleChanges.length < 10) {
          sampleChanges.push({ rowIndex: i, column: col, before: b, after: a });
        }
      }
    }
  }

  return {
    beforeRowCount,
    afterRowCount,
    rowsAdded: Math.max(0, rowsDelta),
    rowsRemoved: Math.max(0, -rowsDelta),
    columnsAdded: addedCols,
    columnsRemoved: removedCols,
    changedCells,
    sampleChanges
  };
}

/**
 * Topological sort for Multi-Port DAG execution order.
 */
function topologicalSort(nodes, edges) {
  const inDegree = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map(nodes.map(n => [n.id, []]));
  const incomingEdges = new Map(nodes.map(n => [n.id, []]));

  for (const e of edges) {
    if (adj.has(e.from) && inDegree.has(e.to)) {
      adj.get(e.from).push(e.to);
      inDegree.set(e.to, inDegree.get(e.to) + 1);
      incomingEdges.get(e.to).push({
        from: e.from,
        fromPort: e.fromPort || 'out',
        toPort: e.toPort || 'in'
      });
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const nxt of adj.get(id)) {
      inDegree.set(nxt, inDegree.get(nxt) - 1);
      if (inDegree.get(nxt) === 0) queue.push(nxt);
    }
  }
  return { order, incomingEdges };
}

/**
 * v2.1 Deterministic Multi-Port DAG Workflow Executor.
 * @param {object} workflowDoc
 * @param {object} options { inputsByNodeId, adapter, signal, onNodeStart, onNodeComplete, onProgress }
 */
export async function executeWorkflow(workflowDoc, options = {}) {
  const startTime = Date.now();
  const validation = validateWorkflowDefinition(workflowDoc);
  if (!validation.valid) {
    return {
      status: 'failed',
      engineVersion: ENGINE_VERSION,
      errors: validation.errors.map(m => ({ nodeId: null, message: m })),
      warnings: [],
      nodeResults: {},
      logs: [],
      durationMs: Date.now() - startTime
    };
  }

  const { nodes, edges } = workflowDoc.workflow;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const { order, incomingEdges } = topologicalSort(nodes, edges);
  const connectedOutputPortsByNode = new Map(nodes.map(n => [n.id, new Set()]));
  for (const e of edges) {
    connectedOutputPortsByNode.get(e.from)?.add(e.fromPort || 'out');
  }
  const outputsByNodePort = new Map(); // nodeId -> { out: DataHandle, errors?: DataHandle, ... }
  const nodeResults = {};
  const logs = [];
  const allWarnings = [];
  const allErrors = [];
  const signal = options.signal || new AbortController().signal;
  const activeAdapter = selectBestAdapter(options.adapter || 'auto');

  for (let stepIdx = 0; stepIdx < order.length; stepIdx++) {
    if (signal.aborted) {
      return {
        status: 'cancelled',
        engineVersion: ENGINE_VERSION,
        adapter: activeAdapter.name,
        errors: [{ nodeId: null, message: 'Workflow execution cancelled by user.' }],
        warnings: allWarnings,
        nodeResults,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const nodeId = order[stepIdx];
    const node = nodeMap.get(nodeId);
    const inEdges = incomingEdges.get(nodeId) || [];

    if (node.disabled) {
      const firstIn = inEdges[0] ? outputsByNodePort.get(inEdges[0].from)?.[inEdges[0].fromPort] : undefined;
      if (firstIn !== undefined) outputsByNodePort.set(nodeId, { out: firstIn });
      nodeResults[nodeId] = { status: 'skipped', durationMs: 0, warnings: [], errors: [], metrics: [] };
      logs.push({ ts: new Date().toISOString(), level: 'info', nodeId, message: `Skipped disabled node "${node.id}"` });
      continue;
    }

    const def = getNodeDefinition(node.type);
    if (!def) {
      const err = { nodeId, message: `Unknown node type "${node.type}".` };
      allErrors.push(err);
      nodeResults[nodeId] = { status: 'failed', durationMs: 0, warnings: [], errors: [err], metrics: [] };
      return { status: 'failed', engineVersion: ENGINE_VERSION, adapter: activeAdapter.name, errors: allErrors, warnings: allWarnings, nodeResults, logs, durationMs: Date.now() - startTime };
    }

    const nodeStart = Date.now();
    options.onNodeStart?.(nodeId, stepIdx, order.length);

    // Build both positional inputs[] (v2.0 compatibility) and named inputsByPort{} (v2.1 multi-port)
    const nodeInputs = [];
    const inputsByPort = {};
    for (const edge of inEdges) {
      const upstreamPorts = outputsByNodePort.get(edge.from);
      const val = upstreamPorts ? (upstreamPorts[edge.fromPort] ?? upstreamPorts.out) : undefined;
      if (val !== undefined) {
        nodeInputs.push(val);
        inputsByPort[edge.toPort] = val;
      }
    }
    if (options.inputsByNodeId && nodeId in options.inputsByNodeId) {
      nodeInputs.unshift(options.inputsByNodeId[nodeId]);
      inputsByPort.in = options.inputsByNodeId[nodeId];
    }

    // Migrate & validate node parameters before execution
    const migratedParams = migrateNodeParams(def, node.params || {}, node.version || '1.0.0');
    const mergedParams = { ...(def.defaultParams || {}), ...migratedParams };
    const paramCheck = validateNodeParams(def, mergedParams);
    if (!paramCheck.valid) {
      const errs = paramCheck.errors.map(e => ({ nodeId, message: `Invalid param at ${e.path}: ${e.message}` }));
      allErrors.push(...errs);
      nodeResults[nodeId] = { status: 'failed', durationMs: 0, warnings: [], errors: errs, metrics: [] };
      return { status: 'failed', engineVersion: ENGINE_VERSION, adapter: activeAdapter.name, errors: allErrors, warnings: allWarnings, nodeResults, logs, durationMs: Date.now() - startTime };
    }

    const metrics = [];
    const ctx = {
      signal,
      adapter: activeAdapter,
      inputsByPort,
      connectedOutputPorts: connectedOutputPortsByNode.get(nodeId) || new Set(),
      reportProgress: (progress, message) => options.onProgress?.({ nodeId, progress, message }),
      emitMetric: (m) => metrics.push(m)
    };

    try {
      const res = await def.execute(nodeInputs, mergedParams, ctx);
      const primaryOut = res.outputsByPort?.out ?? res.output?.[0];
      const portMap = res.outputsByPort ? { ...res.outputsByPort } : { out: primaryOut };
      if (!portMap.out && primaryOut !== undefined) portMap.out = primaryOut;
      outputsByNodePort.set(nodeId, portMap);

      const diff = nodeInputs[0] && primaryOut && !node.type.startsWith('source.') ? computeNodeDiff(nodeInputs[0], primaryOut) : null;
      const durationMs = Date.now() - nodeStart;
      const nodeWarnings = (res.warnings || []).map(w => ({ nodeId, ...w }));
      const nodeErrors = (res.errors || []).map(e => ({ nodeId, ...e }));
      allWarnings.push(...nodeWarnings);
      allErrors.push(...nodeErrors);

      const rowCount = primaryOut?.rowCount ?? primaryOut?.rows?.length ?? 0;
      const estimatedBytes = typeof primaryOut?.estimateBytes === 'function' ? primaryOut.estimateBytes() : 0;

      nodeResults[nodeId] = {
        status: nodeErrors.length > 0 ? 'failed' : (nodeWarnings.length > 0 ? 'warning' : 'success'),
        durationMs,
        rowCount,
        estimatedBytes,
        columnarNative: Boolean(def.capabilities?.columnarNative),
        warnings: nodeWarnings,
        errors: nodeErrors,
        metrics: [...metrics, ...(res.metrics || [])],
        diff,
        output: primaryOut,
        outputsByPort: portMap
      };

      logs.push({
        ts: new Date().toISOString(),
        level: nodeErrors.length ? 'error' : (nodeWarnings.length ? 'warn' : 'info'),
        nodeId,
        message: `${def.label} (${node.type}${def.capabilities?.columnarNative ? ' · columnar' : ''}) — ${rowCount} rows in ${durationMs}ms`
      });

      options.onNodeComplete?.(nodeId, nodeResults[nodeId]);

      if (nodeErrors.length > 0) {
        return {
          status: 'failed',
          engineVersion: ENGINE_VERSION,
          adapter: activeAdapter.name,
          errors: allErrors,
          warnings: allWarnings,
          nodeResults,
          logs,
          finalNodeId: nodeId,
          finalOutput: primaryOut,
          durationMs: Date.now() - startTime
        };
      }
    } catch (err) {
      const e = { nodeId, message: err.message || String(err) };
      allErrors.push(e);
      nodeResults[nodeId] = { status: 'failed', durationMs: Date.now() - nodeStart, warnings: [], errors: [e], metrics };
      logs.push({ ts: new Date().toISOString(), level: 'error', nodeId, message: e.message });
      return {
        status: 'failed',
        engineVersion: ENGINE_VERSION,
        adapter: activeAdapter.name,
        errors: allErrors,
        warnings: allWarnings,
        nodeResults,
        logs,
        finalNodeId: nodeId,
        durationMs: Date.now() - startTime
      };
    }
  }

  const finalNodeId = order[order.length - 1];
  const finalOut = outputsByNodePort.get(finalNodeId)?.out;
  return {
    status: allWarnings.length > 0 ? 'warning' : 'success',
    engineVersion: ENGINE_VERSION,
    adapter: activeAdapter.name,
    workflowId: workflowDoc.workflow.id,
    executedOrder: order,
    errors: allErrors,
    warnings: allWarnings,
    nodeResults,
    logs,
    finalNodeId,
    finalOutput: finalOut,
    durationMs: Date.now() - startTime
  };
}

/**
 * Workflow Recorder with Undo / Redo (Section 2 Innovation C).
 */
export class WorkflowRecorder {
  constructor(initialWorkflow = null) {
    this.workflow = initialWorkflow ? structuredClone(initialWorkflow) : {
      schemaVersion: '1.0',
      workflow: {
        id: 'untitled-workflow',
        name: 'Untitled Data Workflow',
        engineVersion: ENGINE_VERSION,
        nodes: [
          { id: 'input-1', type: 'source.csv', version: '2.1.0', params: { header: true, delimiter: 'auto' } }
        ],
        edges: []
      }
    };
    this.undoStack = [];
    this.redoStack = [];
  }

  _snapshot() {
    this.undoStack.push(structuredClone(this.workflow));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  addStep(type, params = {}, label = null) {
    this._snapshot();
    const nodes = this.workflow.workflow.nodes;
    const edges = this.workflow.workflow.edges;
    const lastNode = nodes[nodes.length - 1];
    const id = `${type.split('.')[1] || 'step'}-${nodes.length + 1}`;
    const newNode = { id, type, version: '2.1.0', params, ...(label ? { label } : {}) };
    nodes.push(newNode);
    if (lastNode) {
      edges.push({ from: lastNode.id, fromPort: 'out', to: id, toPort: 'in' });
    }
    return newNode;
  }

  updateNodeParams(nodeId, params) {
    this._snapshot();
    const node = this.workflow.workflow.nodes.find(n => n.id === nodeId);
    if (node) node.params = { ...node.params, ...params };
  }

  removeNode(nodeId) {
    this._snapshot();
    const wf = this.workflow.workflow;
    const incoming = wf.edges.filter(e => e.to === nodeId);
    const outgoing = wf.edges.filter(e => e.from === nodeId);
    wf.nodes = wf.nodes.filter(n => n.id !== nodeId);
    wf.edges = wf.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    if (incoming.length === 1 && outgoing.length === 1) {
      wf.edges.push({ from: incoming[0].from, fromPort: incoming[0].fromPort || 'out', to: outgoing[0].to, toPort: outgoing[0].toPort || 'in' });
    }
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(structuredClone(this.workflow));
    this.workflow = this.undoStack.pop();
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(structuredClone(this.workflow));
    this.workflow = this.redoStack.pop();
    return true;
  }

  getWorkflow() {
    return structuredClone(this.workflow);
  }
}

/**
 * Workflow Regression Test Runner (Section 2 Innovation I).
 */
export function runRegressionTests(inputDataset, outputDataset, expectations = {}) {
  const inHandle = DataHandle.fromAny(inputDataset);
  const outHandle = DataHandle.fromAny(outputDataset);
  const results = [];
  const outCols = outHandle.columns || [];
  const outRows = outHandle.rows || [];
  const inRowCount = inHandle.rowCount;
  const profile = profileDataset(outHandle);

  if (expectations.expectedColumns) {
    const missing = expectations.expectedColumns.filter(c => !outCols.includes(c));
    results.push({
      test: 'expectedColumns',
      status: missing.length === 0 ? 'PASS' : 'FAIL',
      message: missing.length === 0 ? 'All expected output columns present.' : `Missing expected output columns: ${missing.join(', ')}`
    });
  }

  if (typeof expectations.maxRowDropRatio === 'number' && inRowCount > 0) {
    const dropRatio = Math.max(0, (inRowCount - outRows.length) / inRowCount);
    const ok = dropRatio <= expectations.maxRowDropRatio;
    results.push({
      test: 'maxRowDropRatio',
      status: ok ? 'PASS' : 'FAIL',
      message: ok
        ? `Row reduction (${(dropRatio * 100).toFixed(1)}%) within limit (${(expectations.maxRowDropRatio * 100).toFixed(1)}%).`
        : `Row count dropped by ${(dropRatio * 100).toFixed(1)}%, exceeding limit (${(expectations.maxRowDropRatio * 100).toFixed(1)}%).`
    });
  }

  if (expectations.uniqueKeys) {
    for (const col of expectations.uniqueKeys) {
      const seen = new Set();
      let dupes = 0;
      for (const r of outRows) {
        const v = r[col];
        if (isNullish(v)) continue;
        const s = String(v);
        if (seen.has(s)) dupes++;
        seen.add(s);
      }
      results.push({
        test: `uniqueKey:${col}`,
        status: dupes === 0 ? 'PASS' : 'FAIL',
        message: dupes === 0 ? `Key "${col}" remains 100% unique.` : `Key "${col}" has ${dupes} duplicate(s).`
      });
    }
  }

  if (expectations.maxNullRate) {
    for (const [col, maxRate] of Object.entries(expectations.maxNullRate)) {
      const cp = profile.columns.find(c => c.name === col);
      if (!cp) continue;
      const ok = cp.nullRate <= maxRate;
      results.push({
        test: `maxNullRate:${col}`,
        status: ok ? 'PASS' : 'WARNING',
        message: ok
          ? `"${col}" null rate (${(cp.nullRate * 100).toFixed(1)}%) <= ${(maxRate * 100).toFixed(1)}%.`
          : `"${col}" null rate (${(cp.nullRate * 100).toFixed(1)}%) exceeded ${(maxRate * 100).toFixed(1)}%.`
      });
    }
  }

  if (expectations.expectedColumnTypes) {
    for (const [col, expectedType] of Object.entries(expectations.expectedColumnTypes)) {
      const cp = profile.columns.find(c => c.name === col);
      if (!cp) continue;
      const ok = cp.inferredType === expectedType || (expectedType === 'float' && cp.inferredType === 'integer');
      results.push({
        test: `columnType:${col}`,
        status: ok ? 'PASS' : 'FAIL',
        message: ok ? `"${col}" inferred as "${cp.inferredType}".` : `"${col}" drifted from expected "${expectedType}" to "${cp.inferredType}".`
      });
    }
  }

  const hasFail = results.some(r => r.status === 'FAIL');
  const hasWarn = results.some(r => r.status === 'WARNING');
  return {
    overallStatus: hasFail ? 'FAIL' : (hasWarn ? 'WARNING' : 'PASS'),
    totalTests: results.length,
    passed: results.filter(r => r.status === 'PASS').length,
    warnings: results.filter(r => r.status === 'WARNING').length,
    failed: results.filter(r => r.status === 'FAIL').length,
    results
  };
}

/**
 * AI Rule Copilot — Deterministic Local Natural-Language-to-Plan Compiler (Section 2 Innovation H & Section 8).
 */
export function compileNaturalLanguagePlan(prompt, dataset = null) {
  const text = String(prompt || '').trim();
  const cols = dataset?.columns || [];
  const findCol = (hints) => {
    for (const h of hints) {
      const exact = cols.find(c => c.toLowerCase() === h.toLowerCase());
      if (exact) return exact;
      const partial = cols.find(c => c.toLowerCase().includes(h.toLowerCase()));
      if (partial) return partial;
    }
    return null;
  };

  const steps = [];
  const ambiguities = [];

  if (/(lowercase|转小写|小写)/i.test(text)) {
    const emailCol = /(email|邮箱)/i.test(text) ? (findCol(['email', 'mail']) || 'email') : (cols[0] || 'email');
    steps.push({ summary: `lowercase(${emailCol})`, nodeType: 'clean.text', params: { columns: [emailCol], trim: true, case: 'lower' }, destructive: false });
  } else if (/(uppercase|转大写|大写)/i.test(text)) {
    const target = findCol(['status', 'code', 'country', 'sku']) || cols[0] || 'status';
    steps.push({ summary: `uppercase(${target})`, nodeType: 'clean.text', params: { columns: [target], trim: true, case: 'upper' }, destructive: false });
  } else if (/(trim|去空格|去除空格|whitespace)/i.test(text)) {
    steps.push({ summary: `trim(all_columns)`, nodeType: 'clean.text', params: { columns: cols, trim: true }, destructive: false });
  }

  if (/(deduplicate|dedupe|remove duplicate|去重|删除重复)/i.test(text)) {
    const keyCol = findCol(['order_id', 'customer_id', 'sku', 'id', 'email']) || cols[0] || 'id';
    const keep = /(last|latest|最新|保留最后)/i.test(text) ? 'last' : 'first';
    steps.push({ summary: `deduplicate(key=${keyCol}, keep=${keep})`, nodeType: 'transform.deduplicate', params: { keys: [keyCol], keep, caseSensitive: true }, destructive: true });
  }

  if (/(date|iso|日期|标准化日期)/i.test(text)) {
    const dateCol = findCol(['signup_date', 'order_date', 'created_at', 'date', 'time']) || 'date';
    steps.push({ summary: `normalize_date(${dateCol}, target=ISO-8601)`, nodeType: 'clean.dateNormalize', params: { column: dateCol, sourceOrder: 'MDY', targetFormat: 'ISO-8601', invalidPolicy: 'keep' }, destructive: false });
    ambiguities.push(`Verify whether slash dates in "${dateCol}" follow MM/DD/YYYY (MDY) or DD/MM/YYYY (DMY).`);
  }

  if (/(mask|pii|脱敏|隐藏|hash|隐私)/i.test(text)) {
    const piiCols = [findCol(['email', 'mail']), findCol(['phone', 'tel']), findCol(['ssn', 'passport', 'ip'])].filter(Boolean);
    const strategy = /hash/i.test(text) ? 'hash' : /synthetic/i.test(text) ? 'synthetic' : 'mask';
    steps.push({ summary: `mask_pii(columns=[${(piiCols.length ? piiCols : ['email']).join(', ')}], strategy=${strategy})`, nodeType: 'clean.piiMask', params: { columns: piiCols.length ? piiCols : ['email'], strategy }, destructive: true });
  }

  if (/(sort|排序)/i.test(text)) {
    const sortCol = findCol(['order_date', 'signup_date', 'price', 'amount', 'id', 'customer_id']) || cols[0] || 'id';
    const dir = /(desc|降序|从大到小)/i.test(text) ? 'desc' : 'asc';
    steps.push({ summary: `sort(${sortCol}, ${dir})`, nodeType: 'transform.sort', params: { column: sortCol, direction: dir }, destructive: false });
  }

  if (/(export|导出|输出)/i.test(text)) {
    if (/yaml/i.test(text)) steps.push({ summary: 'export(format=yaml)', nodeType: 'output.yaml', params: {}, destructive: false });
    else if (/ndjson/i.test(text)) steps.push({ summary: 'export(format=ndjson)', nodeType: 'output.ndjson', params: {}, destructive: false });
    else if (/csv/i.test(text) && !/json/i.test(text)) steps.push({ summary: 'export(format=csv, formulaGuard=true)', nodeType: 'output.csv', params: { formulaGuard: true }, destructive: false });
    else steps.push({ summary: 'export(format=json, pretty=true)', nodeType: 'output.json', params: { pretty: true }, destructive: false });
  }

  return {
    mode: 'local-deterministic-copilot',
    dataSentExternally: false,
    prompt: text,
    steps,
    ambiguities,
    requiresApproval: true,
    note: 'Review every rule and sample preview before applying. Execution is performed by the deterministic Workflow Executor.'
  };
}

/**
 * Code Mode Generator (Section 3.3 C).
 */
export function generateCodeViews(workflowDoc, inputFile = './input.csv', outputFile = './output.json') {
  const wf = workflowDoc.workflow || { id: 'workflow', nodes: [], edges: [] };
  const sqlLines = [`-- Read-only SQL Preview for Workflow: ${wf.name}`];
  let currentCte = 'raw_input';
  sqlLines.push(`WITH ${currentCte} AS (\n  SELECT * FROM read_csv_auto('${inputFile}')\n)`);

  let stepNum = 0;
  for (const node of wf.nodes) {
    if (node.type.startsWith('source.') || node.type.startsWith('output.') || node.disabled) continue;
    stepNum++;
    const nextCte = `step_${stepNum}_${node.type.split('.')[1]}`;
    const p = node.params || {};
    let body = `SELECT * FROM ${currentCte}`;

    if (node.type === 'transform.deduplicate') {
      const keys = (p.keys || []).join(', ') || '*';
      body = `SELECT DISTINCT ON (${keys}) * FROM ${currentCte}`;
    } else if (node.type === 'transform.filter' && p.column) {
      body = `SELECT * FROM ${currentCte} WHERE "${p.column}" ${p.operator === 'notNull' ? 'IS NOT NULL' : `= '${p.value ?? ''}'`}`;
    } else if (node.type === 'transform.sort' && p.column) {
      body = `SELECT * FROM ${currentCte} ORDER BY "${p.column}" ${(p.direction || 'asc').toUpperCase()}`;
    } else if (node.type === 'clean.text' && p.columns?.length) {
      const fn = p.case === 'lower' ? 'LOWER(TRIM' : p.case === 'upper' ? 'UPPER(TRIM' : 'TRIM(';
      body = `SELECT *, ${p.columns.map(c => `${fn}("${c}")) AS "${c}"`).join(', ')} FROM ${currentCte}`;
    } else if (node.type === 'clean.dateNormalize' && p.column) {
      body = `SELECT *, strftime(try_strptime("${p.column}", '%Y-%m-%d'), '%Y-%m-%d') AS "${p.column}" FROM ${currentCte}`;
    } else if (node.type === 'transform.sqlQuery' && p.sql) {
      body = p.sql;
    }

    sqlLines.push(`, ${nextCte} AS (\n  ${body}\n)`);
    currentCte = nextCte;
  }
  sqlLines.push(`SELECT * FROM ${currentCte};`);

  const cliCommand = [
    `dw run ${wf.id}.workflow.json \\`,
    `  --input ${inputFile} \\`,
    `  --output ${outputFile} \\`,
    `  --report ./reports/latest-run.json`
  ].join('\n');

  return { sqlPreview: sqlLines.join('\n'), workflowJson: JSON.stringify(workflowDoc, null, 2), cliCommand };
}

/**
 * Portable Workflow Package Builder (Section 2 Innovation J).
 */
export function exportWorkflowPackage(workflowDoc, options = {}) {
  const wf = workflowDoc.workflow;
  const inRows = options.inputDataset ? DataHandle.fromAny(options.inputDataset).sliceRows(0, 100) : [];
  const outRows = options.outputDataset ? DataHandle.fromAny(options.outputDataset).sliceRows(0, 100) : [];
  const inputSchema = inRows.length ? generateJsonSchema(inRows, { title: `${wf.name} Input Schema` }) : {};
  const outputSchema = outRows.length ? generateJsonSchema(outRows, { title: `${wf.name} Output Schema` }) : {};
  const code = generateCodeViews(workflowDoc);

  const readme = [
    `# ${wf.name}`,
    '',
    `- **Workflow ID:** \`${wf.id}\``,
    `- **Schema Version:** \`${workflowDoc.schemaVersion}\``,
    `- **Engine Version:** \`${wf.engineVersion || ENGINE_VERSION}\``,
    `- **Nodes:** ${wf.nodes.length}`,
    '',
    '## Run with CLI',
    '```bash',
    code.cliCommand,
    '```',
    '',
    '## Privacy Notice',
    'Raw customer datasets are excluded by default. Only schemas, workflow configuration, and optional sanitized fixtures are included.'
  ].join('\n');

  return {
    'workflow.json': JSON.stringify(workflowDoc, null, 2),
    'README.md': readme,
    'schemas/input.schema.json': JSON.stringify(inputSchema, null, 2),
    'schemas/output.schema.json': JSON.stringify(outputSchema, null, 2),
    'reports/latest-run.json': JSON.stringify(options.lastRunReport || { status: 'not-run-yet' }, null, 2)
  };
}

export { createSchemaSnapshot };
