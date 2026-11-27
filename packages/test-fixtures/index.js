/**
 * @module @data-workbench/test-fixtures
 * 3 built-in onboarding examples (Section 3.5) + Reproducible Benchmark Dataset Generator (Section 12.1).
 */

export const MESSY_CUSTOMERS_CSV = [
  'customer_id,full_name,email,phone,signup_date,plan,monthly_spend,status',
  '1001,  Alice Johnson ,ALICE@EXAMPLE.COM,+1-415-555-0101,2026-01-02,Pro,49.00,active',
  '1002,Bob Smith,bob.smith@example.com,+1-415-555-0102,02/03/2026,Starter,19.00,active',
  '1003,Carol Lin,CAROL.LIN@ACME.IO,+1-212-555-0199,2026-01-15,Enterprise,299.00,active',
  '1002,Bob Smith,bob.smith@example.com,+1-415-555-0102,2026-02-03,Starter,19.00,active',
  '1004,David Park,david.park@example.com,+1-650-555-0144,14/02/2026,Pro,49.00,churned',
  '1005,Eva Martinez,eva@startup.dev,N/A,2026-02-20,Starter,19.00,active',
  '1006,Frank Wu,FRANK@CORP.CO,+1-312-555-0188,not-a-date,Pro,49.00,paused',
  '1007,Grace Hopper,grace@navy.mil,+1-202-555-0177,2026-03-01,Enterprise,299.00,active',
  '1008,=HYPERLINK("http://evil.invalid"),henry@example.com,+1-512-555-0133,2026-03-05,Starter,19.00,active',
  '1009,  Iris Chen  ,iris.chen@example.com,+1-408-555-0122,03/10/2026,Pro,49.00,active',
  '1003,Carol Lin,carol.lin@acme.io,+1-212-555-0199,2026-01-15,Enterprise,299.00,active'
].join('\n');

export const API_RESPONSE_JSON = JSON.stringify({
  request_id: 'req_9f8a7b6c',
  fetched_at: '2026-11-27T09:30:00Z',
  data: [
    {
      order_id: 'ORD-5001',
      customer: { id: 'C-101', email: 'maya@shop.io', tier: 'gold' },
      totals: { subtotal: 120.0, tax: 10.8, currency: 'USD' },
      tags: ['express', 'gift'],
      created_at: '2026-11-20T14:22:00Z',
      status: 'paid'
    },
    {
      order_id: 'ORD-5002',
      customer: { id: 'C-102', email: 'liam@shop.io', tier: 'silver' },
      totals: { subtotal: 45.5, tax: 4.1, currency: 'USD' },
      tags: ['standard'],
      created_at: '2026-11-21T08:15:00Z',
      status: 'refunded'
    },
    {
      order_id: 'ORD-5003',
      customer: { id: 'C-103', email: 'noah@shop.io', tier: 'gold' },
      totals: { subtotal: 310.0, tax: 27.9, currency: 'USD' },
      tags: ['express', 'b2b'],
      created_at: '2026-11-22T19:05:00Z',
      status: 'paid'
    }
  ]
}, null, 2);

export const PRODUCT_CATALOG_V1_CSV = [
  'sku,name,category,price,stock,status',
  'SKU-101,Mechanical Keyboard 75%,Peripherals,129.00,45,active',
  'SKU-102,USB-C 4K Hub,Accessories,59.00,120,active',
  'SKU-103,Ergonomic Vertical Mouse,Peripherals,49.00,80,active',
  'SKU-104,27" IPS Studio Monitor,Displays,349.00,18,active',
  'SKU-105,Braided Thunderbolt Cable,Accessories,29.00,200,discontinued'
].join('\n');

export const PRODUCT_CATALOG_V2_CSV = [
  'sku,name,category,price,stock,status',
  'SKU-101,Mechanical Keyboard 75%,Peripherals,119.00,62,active',
  'SKU-102,USB-C 4K Hub,Accessories,59.00,120,active',
  'SKU-103,Ergonomic Vertical Mouse,Peripherals,54.00,64,active',
  'SKU-104,27" IPS Studio Monitor,Displays,329.00,25,active',
  'SKU-106,Webcam 4K HDR Pro,Peripherals,149.00,35,active'
].join('\n');

export const SAMPLE_CLEAN_WORKFLOW = {
  schemaVersion: '1.0',
  workflow: {
    id: 'messy-customers-cleanup',
    name: 'Messy Customer CSV Cleanup',
    engineVersion: '2.0.0',
    nodes: [
      { id: 'input-1', type: 'source.csv', version: '1.0.0', params: { header: true, delimiter: 'auto' } },
      { id: 'trim-1', type: 'clean.text', version: '1.0.0', params: { columns: ['full_name', 'email'], trim: true, normalizeNulls: true } },
      { id: 'lower-email', type: 'clean.text', version: '1.0.0', params: { columns: ['email'], case: 'lower' } },
      { id: 'dedupe-1', type: 'transform.deduplicate', version: '1.0.0', params: { keys: ['customer_id'], keep: 'last' } },
      { id: 'date-1', type: 'clean.dateNormalize', version: '1.0.0', params: { column: 'signup_date', sourceOrder: 'MDY', targetFormat: 'ISO-8601', invalidPolicy: 'keep' } },
      { id: 'profile-1', type: 'validate.qualityProfile', version: '1.0.0', params: {} },
      { id: 'output-1', type: 'output.json', version: '1.0.0', params: { pretty: true } }
    ],
    edges: [
      { from: 'input-1', to: 'trim-1' },
      { from: 'trim-1', to: 'lower-email' },
      { from: 'lower-email', to: 'dedupe-1' },
      { from: 'dedupe-1', to: 'date-1' },
      { from: 'date-1', to: 'profile-1' },
      { from: 'profile-1', to: 'output-1' }
    ]
  }
};

/**
 * Deterministic synthetic CSV generator for Benchmark Suites (CSV-S: 10k, CSV-M: 100k).
 */
export function generateBenchmarkCsv(rowCount = 10000, colCount = 12) {
  const baseCols = ['id', 'email', 'signup_date', 'country', 'plan', 'amount', 'status', 'score'];
  const cols = [...baseCols];
  for (let c = baseCols.length; c < colCount; c++) cols.push(`metric_${c}`);

  const countries = ['US', 'UK', 'DE', 'JP', 'SG', 'CA', 'AU'];
  const plans = ['Starter', 'Pro', 'Enterprise'];
  const statuses = ['active', 'paused', 'churned'];
  const lines = [cols.join(',')];

  for (let i = 1; i <= rowCount; i++) {
    // Inject ~2% duplicates for realistic dedupe testing
    const id = i % 50 === 0 ? i - 1 : i;
    const email = i % 7 === 0 ? `USER_${id}@EXAMPLE.COM` : `user_${id}@example.com`;
    const date = i % 10 === 0 ? `02/${String((i % 28) + 1).padStart(2, '0')}/2026` : `2026-02-${String((i % 28) + 1).padStart(2, '0')}`;
    const row = [
      id,
      email,
      date,
      countries[i % countries.length],
      plans[i % plans.length],
      ((i * 17) % 500 + 9.99).toFixed(2),
      statuses[i % statuses.length],
      (i * 31) % 100
    ];
    for (let c = baseCols.length; c < colCount; c++) {
      row.push((i + c) % 1000);
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
