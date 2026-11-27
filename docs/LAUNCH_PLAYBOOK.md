# Data Workbench 2.3 — Open-Source Launch Playbook (US Market)

## 1. Publish to npm (`npx` Zero-Clone Experience)
```bash
npm login
npm publish --access public
```
Once published, users and AI agents can launch immediately without cloning:
```bash
npx data-workbench run workflow.json --input orders.xlsx --output clean.json
npx data-workbench-mcp --sandbox ./data
```

## 2. Deploy GitHub Pages + Submit to Google Search Console
1. Push repository to `https://github.com/waterdolphinkiller/data-workbench`.
2. In **Settings → Pages**, deploy `apps/web/dist/` (or wire a GitHub Pages deploy step after `npm run build:web`).
3. Verify `https://waterdolphinkiller.github.io/data-workbench/` in Google Search Console and submit:
   `https://waterdolphinkiller.github.io/data-workbench/sitemap.xml` (14 clean static URLs: Studio + 10 Tool Landing Pages + 3 Guides).

## 3. MCP Directory Submissions (Glama / Smithery / awesome-mcp-servers)
```json
{
  "mcpServers": {
    "data-workbench": {
      "command": "npx",
      "args": ["-y", "data-workbench-mcp", "--sandbox", "./data"]
    }
  }
}
```

## 4. Hacker News (`Show HN`) & Reddit (`r/dataengineering`) Draft
**Title:** `Show HN: Data Workbench – Local-first visual CSV/XLSX/JSON workflow studio + 10-tool MCP server (0 deps)`

**Body:**
> I built an MIT-licensed, zero-dependency local data studio where the exact same `workflow.json` runs in a browser Web Worker, a terminal CLI (`dw`), GitHub Actions, a localhost OpenAPI 3.1 server, and a 10-tool sandboxed MCP server.
>
> Key things that scratched my own itch:
> - Selection-Vector columnar engine: 100k × 25 CSV filters in 8.7 ms, deduplicates in 26.5 ms (~25 MB RAM).
> - Native zero-dependency `.xlsx` (Excel) reader/writer + OpenRefine-style fuzzy text clustering (`clean.clusterMerge`).
> - Primary-key CSV diff, JSON Schema 2020-12 drift detection, Data Contracts, and Workflow Regression Tests.
> - AI-Native MCP API with fuzzy node aliases, `didYouMean` error recovery, automatic PII redaction, and `compact` token budgets.
>
> Live browser demo (0 bytes uploaded): https://waterdolphinkiller.github.io/data-workbench/
> GitHub: https://github.com/waterdolphinkiller/data-workbench
