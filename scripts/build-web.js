#!/usr/bin/env node
/**
 * Zero-dependency bundler (v2.2.2 — US-English SEO + GEO Edition):
 * 1. Compiles packages/* + apps/web into pure full-screen `apps/web/dist/index.html` (with inline Blob Worker).
 * 2. Generates 10 independent crawlable static SEO tool pages (`apps/web/dist/<slug>/index.html`):
 *    - Above the fold: immediate, full-featured local tool (88vh).
 *    - Below the fold: visible human-readable US-English story, GEO direct-answer block,
 *      CLI snippet, FAQs (mirrored in FAQPage + WebApplication + BreadcrumbList JSON-LD), and internal links.
 * 3. Generates 3 static deep-dive editorial guides (`apps/web/dist/guides/<slug>/index.html`).
 * 4. Generates `llms.txt`, `llms-full.txt`, `robots.txt`, and clean non-hash `sitemap.xml` (14 URLs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, SEO_PAGES, GUIDES } from './seo-content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const engineModules = [
  'packages/engine-core/index.js',
  'packages/csv-engine/index.js',
  'packages/xlsx-engine/index.js',
  'packages/json-engine/index.js',
  'packages/quality-engine/index.js',
  'packages/diff-engine/index.js',
  'packages/workflow-schema/index.js',
  'packages/node-registry/index.js',
  'packages/workflow-core/index.js',
  'packages/test-fixtures/index.js'
];

function stripImportsAndExports(code, relPath) {
  let out = code
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+\{[\s\S]*?\};?\s*$/gm, '')
    .replace(/^export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+/gm, '$1 ');

  if (relPath === 'packages/workflow-schema/index.js') {
    out = out.replace(/\bREGEX_(EMAIL|DATE|DATETIME|UUID|URI)\b/g, 'SCHEMA_REGEX_$1');
  }
  if (relPath === 'packages/xlsx-engine/index.js') {
    out = out.replace(/\b(escapeXml|unescapeXml)\b/g, 'xlsx_$1');
  }
  return out;
}

const bundledEngineJs = engineModules.map(rel => {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  return `// === ${rel} ===\n${stripImportsAndExports(src, rel)}`;
}).join('\n\n');

const appJs = stripImportsAndExports(fs.readFileSync(path.join(root, 'apps/web/app.js'), 'utf8'), 'apps/web/app.js');
const workerBody = stripImportsAndExports(fs.readFileSync(path.join(root, 'apps/web/worker.js'), 'utf8'), 'apps/web/worker.js');
const fullWorkerSource = `${bundledEngineJs}\n\n// === apps/web/worker.js ===\n${workerBody}`;
const mainBundle = `window.__DW_WORKER_SOURCE__ = ${JSON.stringify(fullWorkerSource)};\n\n${bundledEngineJs}\n\n// === apps/web/app.js ===\n${appJs}`;

const css = fs.readFileSync(path.join(root, 'apps/web/styles.css'), 'utf8');
const htmlTemplate = fs.readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');

const editorialCss = `
/* White-hat Editorial SEO/GEO Section (Below-the-Fold on Tool Landing Pages & Guides) */
body.has-editorial { overflow-y: auto !important; height: auto !important; }
body.has-editorial .app-shell { height: 88vh; min-height: 620px; border-bottom: 1px solid var(--border-strong); }
.editorial-seo {
  max-width: 880px;
  margin: 0 auto;
  padding: 52px 24px 80px;
  color: var(--text-0);
  font-family: var(--font-sans);
  line-height: 1.7;
}
.editorial-seo .breadcrumb { font-size: 12px; color: var(--text-2); margin-bottom: 16px; }
.editorial-seo .breadcrumb a { color: var(--text-1); text-decoration: none; }
.editorial-seo .breadcrumb a:hover { color: var(--accent); }
.editorial-seo h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 14px; line-height: 1.25; }
.editorial-seo h2 { font-size: 19px; font-weight: 600; margin: 32px 0 10px; letter-spacing: -0.01em; }
.editorial-seo p { color: var(--text-1); font-size: 14.5px; margin-bottom: 14px; }
.editorial-seo .geo-callout {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: 14px 18px;
  margin: 18px 0 26px;
  font-size: 14px;
  color: var(--text-0);
}
.editorial-seo pre {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text-0);
  margin: 12px 0 20px;
}
.editorial-seo code { font-family: var(--font-mono); font-size: 12.5px; }
.editorial-seo details.faq-item {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 8px;
}
.editorial-seo details.faq-item summary { font-weight: 600; font-size: 14px; cursor: pointer; color: var(--text-0); }
.editorial-seo details.faq-item p { margin: 8px 0 0; font-size: 13.5px; }
.editorial-seo .link-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.editorial-seo .link-pill {
  display: inline-block;
  padding: 5px 11px;
  border-radius: 5px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  color: var(--text-1);
  text-decoration: none;
  font-size: 12.5px;
}
.editorial-seo .link-pill:hover { border-color: var(--accent); color: var(--text-0); }
.editorial-seo ol, .editorial-seo ul { padding-left: 20px; margin-bottom: 16px; color: var(--text-1); font-size: 14.5px; }
.editorial-seo li { margin-bottom: 8px; }
.editorial-seo .cta-link {
  display: inline-block;
  margin-top: 12px;
  padding: 9px 16px;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-weight: 600;
  font-size: 13.5px;
}
`;

const distDir = path.join(root, 'apps/web/dist');
fs.mkdirSync(distDir, { recursive: true });

// 1. Main Studio index.html (pure full-screen IDE)
const standaloneHtml = htmlTemplate
  .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script type="module">\n${mainBundle}\n</script>`);

