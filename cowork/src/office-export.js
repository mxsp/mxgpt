'use strict';

/**
 * Zero-Dependency Office & Document Export Engine for mx-Cowork
 *
 * Generates real, valid office files using only Node.js built-ins (zlib + Buffer):
 *  - .docx (OpenXML Word document — opens natively in MS Word, LibreOffice, Google Docs)
 *  - .xlsx (OpenXML Excel workbook — opens natively in MS Excel, LibreOffice Calc, Google Sheets)
 *  - .ics  (RFC-5545 Calendar invite — opens in Outlook, Thunderbird, Apple/Google Calendar)
 *  - Print-ready HTML for Electron's native BrowserWindow.webContents.printToPDF()
 *  - CSV / TSV table parser for the built-in Data Desk viewer
 */

const zlib = require('zlib');

// ---- Pure Node.js PKZIP writer (CRC32 + deflateRawSync)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf, { level: 6 });
    const crc = crc32(rawBuf);

    // Local file header (30 bytes + name)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lfh.writeUInt16LE(8, 8); // deflate
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compBuf.length, 18);
    lfh.writeUInt32LE(rawBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    localParts.push(lfh, nameBuf, compBuf);

    // Central directory header (46 bytes + name)
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compBuf.length, 20);
    cdh.writeUInt32LE(rawBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);

    centralParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function xmlEsc(s) {
  return String(s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---- Clean Markdown Stripper for tool blocks
function cleanMarkdownForExport(md) {
  return String(md || '')
    .replace(/```(?:file-actions|code-run|memory-save|email-draft|action-items|calendar-event)[\s\S]*?```/gi, '')
    .trim();
}

// ---- DOCX Generator (OpenXML WordprocessingML)
function inlineRunsToWordXml(text) {
  // Parse **bold**, *italic*, `code`
  const tokens = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', val: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('**')) tokens.push({ kind: 'bold', val: tok.slice(2, -2) });
    else if (tok.startsWith('*')) tokens.push({ kind: 'italic', val: tok.slice(1, -1) });
    else if (tok.startsWith('`')) tokens.push({ kind: 'code', val: tok.slice(1, -1) });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ kind: 'text', val: text.slice(last) });
  if (!tokens.length) tokens.push({ kind: 'text', val: '' });

  return tokens.map((t) => {
    let rPr = '';
    if (t.kind === 'bold') rPr = '<w:rPr><w:b/></w:rPr>';
    else if (t.kind === 'italic') rPr = '<w:rPr><w:i/></w:rPr>';
    else if (t.kind === 'code') rPr = '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F1EFE9"/></w:rPr>';
    return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(t.val)}</w:t></w:r>`;
  }).join('');
}

function buildWordTableXml(rows) {
  if (!rows.length) return '';
  const trXml = rows.map((row, rIdx) => {
    const isHead = rIdx === 0;
    const cells = row.map((cell) => {
      const fill = isHead ? '<w:shd w:val="clear" w:fill="F3ECE6"/>' : '';
      const bold = isHead ? '<w:rPr><w:b/></w:rPr>' : '';
      const run = isHead
        ? `<w:r>${bold}<w:t xml:space="preserve">${xmlEsc(cell)}</w:t></w:r>`
        : inlineRunsToWordXml(cell);
      return `<w:tc><w:tcPr>${fill}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr><w:p>${run}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D8D3C8"/><w:bottom w:val="single" w:sz="4" w:color="D8D3C8"/><w:left w:val="single" w:sz="4" w:color="D8D3C8"/><w:right w:val="single" w:sz="4" w:color="D8D3C8"/><w:insideH w:val="single" w:sz="4" w:color="E6E2D8"/><w:insideV w:val="single" w:sz="4" w:color="E6E2D8"/></w:tblBorders></w:tblPr>${trXml}</w:tbl><w:p/>`;
}

function buildDocxBuffer(markdown, title = 'mx-Cowork Document') {
  const clean = cleanMarkdownForExport(markdown);
  const lines = clean.split(/\r?\n/);
  const bodyXml = [];

  // Document title header
  if (title && !lines[0]?.startsWith('# ')) {
    bodyXml.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEsc(title)}</w:t></w:r></w:p>`);
  }

  let inCode = false;
  let codeLines = [];
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length) {
      bodyXml.push(buildWordTableXml(tableRows));
      tableRows = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      flushTable();
      if (inCode) {
        for (const cl of codeLines) {
          bodyXml.push(`<w:p><w:pPr><w:shd w:val="clear" w:fill="F4F3EE"/><w:spacing w:before="20" w:after="20"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${xmlEsc(cl)}</w:t></w:r></w:p>`);
        }
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Markdown table row
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
      tableRows.push(cells);
      continue;
    }
    flushTable();

    if (!line.trim()) continue;
    const hm = line.match(/^(#{1,3})\s+(.+)$/);
    if (hm) {
      const style = hm[1].length === 1 ? 'Heading1' : hm[1].length === 2 ? 'Heading2' : 'Heading3';
      bodyXml.push(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${inlineRunsToWordXml(hm[2].trim())}</w:p>`);
      continue;
    }
    const ulm = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulm) {
      bodyXml.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="180"/><w:spacing w:after="80"/></w:pPr><w:r><w:t xml:space="preserve">• </w:t></w:r>${inlineRunsToWordXml(ulm[1])}</w:p>`);
      continue;
    }
    const olm = line.match(/^\s*(\d+\.)\s+(.+)$/);
    if (olm) {
      bodyXml.push(`<w:p><w:pPr><w:ind w:left="360" w:hanging="220"/><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(olm[1])} </w:t></w:r>${inlineRunsToWordXml(olm[2])}</w:p>`);
      continue;
    }
    bodyXml.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${inlineRunsToWordXml(line)}</w:p>`);
  }
  flushTable();

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml.join('\n    ')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:color w:val="1F1E1C"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="B54E2D"/><w:sz w:val="34"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="90"/></w:pPr><w:rPr><w:b/><w:color w:val="262624"/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="160" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="4A4742"/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

