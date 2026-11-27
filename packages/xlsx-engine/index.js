/**
 * @module @data-workbench/xlsx-engine
 * Zero-dependency isomorphic Microsoft Excel (.xlsx / OpenXML) reader & writer for Browser and Node.js.
 *  - Reads standard ZIP (Store method 0 + Deflate method 8 via zlib in Node or DecompressionStream in Browser)
 *  - Parses sharedStrings.xml, inlineStr, numeric/boolean cells, and sheet1.xml
 *  - Writes 100% Excel/LibreOffice/openpyxl-compatible .xlsx files with CSV/Excel Formula Injection Guard
 */

import { FORMULA_PREFIXES } from '../csv-engine/index.js';

// CRC-32 lookup table for ZIP archive generation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compressed);
      writer.close();
      const out = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(out);
    } catch {
      // Node 18 DecompressionStream lacks 'deflate-raw'; fall through to node:zlib
    }
  }
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.inflateRawSync(compressed));
}

/**
 * Minimal ZIP reader supporting Store (0) and Deflate (8) entries.
 */
async function unzipEntries(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Invalid .xlsx file: ZIP End of Central Directory not found.');

  const cdCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');

  for (let n = 0; n < cdCount; n++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localOffset = view.getUint32(cdOffset + 42, true);
    const name = dec.decode(u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
    cdOffset += 46 + nameLen + extraLen + commentLen;

    // Read local header to find exact data start
    const lhNameLen = view.getUint16(localOffset + 26, true);
    const lhExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const rawSlice = u8.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(name, rawSlice);
    } else if (method === 8) {
      entries.set(name, await inflateRaw(rawSlice));
    }
  }
  return entries;
}

/**
 * Minimal ZIP writer (Store method 0 — 100% standard ZIP, zero external deps, works identically in Browser & Node).
 */
function zipEntries(files) {
  const enc = new TextEncoder();
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const dataBytes = content instanceof Uint8Array ? content : enc.encode(String(content));
    const crc = crc32(dataBytes);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // Store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, dataBytes);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += lh.length + dataBytes.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, cdParts.length, true);
  ev.setUint16(10, cdParts.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const totalLen = cdStart + cdSize + 22;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of [...localParts, ...cdParts, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function indexToColLetters(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Parse an .xlsx Uint8Array / ArrayBuffer into { columns, rows, badRows, meta }.
 */

/**
 * List all worksheet names and paths inside an .xlsx workbook.
 */
export async function listXlsxSheets(bytes) {
  const entries = await unzipEntries(bytes);
  const dec = new TextDecoder('utf-8');
  const sheets = [];
  if (entries.has('xl/workbook.xml')) {
    const wbXml = dec.decode(entries.get('xl/workbook.xml'));
    const matches = [...wbXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*sheetId="(\d+)"[^>]*>/gi)];
    matches.forEach((m, idx) => {
      sheets.push({ name: unescapeXml(m[1]), sheetId: Number(m[2]), path: `xl/worksheets/sheet${idx + 1}.xml` });
    });
  }
  if (sheets.length === 0) {
    Array.from(entries.keys())
      .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort()
      .forEach((k, idx) => sheets.push({ name: `Sheet${idx + 1}`, sheetId: idx + 1, path: k }));
  }
  return sheets;
}

export async function parseXlsx(bytes, options = {}) {
  const entries = await unzipEntries(bytes);
  const dec = new TextDecoder('utf-8');

  // 1. Parse sharedStrings.xml if present
  const sharedStrings = [];
  if (entries.has('xl/sharedStrings.xml')) {
    const ssXml = dec.decode(entries.get('xl/sharedStrings.xml'));
    const siMatches = ssXml.match(/<si\b[\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)];
      sharedStrings.push(tMatches.map(m => unescapeXml(m[1])).join(''));
    }
  }

  // 2. Locate first worksheet
  let sheetKey = options.sheetPath;
  if (!sheetKey && options.sheetName && entries.has('xl/workbook.xml')) {
    const wbXml = dec.decode(entries.get('xl/workbook.xml'));
    const matches = [...wbXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*>/gi)];
    const foundIdx = matches.findIndex(m => unescapeXml(m[1]).toLowerCase() === String(options.sheetName).toLowerCase());
    if (foundIdx !== -1) sheetKey = `xl/worksheets/sheet${foundIdx + 1}.xml`;
  }
  if (!sheetKey) sheetKey = Array.from(entries.keys()).find(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!sheetKey) throw new Error('No worksheet found inside .xlsx archive.');

  const sheetXml = dec.decode(entries.get(sheetKey));
  const rowMatches = sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  const rawGrid = [];
  let maxCols = 0;

  for (const rowXml of rowMatches) {
    const rowArr = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let m;
    while ((m = cellRegex.exec(rowXml)) !== null) {
      const attrs = m[1];
      const inner = m[2];
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/i);
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1].toUpperCase()) : rowArr.length;
      const cellType = typeMatch ? typeMatch[1] : 'n';

      let val = null;
      if (cellType === 'inlineStr') {
        const tMatches = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)];
        val = tMatches.map(x => unescapeXml(x[1])).join('');
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          const rawV = unescapeXml(vMatch[1]);
          if (cellType === 's') val = sharedStrings[Number(rawV)] ?? '';
          else if (cellType === 'b') val = rawV === '1';
          else if (cellType === 'str' || cellType === 'e') val = rawV;
          else val = rawV !== '' && !Number.isNaN(Number(rawV)) ? Number(rawV) : rawV;
        }
      }
      rowArr[colIdx] = val;
      if (colIdx + 1 > maxCols) maxCols = colIdx + 1;
    }
    rawGrid.push(rowArr);
  }

  if (rawGrid.length === 0) {
    return { columns: [], rows: [], badRows: [], meta: { format: 'xlsx', sheet: sheetKey } };
  }

  const hasHeader = options.header !== false;
  const columns = hasHeader
    ? Array.from({ length: maxCols }, (_, i) => {
        const h = rawGrid[0][i];
        return h !== null && h !== undefined && String(h).trim() !== '' ? String(h).trim() : `column_${i + 1}`;
      })
    : Array.from({ length: maxCols }, (_, i) => `column_${i + 1}`);

  const startRow = hasHeader ? 1 : 0;
  const rows = [];
  for (let r = startRow; r < rawGrid.length; r++) {
    const obj = {};
    let hasAny = false;
    for (let c = 0; c < columns.length; c++) {
      const v = rawGrid[r][c] ?? null;
      if (v !== null && v !== '') hasAny = true;
      obj[columns[c]] = v;
    }
    if (hasAny) rows.push(obj);
  }

  return {
    columns,
    rows,
    badRows: [],
    meta: { format: 'xlsx', sheet: sheetKey, totalRows: rows.length }
  };
}