const studioDir = path.join(distDir, 'studio');
fs.mkdirSync(studioDir, { recursive: true });
fs.writeFileSync(path.join(studioDir, 'index.html'), standaloneHtml, 'utf8');
if (fs.existsSync(path.join(root, 'apps/web/landing.html'))) {
  fs.copyFileSync(path.join(root, 'apps/web/landing.html'), path.join(distDir, 'index.html'));
} else {
  fs.writeFileSync(path.join(distDir, 'index.html'), standaloneHtml, 'utf8');
}

// 2. 10 Independent Crawlable Static SEO + GEO Tool Landing Pages
const toolLinksHtml = (prefix) => SEO_PAGES.map(p => `<a class="link-pill" href="${prefix}${p.slug}/">${p.name}</a>`).join('');
const guideLinksHtml = (prefix) => GUIDES.map(g => `<a class="link-pill" href="${prefix}guides/${g.slug}/">${g.title}</a>`).join('');

for (const page of SEO_PAGES) {
  const canonical = `${BASE_URL}/${page.slug}/`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: page.h1,
        url: canonical,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web, Windows, macOS, Linux',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        description: page.desc
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Data Workbench', item: `${BASE_URL}/` },
          { '@type': 'ListItem', position: 2, name: page.name, item: canonical }
        ]
      },
      {
        '@type': 'FAQPage',
        mainEntity: page.faqs.map(f => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a }
        }))
      }
    ]
  });

  const faqsHtml = page.faqs.map(f => `<details class="faq-item" open><summary>${f.q}</summary><p>${f.a}</p></details>`).join('\n');

  const seoHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${page.title}</title>
  <meta name="description" content="${page.desc}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${page.title}">
  <meta property="og:description" content="${page.desc}">
  <meta property="og:url" content="${canonical}">
  <script type="application/ld+json">${jsonLd}</script>
  <style>\n${css}\n${editorialCss}\n</style>