// ---- CSV / Markdown Table Extraction + XLSX Generator (OpenXML SpreadsheetML)
function parseCsvText(csvText) {
  const src = String(csvText || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  // Auto-detect delimiter (semicolon is common in European Excel CSVs!)
  const commaCnt = (firstLine.match(/,/g) || []).length;
  const semiCnt = (firstLine.match(/;/g) || []).length;
  const tabCnt = (firstLine.match(/\t/g) || []).length;
  const delim = tabCnt > commaCnt && tabCnt > semiCnt ? '\t' : (semiCnt > commaCnt ? ';' : ',');

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell.trim());
        if (row.some((v) => v !== '')) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    if (row.some((v) => v !== '')) rows.push(row);
  }
  return { delimiter: delim, rows };
}

function extractTablesFromMarkdown(md) {
  const lines = cleanMarkdownForExport(md).split(/\r?\n/);
  const sheets = [];
  let current = [];
  let lastHeading = '';

  const flush = () => {
    if (current.length >= 2) {
      sheets.push({ name: (lastHeading || `Table ${sheets.length + 1}`).slice(0, 28), rows: current });
    }
    current = [];
  };

  for (const line of lines) {
    const hm = line.match(/^#{1,3}\s+(.+)$/);
    if (hm) {
      flush();
      lastHeading = hm[1].replace(/[\\/*?:[\]]/g, '').trim();
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      current.push(cells);
    } else {
      flush();
    }
  }
  flush();

  // If no markdown tables found, put clean text lines into a single summary sheet
  if (!sheets.length) {
    const textRows = [['Section / Line']];
    for (const l of lines) {
      if (l.trim()) textRows.push([l.replace(/^#+\s*/, '').replace(/\*\*/g, '')]);
    }
    sheets.push({ name: 'Summary', rows: textRows });
  }
  return sheets;
}

