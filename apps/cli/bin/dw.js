#!/usr/bin/env node
/**
 * Data Workbench 2.0 CLI (`dw`)
 * Local-first deterministic runner for workflows, contracts, diffs, profiling, schemas, and regression tests.
 * Exit codes: 0 = OK, 1 = Failure / Validation Error / Breaking Drift, 2 = Usage Error, 130 = Interrupted (Ctrl+C).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, serializeCsv, detectCsvDialect } from '../../../packages/csv-engine/index.js';
import { parseXlsx, serializeXlsx } from '../../../packages/xlsx-engine/index.js';
import { validateJson, jsonToTabular, formatJson } from '../../../packages/json-engine/index.js';
import { profileDataset, explainDataset } from '../../../packages/quality-engine/index.js';
import { diffTables, diffJson, formatDiffReport } from '../../../packages/diff-engine/index.js';
import {
  validateDataContract,
  createSchemaSnapshot,
  diffSchemaSnapshots
} from '../../../packages/workflow-schema/index.js';
import { executeWorkflow, runRegressionTests, ENGINE_VERSION } from '../../../packages/workflow-core/index.js';
import { listNodes } from '../../../packages/node-registry/index.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function safeResolve(filePath, rootDir = null) {
  const resolved = path.resolve(filePath);
  if (rootDir) {
    const absRoot = path.resolve(rootDir);
    if (!resolved.startsWith(absRoot + path.sep) && resolved !== absRoot) {
      throw new Error(`Security error: path "${filePath}" escapes allowed root "${absRoot}".`);
    }
  }
  return resolved;
}

async function loadInputFile(filePath, rootDir = null) {
  const abs = safeResolve(filePath, rootDir);
  if (!fs.existsSync(abs)) {
    throw new Error(`Input file not found: ${abs}`);
  }
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.xlsx') {
    const bytes = new Uint8Array(fs.readFileSync(abs));
    const ds = await parseXlsx(bytes);
    return { kind: 'xlsx', raw: serializeCsv(ds, { formulaGuard: false }), rawBytes: bytes, dataset: ds };
  }
  const raw = fs.readFileSync(abs, 'utf8');
  if (ext === '.json') {
    const v = validateJson(raw);
    if (!v.valid) throw new Error(`Invalid JSON in ${abs} (L${v.line}:C${v.column}): ${v.error}`);
    return { kind: 'json', raw, data: v.data, dataset: jsonToTabular(v.data) };
  }
  return { kind: 'csv', raw, dataset: parseCsv(raw) };
}

function writeOutputSafe(outPath, content, force = false, inputPaths = [], rootDir = null) {
  const absOut = safeResolve(outPath, rootDir);
  const absInputs = inputPaths.map(p => safeResolve(p, rootDir));
  if (absInputs.includes(absOut) && !force) {
    throw new Error(`Refusing to overwrite input file "${absOut}". Pass --force to override.`);
  }
  if (fs.existsSync(absOut) && !force) {
    throw new Error(`Output file already exists: "${absOut}". Pass --force to overwrite.`);
  }
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, content, 'utf8');
}

function logEvent(jsonLog, level, message, extra = {}) {
  if (jsonLog) {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }) + '\n');
  } else {
    process.stderr.write(`[dw:${level}] ${message}\n`);
  }
}

function printHelp() {
  process.stdout.write(`Data Workbench CLI v${ENGINE_VERSION} — Local-first deterministic data workflows

Usage:
  dw run <workflow.json> --input <file> [--output <file>] [--report <file>] [--force] [--json-log] [--root <dir>]
  dw validate <file> --contract <contract.json> [--json-log]
  dw diff <left> <right> [--key <col1,col2>] [--format markdown|json|html] [--output <file>] [--force]
  dw profile <file> [--explain]
  dw schema <file> [--compare <snapshot.json>] [--output <file>] [--force]
  dw test <workflow.json> --input <file> --expectations <expectations.json>
  dw nodes
  dw --version | --help
`);
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);
  const jsonLog = Boolean(flags['json-log']);
  const rootDir = typeof flags.root === 'string' ? flags.root : null;

  if (flags.version || command === 'version') {
    process.stdout.write(`data-workbench ${ENGINE_VERSION}\n`);
    process.exit(0);
  }
  if (!command || flags.help || command === 'help') {
    printHelp();
    process.exit(0);
  }

  const controller = new AbortController();
  process.on('SIGINT', () => {
    logEvent(jsonLog, 'warn', 'Received SIGINT, cancelling execution...');
    controller.abort();
  });

  try {
    if (command === 'nodes') {
      process.stdout.write(JSON.stringify(listNodes(), null, 2) + '\n');
      process.exit(0);
    }

    if (command === 'profile') {
      const target = positional[0];
      if (!target) { logEvent(jsonLog, 'error', 'Missing file argument.'); process.exit(2); }
      const loaded = await loadInputFile(target, rootDir);
      const profile = profileDataset(loaded.dataset);
      const dialect = loaded.kind === 'csv' ? detectCsvDialect(loaded.raw) : null;
      const out = { file: target, dialect, profile };
      if (flags.explain) out.explanation = explainDataset(loaded.dataset, profile);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      process.exit(0);
    }

    if (command === 'validate') {
      const target = positional[0];
      const contractPath = flags.contract;
      if (!target || !contractPath) {
        logEvent(jsonLog, 'error', 'Usage: dw validate <file> --contract <contract.json>');
        process.exit(2);
      }
      const loaded = await loadInputFile(target, rootDir);
      const contract = JSON.parse(fs.readFileSync(safeResolve(contractPath, rootDir), 'utf8'));
      const result = validateDataContract(loaded.dataset, contract);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.passed ? 0 : 1);
    }

    if (command === 'diff') {
      const [leftPath, rightPath] = positional;
      if (!leftPath || !rightPath) {
        logEvent(jsonLog, 'error', 'Usage: dw diff <left> <right> [--key <col>] [--format markdown|json|html]');
        process.exit(2);
      }
      const left = await loadInputFile(leftPath, rootDir);
      const right = await loadInputFile(rightPath, rootDir);
      const format = typeof flags.format === 'string' ? flags.format : 'markdown';

      let diffResult;
      if (left.kind === 'json' && right.kind === 'json' && !flags.key) {
        diffResult = diffJson(left.data, right.data, { ignoreArrayOrder: Boolean(flags['ignore-array-order']) });
      } else {
        const keys = typeof flags.key === 'string' ? flags.key.split(',').map(s => s.trim()).filter(Boolean) : [];
        diffResult = diffTables(left.dataset, right.dataset, { keys });
      }
      const report = formatDiffReport(diffResult, format);
      if (flags.output) {
        writeOutputSafe(flags.output, report, Boolean(flags.force), [leftPath, rightPath], rootDir);
        logEvent(jsonLog, 'info', `Diff report written to ${flags.output}`);
      } else {
        process.stdout.write(report + '\n');
      }
      process.exit(0);
    }

    if (command === 'schema') {
      const target = positional[0];
      if (!target) { logEvent(jsonLog, 'error', 'Usage: dw schema <file> [--compare <old-snapshot.json>]'); process.exit(2); }
      const loaded = await loadInputFile(target, rootDir);
      const snapshot = createSchemaSnapshot(loaded.kind === 'json' ? loaded.data : loaded.dataset.rows, path.basename(target));
      if (flags.compare) {
        const oldSnap = JSON.parse(fs.readFileSync(safeResolve(flags.compare, rootDir), 'utf8'));
        const drift = diffSchemaSnapshots(oldSnap, snapshot);
        process.stdout.write(JSON.stringify(drift, null, 2) + '\n');
        process.exit(drift.compatible ? 0 : 1);
      }
      const text = JSON.stringify(snapshot, null, 2);
      if (flags.output) {
        writeOutputSafe(flags.output, text, Boolean(flags.force), [target], rootDir);
      } else {
        process.stdout.write(text + '\n');
      }
      process.exit(0);
    }

    if (command === 'run') {
      const wfPath = positional[0];
      if (!wfPath) { logEvent(jsonLog, 'error', 'Usage: dw run <workflow.json> --input <file> [--output <file>]'); process.exit(2); }
      const wfDoc = JSON.parse(fs.readFileSync(safeResolve(wfPath, rootDir), 'utf8'));
      const inputsByNodeId = {};
      const inputPaths = [];

      if (flags.input) {
        const loaded = await loadInputFile(flags.input, rootDir);
        inputPaths.push(flags.input);
        const firstSource = wfDoc.workflow?.nodes?.find(n => n.type.startsWith('source.'));
        if (firstSource) {
          inputsByNodeId[firstSource.id] = loaded.kind === 'json' && firstSource.type === 'source.json' ? loaded.raw : loaded.raw;
        }
      }

      const runRes = await executeWorkflow(wfDoc, {
        inputsByNodeId,
        signal: controller.signal,
        onNodeComplete: (id, res) => logEvent(jsonLog, res.status === 'failed' ? 'error' : 'info', `Node ${id}: ${res.status} (${res.rowCount} rows, ${res.durationMs}ms)`)
      });

      if (runRes.status === 'cancelled') process.exit(130);

      const finalOut = runRes.finalOutput;
      if (flags.output && finalOut) {
        const ext = path.extname(flags.output).toLowerCase();
        if (ext === '.xlsx') {
          const absOut = safeResolve(flags.output, rootDir);
          if (fs.existsSync(absOut) && !flags.force) throw new Error(`Output file already exists: "${absOut}". Pass --force.`);
          fs.mkdirSync(path.dirname(absOut), { recursive: true });
          fs.writeFileSync(absOut, finalOut.exportedBytes || serializeXlsx(finalOut, { formulaGuard: true }));
        } else {
          const text = finalOut.exportedText !== undefined
            ? finalOut.exportedText
            : (ext === '.csv' ? serializeCsv(finalOut) : formatJson(finalOut.rows || []));
          writeOutputSafe(flags.output, text, Boolean(flags.force), inputPaths, rootDir);
        }
        logEvent(jsonLog, 'info', `Output written to ${flags.output}`);
      }

      const sanitizedReport = {
        status: runRes.status,
        engineVersion: runRes.engineVersion,
        workflowId: runRes.workflowId,
        durationMs: runRes.durationMs,
        warnings: runRes.warnings,
        errors: runRes.errors,
        logs: runRes.logs
      };

      if (flags.report) {
        writeOutputSafe(flags.report, JSON.stringify(sanitizedReport, null, 2), Boolean(flags.force), inputPaths, rootDir);
      }
      if (!flags.output) {
        process.stdout.write((finalOut?.exportedText || JSON.stringify(sanitizedReport, null, 2)) + '\n');
      }
      process.exit(runRes.status === 'failed' ? 1 : 0);
    }

    if (command === 'test') {
      const wfPath = positional[0];
      if (!wfPath || !flags.input || !flags.expectations) {
        logEvent(jsonLog, 'error', 'Usage: dw test <workflow.json> --input <file> --expectations <file.json>');
        process.exit(2);
      }
      const wfDoc = JSON.parse(fs.readFileSync(safeResolve(wfPath, rootDir), 'utf8'));
      const loaded = await loadInputFile(flags.input, rootDir);
      const expectations = JSON.parse(fs.readFileSync(safeResolve(flags.expectations, rootDir), 'utf8'));
      const firstSource = wfDoc.workflow?.nodes?.find(n => n.type.startsWith('source.'));
      const inputsByNodeId = firstSource ? { [firstSource.id]: loaded.raw } : {};
      const runRes = await executeWorkflow(wfDoc, { inputsByNodeId, signal: controller.signal });
      if (runRes.status === 'failed') {
        process.stdout.write(JSON.stringify({ overallStatus: 'FAIL', errors: runRes.errors }, null, 2) + '\n');
        process.exit(1);
      }
      const reg = runRegressionTests(loaded.dataset, runRes.finalOutput, expectations);
      process.stdout.write(JSON.stringify(reg, null, 2) + '\n');
      process.exit(reg.overallStatus === 'FAIL' ? 1 : 0);
    }

    logEvent(jsonLog, 'error', `Unknown command "${command}". Run "dw --help".`);
    process.exit(2);
  } catch (err) {
    logEvent(jsonLog, 'error', err.message || String(err));
    process.exit(1);
  }
}

main();