</head>
<body class="has-editorial">
  <div id="app" class="app-shell"></div>
  <article class="editorial-seo">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="../">Data Workbench Studio</a> / <span>${page.name}</span></nav>
    <h1>${page.h1}</h1>
    <div class="geo-callout">${page.geoSummary}</div>
    <h2>${page.storyTitle}</h2>
    <p>${page.story}</p>
    <h2>Run the Same Step in Terminal or CI</h2>
    <pre><code>${page.cliExample}</code></pre>
    <h2>Frequently Asked Questions</h2>
    ${faqsHtml}
    <h2>More Local-First Tools</h2>
    <div class="link-grid">${toolLinksHtml('../')}</div>
    <h2>Engineering Guides</h2>
    <div class="link-grid">${guideLinksHtml('../')}</div>
  </article>
  <input id="file-upload-input" type="file" accept=".csv,.tsv,.xlsx,.json,.ndjson,.jsonl,.yaml,.yml,.xml,.txt" style="display:none">
  <input id="workflow-import-input" type="file" accept=".json" style="display:none">
  <script>window.__DW_INITIAL_TOOL__ = ${JSON.stringify(page.slug)};</script>
  <script type="module">\n${mainBundle}\n</script>
</body>
</html>`;

  const pageDir = path.join(distDir, page.slug);
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'index.html'), seoHtml, 'utf8');
}

// 3. 3 Deep-Dive Static Editorial Guides (/guides/<slug>/index.html)
for (const guide of GUIDES) {
  const canonical = `${BASE_URL}/guides/${guide.slug}/`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: guide.title,
        description: guide.desc,
        datePublished: guide.date,
        author: { '@type': 'Person', name: 'waterdolphinkiller' },
        mainEntityOfPage: canonical
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Data Workbench', item: `${BASE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: `${BASE_URL}/guides/${guide.slug}/` }
        ]
      }
    ]
  });

  const guideHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${guide.title} — Data Workbench</title>
  <meta name="description" content="${guide.desc}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${guide.title}">
  <meta property="og:description" content="${guide.desc}">
  <meta property="og:url" content="${canonical}">
  <script type="application/ld+json">${jsonLd}</script>
  <style>\n${css}\n${editorialCss}\n</style>
</head>
<body class="has-editorial">
  <article class="editorial-seo">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="../../">Data Workbench Studio</a> / <span>Guide</span></nav>
    <h1>${guide.title}</h1>
    <p style="font-size:12px;color:var(--text-2);margin-bottom:22px;">Published ${guide.date} · ${guide.readTime} · Local-First Engineering</p>
    ${guide.bodyHtml}
    <h2>Explore All 10 Local Tools</h2>
    <div class="link-grid">${toolLinksHtml('../../')}</div>
  </article>
</body>
</html>`;

  const gDir = path.join(distDir, 'guides', guide.slug);
  fs.mkdirSync(gDir, { recursive: true });
  fs.writeFileSync(path.join(gDir, 'index.html'), guideHtml, 'utf8');
}

// 4. Clean Non-Hash XML Sitemap (14 URLs), robots.txt, llms.txt & llms-full.txt
const sitemapUrls = [
  `  <url><loc>${BASE_URL}/</loc><priority>1.0</priority></url>`,
  ...SEO_PAGES.map(p => `  <url><loc>${BASE_URL}/${p.slug}/</loc><priority>0.9</priority></url>`),
  ...GUIDES.map(g => `  <url><loc>${BASE_URL}/guides/${g.slug}/</loc><priority>0.85</priority></url>`)
].join('\n');

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls}\n</urlset>\n`;
fs.writeFileSync(path.join(distDir, 'sitemap.xml'), sitemapXml, 'utf8');
fs.writeFileSync(path.join(root, 'apps/web/sitemap.xml'), sitemapXml, 'utf8');
fs.copyFileSync(path.join(root, 'apps/web/robots.txt'), path.join(distDir, 'robots.txt'));