/**
 * Serialize tabular dataset / DataHandle into a standards-compliant .xlsx Uint8Array.
 * Applies Excel Formula Injection Protection by default.
 */
export function serializeXlsx(dataset, options = {}) {
  const sheetName = (options.sheetName || 'Data').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Data';
  const formulaGuard = options.formulaGuard !== false;
  const columns = dataset.columns && dataset.columns.length > 0
    ? dataset.columns
    : (dataset.rows?.[0] ? Object.keys(dataset.rows[0]) : []);
  const rows = dataset.rows || [];

  const rowXmls = [];
  // Header row
  const headerCells = columns.map((col, c) =>
    `<c r="${indexToColLetters(c)}1" t="inlineStr"><is><t>${escapeXml(col)}</t></is></c>`
  ).join('');
  rowXmls.push(`<row r="1">${headerCells}</row>`);

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const excelRow = r + 2;
    const cells = [];
    for (let c = 0; c < columns.length; c++) {
      const raw = rows[r][columns[c]];
      if (raw === null || raw === undefined || raw === '') continue;
      const ref = `${indexToColLetters(c)}${excelRow}`;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        cells.push(`<c r="${ref}"><v>${raw}</v></c>`);
      } else if (typeof raw === 'boolean') {
        cells.push(`<c r="${ref}" t="b"><v>${raw ? 1 : 0}</v></c>`);
      } else {
        let str = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
        if (formulaGuard && str.length > 0 && FORMULA_PREFIXES.includes(str[0])) {
          str = `'${str}`;
        }
        cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(str)}</t></is></c>`);
      }
    }
    rowXmls.push(`<row r="${excelRow}">${cells.join('')}</row>`);
  }

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXmls.join('')}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  return zipEntries({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/worksheets/sheet1.xml': sheetXml
  });
}

/**
 * Inspect Apache Parquet magic bytes ("PAR1") for DuckDB-Wasm adapter handoff.
 */
export function inspectParquetHeader(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dec = new TextDecoder('ascii');
  const head = u8.length >= 4 ? dec.decode(u8.subarray(0, 4)) : '';
  const tail = u8.length >= 4 ? dec.decode(u8.subarray(u8.length - 4)) : '';
  return {
    validParquetMagic: head === 'PAR1' && tail === 'PAR1',
    sizeBytes: u8.length
  };
}
