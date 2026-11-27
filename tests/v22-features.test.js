import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { detectTextClusters, textFingerprint } from '../packages/quality-engine/index.js';
import { executeWorkflow, ENGINE_VERSION } from '../packages/workflow-core/index.js';
import { resolveNodeTypeFuzzy } from '../packages/ai-api/index.js';
import { parseCsv } from '../packages/csv-engine/index.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

test('v2.2 OpenRefine-style Fuzzy Clustering: Fingerprint + Levenshtein + clean.clusterMerge node', async () => {
  assert.equal(textFingerprint('New-York '), textFingerprint('York, new'));

  const dirtyCsv = [
    'id,city,tier',
    '1,New York,Enterprise',
    '2,new-york ,Enterprize',
    '3,New York,Enterprise',
    '4,"York, New",Enterprise',
    '5,San Francisco,Starter',
    '6,San Fransisco,Starter'
  ].join('\n');

  const ds = parseCsv(dirtyCsv);
  const tierClusters = detectTextClusters(ds, 'tier', { method: 'both', maxDistance: 2 });
  assert.equal(tierClusters.length, 1);
  assert.equal(tierClusters[0].canonical, 'Enterprise');

  // AI fuzzy alias resolves `cluster` -> `clean.clusterMerge`
  assert.equal(resolveNodeTypeFuzzy('cluster').resolved, 'clean.clusterMerge');

  const wf = {
    schemaVersion: '1.0',
    workflow: {
      id: 'cluster-test',
      name: 'Fuzzy Cluster Test',
      engineVersion: ENGINE_VERSION,
      nodes: [
        { id: 'src', type: 'source.csv', params: { header: true } },
        { id: 'cl-tier', type: 'clean.clusterMerge', params: { column: 'tier', method: 'both', maxDistance: 2 } }
      ],
      edges: [{ from: 'src', to: 'cl-tier' }]
    }
  };
  const res = await executeWorkflow(wf, { inputsByNodeId: { src: dirtyCsv } });
  assert.equal(res.status, 'success');
  const tiers = res.finalOutput.rows.map(r => r.tier);
  assert.equal(tiers.filter(t => t === 'Enterprise').length, 4, 'Expected Enterprize merged into Enterprise');
});

test('v2.2 Static SEO Landing Pages: 10 independent crawlable pages + clean non-hash sitemap.xml', () => {
  const distDir = path.join(ROOT, 'apps/web/dist');
  const expectedSlugs = [
    'csv-cleaner', 'json-formatter', 'json-validator', 'json-diff',
    'csv-to-json', 'json-to-csv', 'csv-deduplicator', 'compare-two-csv-files',
    'json-schema-generator', 'json-path-tester'
  ];

  const sitemap = fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf8');
  assert.ok(!sitemap.includes('#/'), 'Sitemap must use real static paths, not hash fragments');

  for (const slug of expectedSlugs) {
    const htmlPath = path.join(distDir, slug, 'index.html');
    assert.ok(fs.existsSync(htmlPath), `Missing static SEO page: ${slug}/index.html`);
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes(`/${slug}/`), `Missing canonical URL for ${slug}`);
    assert.ok(html.includes('"@type":"FAQPage"'), `Missing FAQPage JSON-LD for ${slug}`);
    assert.ok(html.includes(`window.__DW_INITIAL_TOOL__ = "${slug}"`), `Missing initial tool boot flag for ${slug}`);
    assert.ok(sitemap.includes(`/${slug}/`), `Missing ${slug} in sitemap.xml`);
  }
});

test('v2.2.2 US-English SEO + GEO: visible editorial stories, 3 deep-dive guides, llms-full.txt & 14-URL sitemap', () => {
  const distDir = path.join(ROOT, 'apps/web/dist');
  const csvCleanerHtml = fs.readFileSync(path.join(distDir, 'csv-cleaner/index.html'), 'utf8');
  assert.ok(csvCleanerHtml.includes('<article class="editorial-seo">'));
  assert.ok(csvCleanerHtml.includes('"@type":"BreadcrumbList"'));
  assert.ok(csvCleanerHtml.includes('geo-callout'));

  const guides = [
    'clean-messy-csv-without-uploading',
    'compare-two-csv-files-by-primary-key',
    'local-mcp-data-workflows'
  ];
  const sitemap = fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf8');
  for (const g of guides) {
    const gp = path.join(distDir, 'guides', g, 'index.html');
    assert.ok(fs.existsSync(gp), `Missing guide: ${g}`);
    const gHtml = fs.readFileSync(gp, 'utf8');
    assert.ok(gHtml.includes('"@type":"TechArticle"'));
    assert.ok(sitemap.includes(`/guides/${g}/`));
  }

  const llmsFull = fs.readFileSync(path.join(distDir, 'llms-full.txt'), 'utf8');
  assert.ok(llmsFull.includes('8.7 ms') && llmsFull.includes('26.5 ms'));
});
