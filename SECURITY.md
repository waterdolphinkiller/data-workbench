# Security Policy

## Local-First Security Model
Data Workbench 2.0 is designed around deterministic local execution:
- **Zero Arbitrary Code Execution:** Workflow nodes and JSONPath/SQL-lite evaluators never invoke `eval()` or `new Function()`.
- **CSV Formula Injection Protection:** `serializeCsv` escapes leading `=`, `+`, `-`, `@`, `\t`, and `\r` characters by default (`formulaGuard: true`).
- **XSS-Safe Reports:** All HTML diff and schema reports escape cell values and field paths.
- **Path Traversal Prevention:** Both the `dw` CLI (`--root`) and the MCP Server (`--sandbox`) reject paths escaping their authorized directory.
- **No Silent Overwrites:** The CLI refuses to overwrite input files or existing output files unless `--force` is explicitly provided.

## Reporting a Vulnerability
Please report security issues privately via GitHub Security Advisories on `waterdolphinkiller/data-workbench` instead of opening a public issue.
