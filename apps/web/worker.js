/**
 * Data Workbench 2.1.1 — Dedicated Background Web Worker
 * Keeps full ColumnarTable resident in Worker memory; sends only windowed preview rows (<= 500)
 * + telemetry back to main thread to eliminate structured-clone freezes on large files.
 */

import { executeWorkflow } from '../../packages/workflow-core/index.js';
import { serializeCsv } from '../../packages/csv-engine/index.js';
import { formatJson } from '../../packages/json-engine/index.js';

let activeController = null;
let lastFinalHandle = null;

self.onmessage = async (event) => {
  const { type, runId, workflowDoc, inputsByNodeId, adapter, previewLimit, format } = event.data || {};

  if (type === 'cancel') {
    activeController?.abort();
    return;
  }

  if (type === 'export' && lastFinalHandle) {
    try {
      const text = format === 'csv'
        ? serializeCsv(lastFinalHandle, { formulaGuard: true })
        : formatJson(lastFinalHandle.rows, { indent: 2 });
      self.postMessage({ type: 'exported', runId, format, text });
    } catch (err) {
      self.postMessage({ type: 'error', runId, message: err.message || String(err) });
    }
    return;
  }

  if (type === 'run') {
    activeController = new AbortController();
    const maxPreview = previewLimit ?? 500;
    try {
      const res = await executeWorkflow(workflowDoc, {
        inputsByNodeId,
        adapter: adapter || 'auto',
        signal: activeController.signal,
        onNodeComplete: (nodeId, nr) => {
          self.postMessage({
            type: 'progress',
            runId,
            nodeId,
            status: nr.status,
            rowCount: nr.rowCount,
            durationMs: nr.durationMs,
            estimatedBytes: nr.estimatedBytes
          });
        }
      });

      const finalOut = res.finalOutput;
      lastFinalHandle = finalOut || null;

      const serializableNodeResults = {};
      for (const [nid, nr] of Object.entries(res.nodeResults || {})) {
        serializableNodeResults[nid] = {
          status: nr.status,
          durationMs: nr.durationMs,
          rowCount: nr.rowCount,
          estimatedBytes: nr.estimatedBytes,
          columnarNative: nr.columnarNative,
          warnings: nr.warnings,
          errors: nr.errors,
          metrics: nr.metrics,
          diff: nr.diff
        };
      }

      // Windowed preview only — never structured-clone 100k+ row objects across Worker boundary!
      const totalRows = finalOut?.rowCount ?? finalOut?.rows?.length ?? 0;
      const previewRows = finalOut
        ? (typeof finalOut.sliceRows === 'function' ? finalOut.sliceRows(0, maxPreview) : (finalOut.rows || []).slice(0, maxPreview))
        : [];

      self.postMessage({
        type: 'complete',
        runId,
        result: {
          status: res.status,
          engineVersion: res.engineVersion,
          adapter: res.adapter,
          workflowId: res.workflowId,
          executedOrder: res.executedOrder,
          errors: res.errors,
          warnings: res.warnings,
          logs: res.logs,
          durationMs: res.durationMs,
          finalNodeId: res.finalNodeId,
          nodeResults: serializableNodeResults,
          finalDataset: finalOut ? {
            columns: finalOut.columns || [],
            rows: previewRows,
            totalRowCount: totalRows,
            isWindowedPreview: totalRows > previewRows.length,
            badRows: (finalOut.badRows || []).slice(0, 100),
            meta: finalOut.meta || {},
            estimatedBytes: typeof finalOut.estimateBytes === 'function' ? finalOut.estimateBytes() : 0,
            exportedText: totalRows <= 5000 ? finalOut.exportedText : undefined,
            exportedFormat: finalOut.exportedFormat
          } : null
        }
      });
    } catch (err) {
      self.postMessage({ type: 'error', runId, message: err.message || String(err) });
    } finally {
      activeController = null;
    }
  }
};