const llmsTxt = `# Data Workbench 2.2
> Local-first Visual Data Transformation & Automation Studio — Turn messy files into reliable, repeatable, testable data workflows with zero uploads.

## Core Pages
- Main Studio: ${BASE_URL}/
- Full Knowledge Base for AI Citations: ${BASE_URL}/llms-full.txt
- GitHub Repository: https://github.com/waterdolphinkiller/data-workbench

## 10 Free Local Tools
${SEO_PAGES.map(p => `- [${p.name}](${BASE_URL}/${p.slug}/): ${p.desc}`).join('\n')}

## Engineering Guides
${GUIDES.map(g => `- [${g.title}](${BASE_URL}/guides/${g.slug}/): ${g.desc}`).join('\n')}
`;

const llmsFullTxt = `# Data Workbench 2.2 — Complete Technical Reference (GEO Knowledge Base)

## Overview
Data Workbench is an MIT-licensed, zero-dependency, local-first visual data transformation, quality auditing, primary-key diffing, and workflow automation studio. The exact same deterministic engine runs across Browser Web Workers, the \`dw\` CLI, GitHub Actions, a 10-tool sandboxed MCP Server, and a localhost-only OpenAPI 3.1 REST Server.

## Verified Engine Benchmarks (Node.js v18.20.4, 2-CPU Linux x64)
- **CSV-S (10,000 rows × 12 cols, 0.77 MB):** Import 63.1 ms | Filter 1.3 ms | Deduplicate 4.7 ms | Profile 23.6 ms | Export 15.5 ms | Est. RAM 1.40 MB
- **CSV-M (100,000 rows × 25 cols, 12.74 MB):** Import 711.0 ms | Filter 8.7 ms | Deduplicate 26.5 ms | Profile 262.7 ms | Export 124.8 ms | Est. RAM 25.14 MB
- **CSV-L-lite (250,000 rows × 12 cols, 20.12 MB):** Import 1,131.5 ms | Filter 2.6 ms | Deduplicate 73.3 ms | Profile 310.6 ms | Export 247.6 ms | Est. RAM 34.95 MB

## Key Differentiators vs. Alternatives
- **vs. Duck-UI / Huey:** Duck-UI and Huey excel at ad-hoc browser SQL and pivot analytics. Data Workbench focuses on repeatable multi-step DAG cleaning pipelines, primary-key CSV diffs, Data Contracts, Schema Drift CI gates, and AI-Native MCP/OpenAPI automation.
- **vs. OpenRefine:** Brings OpenRefine-style fuzzy text clustering (Key-Collision Fingerprint + Levenshtein) into a zero-install browser studio with modern visual DAG workflows and CLI/CI parity—no Java runtime required.
- **vs. Easy Data Transform:** MIT open-source and zero-install in the browser with native Git/CI/MCP/OpenAPI integration.

## Security & Privacy Guarantees
- 100% local execution; zero file uploads and zero cell telemetry.
- Zero \`eval()\` or \`new Function()\` in JSONPath (RFC 9535) and SQL-lite evaluators.
- CSV Formula Injection Guard enabled by default (escapes leading \`=\`, \`+\`, \`-\`, \`@\`).
- Directory-sandboxed MCP server with automatic PII redaction on previews.
- Localhost-only (\`127.0.0.1\`) OpenAPI 3.1 REST Server.

## Tool & Guide Index
${SEO_PAGES.map(p => `### ${p.h1} (${BASE_URL}/${p.slug}/)\n${p.geoSummary}\nCLI: \`${p.cliExample}\`\n`).join('\n')}
`;

fs.writeFileSync(path.join(distDir, 'llms.txt'), llmsTxt, 'utf8');
fs.writeFileSync(path.join(root, 'apps/web/llms.txt'), llmsTxt, 'utf8');
fs.writeFileSync(path.join(distDir, 'llms-full.txt'), llmsFullTxt, 'utf8');
fs.writeFileSync(path.join(root, 'apps/web/llms-full.txt'), llmsFullTxt, 'utf8');

console.log(`Built v2.2.2 Studio + 10 SEO Tool Pages + 3 Editorial Guides + llms-full.txt + 14-URL sitemap.xml in ${distDir}`);
