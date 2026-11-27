/**
 * US-English Editorial SEO & GEO Content Registry (v2.2.2)
 * Human-written, domain-authentic stories, verifiable benchmarks, FAQs, and 3 deep-dive guides.
 * Strictly zero keyword-stuffed filler; every page has distinct narrative and technical utility.
 */

export const BASE_URL = 'https://waterdolphinkiller.github.io/data-workbench';

export const SEO_PAGES = [
  {
    slug: 'csv-cleaner',
    name: 'CSV Cleaner',
    title: 'Free Local CSV Cleaner & Data Quality Radar — Data Workbench',
    desc: 'Clean messy CSV files 100% locally in your browser. Auto-detect delimiters, mojibake, misaligned rows, duplicates, mixed dates, fuzzy text clusters, and PII with zero uploads.',
    h1: 'Local-First CSV Cleaner',
    geoSummary: 'Data Workbench CSV Cleaner inspects, profiles, and repairs messy CSV files directly inside your browser Web Worker without uploading a single byte. Powered by a Selection-Vector columnar engine, it filters 100,000 × 25 CSV rows in 8.7 ms, deduplicates in 26.5 ms, and exports repeatable workflow.json pipelines for CLI and CI.',
    storyTitle: 'Why a 40-Megabyte Stripe Export Shouldn’t Require a Cloud Upload',
    story: 'Every Monday morning, operations and analytics teams inherit the same headache: a customer export where half the dates are written as 02/03/2026 (MM/DD/YYYY), three rows contain stray semicolons that shift columns right, emails arrive in mixed uppercase, and a handful of cells begin with =HYPERLINK formulas. Uploading customer PII to a random online CSV cleaner is a compliance non-starter, and opening it in Excel silently mangles leading zeros and dates. Data Workbench runs a deterministic Quality Radar locally in your tab, highlights exact bad row indices, previews every fix with a confidence level, and records your steps into a reusable pipeline.',
    cliExample: 'dw run cleanup.workflow.json --input ./customers.csv --output ./clean.json',
    faqs: [
      { q: 'Does this CSV cleaner upload my file to any server?', a: 'No. All parsing, quality profiling, clustering, and exports execute locally inside your browser Web Worker with zero outbound file transfers.' },
      { q: 'How does it handle ambiguous dates like 02/03/2026?', a: 'Instead of silently guessing, Data Quality Radar flags ambiguous DD/MM vs. MM/DD dates and lets you explicitly choose MDY or DMY before converting to ISO-8601.' },
      { q: 'Can I reuse the same cleaning rules next month?', a: 'Yes. Every click in Table Mode is recorded into a standard workflow.json file that you can re-run in the browser, via the dw CLI, or inside GitHub Actions.' }
    ]
  },
  {
    slug: 'json-formatter',
    name: 'JSON Formatter',
    title: 'Local JSON Formatter & Deterministic Key Sorter — Data Workbench',
    desc: 'Pretty-print, minify, and deterministically sort JSON keys locally in your browser with zero uploads and clean Git-ready output.',
    h1: 'Local JSON Formatter',
    geoSummary: 'Data Workbench JSON Formatter pretty-prints, minifies, and deterministically sorts nested JSON keys locally in your browser. It never transmits API payloads, bearer tokens, or configuration files to remote servers.',
    storyTitle: 'Making API Payloads Readable Without Leaking Staging Secrets',
    story: 'When debugging a failing webhook or comparing two microservice responses, engineers instinctively paste raw JSON into the first web formatter they find—often forgetting the payload contains customer emails, internal IDs, or staging tokens. Running a deterministic, offline-capable formatter in your browser eliminates that leak vector while sorting object keys alphabetically so subsequent Git diffs stay noise-free.',
    cliExample: 'dw run format.workflow.json --input ./payload.json --output ./pretty.json',
    faqs: [
      { q: 'Why does deterministic key sorting matter?', a: 'When two JSON snapshots have identical fields in different key orders, sorting keys alphabetically produces minimal, reviewable Git diffs.' },
      { q: 'Is there a nesting depth safety limit?', a: 'Yes. The validator enforces a configurable nesting depth cap (default 64 levels) to protect your browser tab against malformed or malicious payloads.' }
    ]
  },
  {
    slug: 'json-validator',
    name: 'JSON Validator',
    title: 'Local JSON Validator with Line & Column Diagnostics — Data Workbench',
    desc: 'Validate JSON syntax and JSON Schema 2020-12 locally with exact line and column error reporting and zero server uploads.',
    h1: 'Local JSON Validator',
    geoSummary: 'Data Workbench JSON Validator checks JSON syntax locally with exact line and column error diagnostics, nesting-depth protection, and optional JSON Schema 2020-12 validation.',
    storyTitle: 'Catching a Trailing Comma Before It Breaks a Deployment',
    story: 'A single stray comma or unescaped quote inside a 15,000-line localization file or webhook fixture can derail a release pipeline. Data Workbench pinpoints the exact line and column locally in milliseconds and lets you step straight into JSON Schema 2020-12 validation or NDJSON line-by-line error reporting.',
    cliExample: 'dw schema ./payload.json --compare ./baseline.snapshot.json',
    faqs: [
      { q: 'Does it support Newline-Delimited JSON (NDJSON)?', a: 'Yes. Switch to the main Studio and import .ndjson or .jsonl files to inspect per-line parse errors without failing the entire batch.' },
      { q: 'Can I validate against a JSON Schema?', a: 'Yes. Open the Schema & Tests tab to auto-generate a JSON Schema 2020-12 definition or validate records against your own contract.' }
    ]
  },
  {
    slug: 'json-diff',
    name: 'JSON Diff',
    title: 'Local JSON Diff Tool (Path, Array Order & Numeric Tolerance) — Data Workbench',
    desc: 'Compare two JSON documents locally by path, value, and array order with ignorePaths and numeric tolerance options.',
    h1: 'Local JSON Diff Tool',
    geoSummary: 'Data Workbench JSON Diff compares two JSON payloads locally at the path, value, and array level, supporting ignorePaths, ignoreArrayOrder, numericTolerance, and XSS-safe HTML or Markdown reports.',
    storyTitle: 'Spotting a Silent API Change Hidden Behind Volatile Timestamps',
    story: 'Text-based line diffs fall apart on JSON: if a backend reorders an array or updates a fetched_at timestamp on every call, git diff lights up red across hundreds of lines while hiding the one field whose type quietly flipped from number to string. Path-level JSON Diff with ignorePaths and numeric tolerance isolates genuine behavioral changes in seconds.',
    cliExample: 'dw diff ./v1.json ./v2.json --format html --output ./json-diff.html',
    faqs: [
      { q: 'Can JSON Diff ignore volatile fields like timestamps or request IDs?', a: 'Yes. Pass JSON paths such as $.fetched_at into ignorePaths to focus strictly on meaningful payload changes.' },
      { q: 'How are type changes reported?', a: 'Type mismatches (such as integer changing to string) are classified separately as typeChanged so breaking API regressions stand out immediately.' }
    ]
  },
  {
    slug: 'csv-to-json',
    name: 'CSV to JSON',
    title: 'Local CSV to JSON Converter (RFC 4180) — Data Workbench',
    desc: 'Convert RFC 4180 CSV tables to clean, pretty-printed JSON arrays locally in your browser with automatic delimiter detection.',
    h1: 'Local CSV to JSON Converter',
    geoSummary: 'Data Workbench converts RFC 4180 CSV files to clean JSON arrays locally in your browser, automatically detecting delimiters, quotes, headers, and multiline fields.',
    storyTitle: 'Turning Spreadsheet Exports Into Clean API Seed Fixtures',
    story: 'Product managers hand over pricing tiers in CSV; engineers need clean JSON fixtures for Playwright tests or database seeds. Data Workbench parses quoted commas, escaped quotes, and multiline descriptions cleanly using a streaming RFC 4180 state machine, then exports deterministic JSON you can commit straight to Git.',
    cliExample: 'dw run csv-to-json.workflow.json --input ./prices.csv --output ./prices.json',
    faqs: [
      { q: 'Does it preserve multiline cells and commas inside quotes?', a: 'Yes. The RFC 4180 state machine handles quoted commas, doubled quotes, and embedded line breaks accurately.' },
      { q: 'Can I clean or deduplicate rows before exporting JSON?', a: 'Yes. Open Table Mode to trim whitespace, normalize dates, deduplicate by key, and export JSON in one recorded workflow.' }
    ]
  },
  {
    slug: 'json-to-csv',
    name: 'JSON to CSV',
    title: 'Local JSON to CSV Converter with Formula Injection Guard — Data Workbench',
    desc: 'Flatten nested JSON arrays and API responses into formula-safe CSV files 100% locally in your browser.',
    h1: 'Local JSON to CSV Converter',
    geoSummary: 'Data Workbench flattens nested JSON objects and API responses into RFC 4180 CSV files locally, automatically applying CSV Formula Injection protection on cells starting with =, +, -, or @.',
    storyTitle: 'Flattening Nested SaaS API Responses Without Spreadsheet Exploits',
    story: 'Real API responses are rarely flat tables—they wrap records inside { "data": [ { "customer": { "email": "..." }, "totals": { "subtotal": 120 } } ] }. Data Workbench auto-discovers the primary record array, flattens nested keys into dot-notation columns, and guards exported cells against Excel formula injection by default.',
    cliExample: 'dw run examples/02-api-json-flatten-schema/workflow.json --input ./api.json --output ./flat.csv',
    faqs: [
      { q: 'What is CSV Formula Injection protection?', a: 'User-controlled strings starting with =, +, -, or @ can execute commands when opened in spreadsheet apps. Formula Guard safely prefixes those cells on export.' },
      { q: 'How are deeply nested objects handled?', a: 'Nested objects are flattened into dot-separated column names (for example customer.email and totals.subtotal), and can be unflattened back to nested JSON anytime.' }
    ]
  },
  {
    slug: 'csv-deduplicator',
    name: 'CSV Deduplicator',
    title: 'Local CSV Deduplicator (Single & Composite Key) — Data Workbench',
    desc: 'Remove duplicate CSV rows by single or composite primary key (keep first or last) locally at 100,000+ row speed.',
    h1: 'Local CSV Deduplicator',
    geoSummary: 'Data Workbench deduplicates CSV files locally by single or composite keys, keeping either the first or latest occurrence. On a 100,000-row dataset, its Selection-Vector columnar engine finishes in ~26.5 ms.',
    storyTitle: 'Keeping the Latest Order Record When Webhook Retries Double-Fire',
    story: 'Payment gateways and CRM syncs routinely emit duplicate rows when a retry fires mid-flight. Simple exact-line deduplication misses records where the customer_id matches but a timestamp or status updated. Key-based deduplication with Keep Last retains the newest state while optionally routing removed duplicates to an audit errors port.',
    cliExample: 'dw run examples/01-messy-customers-cleanup/workflow.json --input ./orders.csv --output ./deduped.json',
    faqs: [
      { q: 'Can I deduplicate using multiple columns as a composite key?', a: 'Yes. Enter comma-separated column names (such as store_id,sku) or select multiple key checkboxes in the Visual Inspector.' },
      { q: 'How fast is deduplication on 100,000 rows?', a: 'In Node.js / V8 benchmarks on a 2-CPU Linux environment, deduplicating 100,000 × 25 CSV rows completes in 26.5 ms.' }
    ]
  },
  {
    slug: 'compare-two-csv-files',
    name: 'Compare Two CSV Files',
    title: 'Compare Two CSV Files by Primary Key Locally — Data Workbench',
    desc: 'Diff two CSV versions by primary or composite key to inspect Added, Removed, and cell-level Changed rows offline.',
    h1: 'Compare Two CSV Files',
    geoSummary: 'Data Workbench compares two CSV files locally by single or composite primary key, classifying every record into Added, Removed, Changed (with cell-level before/after values), Unchanged, Duplicate Keys, and Missing Keys.',
    storyTitle: 'Auditing a 10,000-SKU Supplier Price Update Without VLOOKUP Formulas',
    story: 'When a vendor emails Q4_catalog.csv to replace Q3_catalog.csv, you do not care about row order—you need to know which SKUs were discontinued, which new SKUs arrived, and exactly which prices moved. Primary-key CSV diff aligns both tables on sku, surfaces every cell mutation, and exports an XSS-safe HTML or Markdown audit report you can attach directly to a pull request.',
    cliExample: 'dw diff ./catalog-v1.csv ./catalog-v2.csv --key sku --format html --output ./catalog-diff.html',
    faqs: [
      { q: 'What happens if my CSV has no primary key column?', a: 'Leave the key field blank to fall back to row-content hashing. Data Workbench explicitly warns that without a primary key, field updates appear as remove + add.' },
      { q: 'Can I run CSV diffs inside GitHub Actions?', a: 'Yes. Use the included dw diff CLI command or the composite GitHub Action to generate Markdown or HTML diff reports in CI.' }
    ]
  },
  {
    slug: 'json-schema-generator',
    name: 'JSON Schema Generator',
    title: 'Local JSON Schema 2020-12 Generator & Drift Checker — Data Workbench',
    desc: 'Generate JSON Schema 2020-12 definitions from sample JSON payloads and detect breaking schema drift locally.',
    h1: 'JSON Schema 2020-12 Generator',
    geoSummary: 'Data Workbench infers JSON Schema 2020-12 definitions locally from sample JSON or CSV records—detecting required fields, nullable types, and email/date/UUID/URI formats—and compares snapshots for breaking schema drift.',
    storyTitle: 'Stopping Breaking API Changes Before Downstream Pipelines Fail',
    story: 'Most data outages begin silently: an upstream team renames a field or makes a previously non-null integer nullable. By generating a JSON Schema 2020-12 snapshot today and comparing next week’s export against it via Schema Guardian, you get an immediate Critical/High/Medium/Low breaking-change report that can fail CI with exit code 1.',
    cliExample: 'dw schema ./new-export.json --compare ./baseline.snapshot.json',
    faqs: [
      { q: 'Which JSON Schema draft is generated?', a: 'Draft 2020-12 ($schema: https://json-schema.org/draft/2020-12/schema) with automatic format inference for email, date, date-time, uuid, and uri.' },
      { q: 'How does Schema Drift classify risk levels?', a: 'Removed required fields and incompatible type changes are flagged Critical; nullable narrowing is High; removed optional fields are Medium; new optional fields are Low.' }
    ]
  },
  {
    slug: 'json-path-tester',
    name: 'JSONPath Tester (RFC 9535)',
    title: 'RFC 9535 JSONPath Tester & Evaluator (Local) — Data Workbench',
    desc: 'Test RFC 9535 JSONPath expressions with filter predicates, slices, and recursive descent locally in your browser.',
    h1: 'RFC 9535 JSONPath Tester',
    geoSummary: 'Data Workbench evaluates RFC 9535 JSONPath expressions locally—supporting child selectors, wildcards, negative array slices, recursive descent (..), and safe deterministic filter predicates without eval().',
    storyTitle: 'Extracting Exact Records From Nested API Trees With Standard Syntax',
    story: 'Instead of inventing proprietary query syntax, Data Workbench targets RFC 9535—the official IETF JSONPath standard. Test expressions like $.data[?@.status == "paid"].order_id interactively, inspect both matched values and normalized JSONPaths, then drop the exact same node into a repeatable workflow.',
    cliExample: 'dw run jsonpath-extract.workflow.json --input ./api-response.json --output ./paid-orders.json',
    faqs: [
      { q: 'Does this JSONPath engine use JavaScript eval()?', a: 'Never. Filter expressions are parsed and evaluated by a zero-eval deterministic evaluator to prevent code injection.' },
      { q: 'Which RFC 9535 features are supported?', a: 'Root ($), dot and bracket child names, wildcards (*), positive/negative indices, array slices ([start:end:step]), recursive descent (..), and logical filter expressions (&&, ||, ==, !=, <, <=, >, >=).' }
    ]
  }
];