function colLetter(n) {
  let s = '';
  let idx = n + 1;
  while (idx > 0) {
    const rem = (idx - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

function buildXlsxBuffer(sheetsInput) {
  const sheets = (Array.isArray(sheetsInput) && sheetsInput.length)
    ? sheetsInput
    : [{ name: 'Sheet1', rows: [['Empty']] }];

  const files = [];
  const sheetXmlMeta = [];

  sheets.forEach((sh, idx) => {
    const sName = String(sh.name || `Sheet${idx + 1}`).replace(/[\\/*?:[\]]/g, '').trim().slice(0, 31) || `Sheet${idx + 1}`;
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    const colWidths = [];

    const rowXml = rows.map((r, rIdx) => {
      const cellsXml = (Array.isArray(r) ? r : [r]).map((val, cIdx) => {
        const str = String(val ?? '');
        colWidths[cIdx] = Math.min(52, Math.max(colWidths[cIdx] || 10, str.length + 3));
        const ref = `${colLetter(cIdx)}${rIdx + 1}`;
        const styleAttr = rIdx === 0 ? ' s="1"' : '';
        const numClean = str.replace(/,/g, '');
        if (rIdx > 0 && /^-?\d+(?:\.\d+)?$/.test(numClean) && numClean.length <= 15) {
          return `<c r="${ref}"${styleAttr}><v>${numClean}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${xmlEsc(str)}</t></is></c>`;
      }).join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    }).join('');

    const colsXml = colWidths.length
      ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const wsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXml}
  <sheetData>${rowXml}</sheetData>
</worksheet>`;

    const sheetId = idx + 1;
    files.push({ name: `xl/worksheets/sheet${sheetId}.xml`, data: wsXml });
    sheetXmlMeta.push({ sheetId, name: sName });
  });

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetXmlMeta.map((s) => `<sheet name="${xmlEsc(s.name)}" sheetId="${s.sheetId}" r:id="rId${s.sheetId}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetXmlMeta.map((s) => `<Relationship Id="rId${s.sheetId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.sheetId}.xml"/>`).join('\n  ')}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF1F1E1C"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3ECE6"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetXmlMeta.map((s) => `<Override PartName="/xl/worksheets/sheet${s.sheetId}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/styles.xml', data: stylesXml },
    ...files,
  ]);
}

// ---- RFC-5545 Calendar Invite (.ics) Generator
function fmtIcsDate(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function icsEsc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildIcsText({ title = 'Follow-up Meeting', description = '', start = null, durationMin = 30, location = '' } = {}) {
  const startDt = start ? new Date(start) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(startDt.getTime())) startDt.setTime(Date.now() + 24 * 60 * 60 * 1000);
  const endDt = new Date(startDt.getTime() + Math.max(15, Number(durationMin) || 30) * 60000);
  const uid = `mxcowork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fyreflysystems.de`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mx-Cowork//FyreFly Systems//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtIcsDate(new Date())}`,
    `DTSTART:${fmtIcsDate(startDt)}`,
    `DTEND:${fmtIcsDate(endDt)}`,
    `SUMMARY:${icsEsc(title)}`,
    description ? `DESCRIPTION:${icsEsc(description)}` : '',
    location ? `LOCATION:${icsEsc(location)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}

// ---- Print-Grade HTML for Electron native printToPDF()
function htmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPrintableHtml(markdown, title = 'mx-Cowork Report') {
  const clean = cleanMarkdownForExport(markdown);
  const lines = clean.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let tableRows = [];
  let inUl = false;

  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  const flushTable = () => {
    if (!tableRows.length) return;
    const [head, ...rest] = tableRows;
    out.push('<table><thead><tr>' + head.map((c) => `<th>${htmlEsc(c)}</th>`).join('') + '</tr></thead><tbody>'
      + rest.map((r) => '<tr>' + r.map((c) => `<td>${inlineHtml(c)}</td>`).join('') + '</tr>').join('')
      + '</tbody></table>');
    tableRows = [];
  };
  const inlineHtml = (t) => htmlEsc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeUl(); flushTable();
      if (inCode) {
        out.push(`<pre><code>${htmlEsc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = []; inCode = false;
      } else { inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeUl();
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      tableRows.push(cells);
      continue;
    }
    flushTable();
    const hm = line.match(/^(#{1,3})\s+(.+)$/);
    if (hm) { closeUl(); out.push(`<h${hm[1].length}>${inlineHtml(hm[2])}</h${hm[1].length}>`); continue; }
    const ulm = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ulm) { if (!inUl) { out.push('<ul>'); inUl = true; } out.push(`<li>${inlineHtml(ulm[1])}</li>`); continue; }
    if (!line.trim()) { closeUl(); continue; }
    closeUl();
    out.push(`<p>${inlineHtml(line)}</p>`);
  }
  closeUl(); flushTable();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${htmlEsc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f1e1c; line-height: 1.6; font-size: 11pt; max-width: 100%; }
  .doc-head { border-bottom: 2px solid #c96442; padding-bottom: 8px; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: baseline; }
  .doc-head h1 { margin: 0; font-size: 18pt; color: #1f1e1c; }
  .doc-head small { color: #7a766e; font-size: 9pt; }
  h1, h2, h3 { color: #1f1e1c; page-break-after: avoid; }
  h2 { color: #b54e2d; font-size: 13.5pt; margin-top: 18px; }
  h3 { font-size: 11.5pt; margin-top: 14px; }
  p { margin: 0 0 9px; }
  ul { margin: 6px 0 10px; padding-left: 20px; }
  li { margin: 3px 0; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 9.5pt; background: #f4f2ec; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f4f2ec; padding: 10px 12px; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 9pt; border: 1px solid #e5e1d8; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 9.5pt; }
  th { text-align: left; background: #f3ece6; border: 1px solid #d8d3c8; padding: 6px 8px; font-weight: 600; }
  td { border: 1px solid #e4dfd5; padding: 5px 8px; vertical-align: top; }
</style>
</head>
<body>
  <div class="doc-head"><h1>${htmlEsc(title)}</h1><small>Generated by mx-Cowork · ${htmlEsc(new Date().toLocaleDateString())}</small></div>
  ${out.join('\n  ')}
</body>
</html>`;
}

module.exports = {
  createZipBuffer,
  buildDocxBuffer,
  buildXlsxBuffer,
  extractTablesFromMarkdown,
  parseCsvText,
  buildIcsText,
  buildPrintableHtml,
};