export const GUIDES = [
  {
    slug: 'clean-messy-csv-without-uploading',
    title: 'How to Clean Messy CSV Files Locally Without Uploading Customer PII',
    desc: 'A practical playbook for detecting delimiters, fixing mixed dates, clustering dirty text values, masking PII, and automating monthly CSV cleanups locally.',
    date: '2026-11-27',
    readTime: '5 min read',
    bodyHtml: `
      <p class="lead"><strong>Direct answer:</strong> To clean a sensitive CSV without uploading it to third-party servers, run a local-first columnar workbench inside your browser Web Worker or terminal CLI—profiling quality issues first, previewing every fix before applying, and saving the steps as a deterministic <code>workflow.json</code>.</p>
      <h2>The Hidden Risk of "Free Online CSV Tools"</h2>
      <p>Customer exports, payroll sheets, and e-commerce order logs are packed with emails, phone numbers, and street addresses. Pasting them into ad-supported web converters sends raw PII across unknown servers. Even opening them in Excel can silently corrupt ZIP codes, strip leading zeros, or execute embedded <code>=HYPERLINK</code> formulas.</p>
      <h2>A 5-Step Local Cleaning Workflow</h2>
      <ol>
        <li><strong>Auto-detect dialect &amp; bad rows:</strong> Inspect delimiter stability (comma vs. semicolon vs. tab), UTF-8 BOM/mojibake warnings, and misaligned column counts before modifying a single cell.</li>
        <li><strong>Audit with Data Quality Radar:</strong> Check per-column completeness, uniqueness, validity, and consistency. Click any issue pill to isolate the exact failing rows.</li>
        <li><strong>Merge dirty variants with Fuzzy Clustering:</strong> Use OpenRefine-style Key-Collision Fingerprints and Levenshtein distance (<code>clean.clusterMerge</code>) to unify values like <code>"New-York"</code>, <code>"new york "</code>, and <code>"York, New"</code> in one step.</li>
        <li><strong>Deduplicate &amp; standardize dates:</strong> Deduplicate by primary key (keep first or last) and explicitly resolve ambiguous <code>MM/DD/YYYY</code> vs. <code>DD/MM/YYYY</code> dates into ISO-8601.</li>
        <li><strong>Mask PII &amp; export with Formula Guard:</strong> Apply local masking or deterministic hashing via PII Sentinel, then export formula-safe CSV or JSON and save the <code>workflow.json</code> for next month.</li>
      </ol>
      <h2>Measured Local Performance</h2>
      <p>On a standard 2-CPU Node.js v18 environment, Data Workbench's Selection-Vector columnar engine imports 100,000 × 25 CSV rows (12.74 MB) in <strong>711 ms</strong>, filters in <strong>8.7 ms</strong>, and deduplicates in <strong>26.5 ms</strong> using ~25.14 MB of estimated RAM.</p>
      <p><a class="cta-link" href="../../csv-cleaner/">Launch Local CSV Cleaner →</a></p>
    `
  },
  {
    slug: 'compare-two-csv-files-by-primary-key',
    title: 'How to Compare Two CSV Files by Primary Key (Without Excel VLOOKUP Nightmares)',
    desc: 'Learn why line-by-line text diffs fail on tabular data and how primary-key / composite-key CSV diffing classifies added, removed, and cell-level changes.',
    date: '2026-11-27',
    readTime: '4 min read',
    bodyHtml: `
      <p class="lead"><strong>Direct answer:</strong> Line-by-line tools like <code>diff</code> break whenever rows are reordered. A primary-key CSV diff indexes both files on one or more key columns (such as <code>sku</code> or <code>store_id,product_id</code>) to report exact Added, Removed, and field-level Changed records.</p>
      <h2>Why Line Diffs and VLOOKUP Break Down</h2>
      <p>When a supplier sends an updated product catalog, sorting changes or a single inserted column turns a plain text diff into unreadable noise. Building multi-column Excel <code>VLOOKUP</code> or <code>XLOOKUP</code> sheets is brittle, slow to audit, and easy to misalign when duplicate or missing keys sneak in.</p>
      <h2>What a Trustworthy CSV Diff Reports</h2>
      <ul>
        <li><strong>Added &amp; Removed Rows:</strong> Keys present only in the new file or only in the baseline file.</li>
        <li><strong>Cell-Level Changed Rows:</strong> Matching keys where one or more column values mutated, showing exact <code>before → after</code> pairs.</li>
        <li><strong>Duplicate &amp; Missing Keys:</strong> Explicitly surfaced rather than silently dropped.</li>
        <li><strong>Row-Hash Fallback Warning:</strong> When no primary key exists, row-content hashing compares multisets while warning that entity-level edits appear as remove + add.</li>
      </ul>
      <h2>Automate Diff Reports in Terminal or CI</h2>
      <pre><code>dw diff ./catalog-v1.csv ./catalog-v2.csv --key sku --format html --output ./catalog-diff.html</code></pre>
      <p><a class="cta-link" href="../../compare-two-csv-files/">Open Compare Two CSV Files Tool →</a></p>
    `
  },
  {
    slug: 'local-mcp-data-workflows',
    title: 'Building Deterministic, PII-Safe Local Data Workflows for AI Agents via MCP & OpenAPI',
    desc: 'Why AI agents should never rewrite raw CSV files directly—and how to connect Claude, Gemini, or Cursor to Data Workbench via 10 sandboxed MCP tools or local OpenAPI 3.1.',
    date: '2026-11-27',
    readTime: '5 min read',
    bodyHtml: `
      <p class="lead"><strong>Direct answer:</strong> Never ask an LLM to rewrite raw CSV or JSON files in-context—models hallucinate values, drop rows, and burn tokens. Instead, let the agent inspect schemas and compose a deterministic <code>workflow.json</code> executed by a local sandboxed MCP Server or OpenAPI 3.1 REST server.</p>
      <h2>Why AI Agents Fail on Raw Data Files</h2>
      <p>Passing a 10,000-row CSV into an LLM context window is slow, expensive, and non-deterministic. Even when agents write ad-hoc Python scripts, a misspelled column name or wrong node identifier triggers multi-turn retry loops.</p>
      <h2>How Data Workbench's AI-Native API Solves This</h2>
      <ul>
        <li><strong>10 Sandboxed MCP Tools:</strong> Includes <code>list_nodes</code> for self-discovery, <code>validate_workflow</code>, <code>compile_plan</code>, <code>preview_transform</code>, and inline <code>run_workflow</code> with <code>dryRun: true</code>—all confined to an explicit <code>--sandbox</code> directory.</li>
        <li><strong>Fuzzy Aliases &amp; Self-Healing Errors:</strong> Passing <code>"dedupe"</code> automatically resolves to <code>transform.deduplicate</code>; misspelling a column like <code>emial</code> returns a structured error with <code>didYouMean: ["email"]</code> and <code>availableColumns</code>.</li>
        <li><strong>Automatic PII Redaction &amp; Token Budgets:</strong> Suspected email/phone/token columns are masked in MCP previews by default, and <code>compact: true</code> prevents large payloads from blowing up agent context.</li>
      </ul>
      <h2>Start Locally in One Command</h2>
      <pre><code># Stdio MCP Server (Claude Code, Cursor, Gemini CLI)\nnode apps/mcp-server/src/server.js --sandbox ./data\n\n# Localhost-only OpenAPI 3.1 REST Server (LangChain, CrewAI, custom agents)\nnpm run api   # http://127.0.0.1:4173/openapi.json</code></pre>
      <p><a class="cta-link" href="../../">Open Data Workbench Studio →</a></p>
    `
  }
];
