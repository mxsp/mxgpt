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
      const rowArr = Array.isArray(r) ? r : [r];
      const firstCell = String(rowArr[0] ?? '').trim();
      const isTotalRow = rIdx > 0 && /^(total|sum|subtotal|gesamt|summe)\b/i.test(firstCell);
      const cellsXml = rowArr.map((val, cIdx) => {
        const str = String(val ?? '');
        colWidths[cIdx] = Math.min(52, Math.max(colWidths[cIdx] || 10, str.length + 3));
        const ref = `${colLetter(cIdx)}${rIdx + 1}`;
        const baseStyle = rIdx === 0 ? 1 : (isTotalRow ? 2 : 0);
        if (str.startsWith('=') && str.length > 1) {
          return `<c r="${ref}" s="${baseStyle}"><f>${xmlEsc(str.slice(1))}</f></c>`;
        }
        if (rIdx > 0) {
          const eurM = str.match(/^€\s*(-?\d[\d,]*(?:\.\d+)?)$/) || str.match(/^(-?\d[\d,]*(?:\.\d+)?)\s*€$/);
          if (eurM) {
            const n = eurM[1].replace(/,/g, '');
            return `<c r="${ref}" s="${isTotalRow ? 6 : 3}"><v>${n}</v></c>`;
          }
          const usdM = str.match(/^\$\s*(-?\d[\d,]*(?:\.\d+)?)$/);
          if (usdM) {
            const n = usdM[1].replace(/,/g, '');
            return `<c r="${ref}" s="${isTotalRow ? 7 : 4}"><v>${n}</v></c>`;
          }
          const pctM = str.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
          if (pctM) {
            const n = (Number(pctM[1]) / 100).toString();
            return `<c r="${ref}" s="5"><v>${n}</v></c>`;
          }
          const numClean = str.replace(/,/g, '');
          if (/^-?\d+(?:\.\d+)?$/.test(numClean) && numClean.length <= 15) {
            return `<c r="${ref}" s="${baseStyle}"><v>${numClean}</v></c>`;
          }
        }
        return `<c r="${ref}" t="inlineStr" s="${baseStyle}"><is><t xml:space="preserve">${xmlEsc(str)}</t></is></c>`;
      }).join('');
      return `<row r="${rIdx + 1}">${cellsXml}</row>`;
    }).join('');

    const colsXml = colWidths.length
      ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const sheetViewsXml = rows.length > 1
      ? `<sheetViews><sheetView${idx === 0 ? ' tabSelected="1"' : ''} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '';
    const autoFilterXml = rows.length > 1 && colWidths.length > 0
      ? `<autoFilter ref="A1:${colLetter(colWidths.length - 1)}1"/>`
      : '';

    const wsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${sheetViewsXml}
  ${colsXml}
  <sheetData>${rowXml}</sheetData>
  ${autoFilterXml}
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
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="€#,##0.00"/>
    <numFmt numFmtId="165" formatCode="$#,##0.00"/>
    <numFmt numFmtId="166" formatCode="0.0%"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF1F1E1C"/><name val="Calibri"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3ECE6"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF7F4EE"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE6E2D8"/></left><right style="thin"><color rgb="FFE6E2D8"/></right><top style="thin"><color rgb="FFE6E2D8"/></top><bottom style="thin"><color rgb="FFE6E2D8"/></bottom><diagonal/></border>
    <border><left/><right/><top style="thin"><color rgb="FFB54E2D"/></top><bottom style="double"><color rgb="FFB54E2D"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="8">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="1" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="1" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
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

// ---- Central-Directory-Aware ZIP Reader + Exact .xlsx Sheet/Cell Parser
function readZipEntries(buf) {
  const entries = new Map();
  // Locate End of Central Directory (PK\x05\x06) scanning backwards
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd >= 0) {
    const cdCount = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    for (let k = 0; k < cdCount && pos + 46 <= buf.length; k++) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break;
      const method = buf.readUInt16LE(pos + 10);
      const compSize = buf.readUInt32LE(pos + 20);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const lfhOffset = buf.readUInt32LE(pos + 42);
      const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
      pos += 46 + nameLen + extraLen + commentLen;

      if (lfhOffset + 30 <= buf.length && buf.readUInt32LE(lfhOffset) === 0x04034b50) {
        const lNameLen = buf.readUInt16LE(lfhOffset + 26);
        const lExtraLen = buf.readUInt16LE(lfhOffset + 28);
        const dataStart = lfhOffset + 30 + lNameLen + lExtraLen;
        if (dataStart + compSize <= buf.length) {
          try {
            const slice = buf.subarray(dataStart, dataStart + compSize);
            const raw = method === 8 ? zlib.inflateRawSync(slice) : method === 0 ? slice : null;
            if (raw) entries.set(name, raw);
          } catch {}
        }
      }
    }
  }
  return entries;
}

function xmlUnesc(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (const ch of String(letters || '').toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, idx - 1);
}

function parseXlsxBuffer(buf, { preserveFormulas = false } = {}) {
  const entries = readZipEntries(buf);
  const sharedStrings = [];
  const ssBuf = entries.get('xl/sharedStrings.xml');
  if (ssBuf) {
    const ssXml = ssBuf.toString('utf8');
    for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      const parts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)].map((x) => xmlUnesc(x[1]));
      sharedStrings.push(parts.join(''));
    }
  }

  // Extract sheet names from workbook.xml
  const sheetNames = [];
  const wbBuf = entries.get('xl/workbook.xml');
  if (wbBuf) {
    const wbXml = wbBuf.toString('utf8');
    for (const m of wbXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*>/gi)) {
      sheetNames.push(xmlUnesc(m[1]));
    }
  }

  const sheetFiles = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/sheet(\d+)/i)?.[1] || 0);
      const nb = Number(b.match(/sheet(\d+)/i)?.[1] || 0);
      return na - nb;
    });

  const sheets = [];
  sheetFiles.forEach((sf, sIdx) => {
    const xml = entries.get(sf).toString('utf8');
    const rowMap = new Map();
    let maxCol = 0;

    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
      const rAttr = rm[1] || '';
      const rBody = rm[2] || '';
      const rNumMatch = rAttr.match(/\br="(\d+)"/i);
      const rowIdx = rNumMatch ? Number(rNumMatch[1]) - 1 : rowMap.size;
      const cells = [];

      let autoCol = 0;
      for (const cm of rBody.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
        const cAttr = cm[1] || '';
        const cBody = cm[2] || '';
        const refM = cAttr.match(/\br="([A-Z]+)\d+"/i);
        const colIdx = refM ? colLettersToIndex(refM[1]) : autoCol;
        autoCol = colIdx + 1;
        if (colIdx > maxCol) maxCol = colIdx;

        const tM = cAttr.match(/\bt="([^"]+)"/i);
        const cellType = tM ? tM[1] : '';
        const fM = cBody.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/i);
        const formulaStr = fM ? `=${xmlUnesc(fM[1]).trim()}` : '';
        let val = '';
        if (preserveFormulas && formulaStr) {
          val = formulaStr;
        } else if (cellType === 'inlineStr') {
          val = [...cBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)].map((x) => xmlUnesc(x[1])).join('');
        } else {
          const vM = cBody.match(/<v[^>]*>([\s\S]*?)<\/v>/i);
          const rawV = vM ? xmlUnesc(vM[1]) : '';
          if (cellType === 's') {
            val = sharedStrings[Number(rawV)] ?? rawV;
          } else if (cellType === 'b') {
            val = rawV === '1' ? 'TRUE' : 'FALSE';
          } else {
            val = rawV;
          }
          if (!val && formulaStr) val = formulaStr;
        }
        cells[colIdx] = val;
      }
      rowMap.set(rowIdx, cells);
    }

    const sortedRowNums = [...rowMap.keys()].sort((a, b) => a - b);
    const colCount = maxCol + 1;
    const rows = [];
    for (const rn of sortedRowNums) {
      const arr = rowMap.get(rn) || [];
      const dense = [];
      for (let c = 0; c < colCount; c++) dense.push(arr[c] ?? '');
      if (dense.some((v) => v !== '')) rows.push(dense);
    }

    sheets.push({
      name: sheetNames[sIdx] || `Sheet${sIdx + 1}`,
      rows: rows.length ? rows : [['']],
    });
  });

  return { sheets: sheets.length ? sheets : [{ name: 'Sheet1', rows: [['']] }] };
}

function serializeCsv(rows, delimiter = ',') {
  const d = delimiter || ',';
  return (rows || []).map((row) =>
    (row || []).map((cell) => {
      const s = String(cell ?? '');
      if (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(d)
  ).join('\n') + '\n';
}

function parseCellRef(ref) {
  const m = String(ref || '').trim().match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  return { row: Math.max(0, Number(m[2]) - 1), col: colLettersToIndex(m[1]) };
}

function resolveColIndex(col, headers = []) {
  if (typeof col === 'number' && Number.isFinite(col)) return Math.max(0, Math.floor(col));
  const s = String(col ?? '').trim();
  if (/^\d+$/.test(s)) return Math.max(0, Number(s));
  if (/^[A-Z]{1,3}$/i.test(s)) {
    const byHeader = headers.findIndex((h) => String(h || '').trim().toLowerCase() === s.toLowerCase());
    if (byHeader >= 0) return byHeader;
    return colLettersToIndex(s);
  }
  const byHeader = headers.findIndex((h) => String(h || '').trim().toLowerCase() === s.toLowerCase());
  return byHeader >= 0 ? byHeader : 0;
}

function applyTableOperations(rowsInput, operations = []) {
  const rows = (rowsInput || []).map((r) => [...r]);
  const applied = [];

  const ensureSize = (rIdx, cIdx) => {
    const colCount = Math.max(cIdx + 1, rows[0]?.length || 1);
    while (rows.length <= rIdx) rows.push(new Array(colCount).fill(''));
    for (const r of rows) {
      while (r.length < colCount) r.push('');
    }
  };

  for (const op of operations || []) {
    if (!op || !op.op) continue;
    const kind = String(op.op).toLowerCase();
    if (kind === 'set_cell' || kind === 'update_cell' || kind === 'set_formula') {
      const refParsed = op.cell ? parseCellRef(op.cell) : null;
      const rIdx = refParsed ? refParsed.row : Math.max(0, Number(op.row) || 0);
      const cIdx = refParsed ? refParsed.col : resolveColIndex(op.col, rows[0] || []);
      ensureSize(rIdx, cIdx);
      const prev = rows[rIdx][cIdx];
      let val = String(op.formula ?? op.value ?? '');
      if (kind === 'set_formula' && val && !val.startsWith('=')) val = '=' + val;
      rows[rIdx][cIdx] = val;
      applied.push({ op: 'set_cell', row: rIdx, col: cIdx, prev, value: rows[rIdx][cIdx], note: op.note || '' });
    } else if (kind === 'set_range') {
      const refParsed = op.cell ? parseCellRef(op.cell) : null;
      const startRow = refParsed ? refParsed.row : Math.max(0, Number(op.startRow ?? op.row) || 0);
      const startCol = refParsed ? refParsed.col : resolveColIndex(op.startCol ?? op.col ?? 0, rows[0] || []);
      const grid = Array.isArray(op.values) ? op.values : [];
      let count = 0;
      for (let dr = 0; dr < grid.length; dr++) {
        const rowVals = Array.isArray(grid[dr]) ? grid[dr] : [grid[dr]];
        for (let dc = 0; dc < rowVals.length; dc++) {
          ensureSize(startRow + dr, startCol + dc);
          rows[startRow + dr][startCol + dc] = String(rowVals[dc] ?? '');
          count++;
        }
      }
      applied.push({ op: 'set_range', row: startRow, col: startCol, count, note: op.note || '' });
    } else if (kind === 'add_column') {
      const colIdx = rows[0]?.length || 0;
      const header = String(op.header || `Column ${colIdx + 1}`);
      const vals = Array.isArray(op.values) ? op.values : [];
      if (!rows.length) rows.push([]);
      rows[0][colIdx] = header;
      const totalRows = Math.max(rows.length, vals.length + 1);
      for (let r = 1; r < totalRows; r++) {
        if (!rows[r]) rows[r] = new Array(colIdx).fill('');
        rows[r][colIdx] = String(vals[r - 1] ?? '');
      }
      applied.push({ op: 'add_column', col: colIdx, header, count: vals.length, note: op.note || '' });
    } else if (kind === 'rename_column') {
      if (rows.length) {
        const cIdx = resolveColIndex(op.col, rows[0] || []);
        ensureSize(0, cIdx);
        rows[0][cIdx] = String(op.header ?? op.value ?? '');
        applied.push({ op: 'rename_column', col: cIdx, header: rows[0][cIdx], note: op.note || '' });
      }
    } else if (kind === 'delete_column') {
      if (rows.length) {
        const cIdx = resolveColIndex(op.col, rows[0] || []);
        if (cIdx >= 0 && cIdx < (rows[0]?.length || 0)) {
          for (const r of rows) {
            if (cIdx < r.length) r.splice(cIdx, 1);
          }
          applied.push({ op: 'delete_column', col: cIdx, note: op.note || '' });
        }
      }
    } else if (kind === 'add_row') {
      const vals = Array.isArray(op.values) ? op.values.map((v) => String(v ?? '')) : [];
      const rIdx = rows.length;
      const cols = Math.max(rows[0]?.length || 0, vals.length);
      const newRow = new Array(cols).fill('');
      vals.forEach((v, i) => { newRow[i] = v; });
      rows.push(newRow);
      applied.push({ op: 'add_row', row: rIdx, values: newRow, note: op.note || '' });
    } else if (kind === 'insert_row') {
      const vals = Array.isArray(op.values) ? op.values.map((v) => String(v ?? '')) : [];
      const rIdx = Math.max(0, Math.min(rows.length, Number(op.row) || rows.length));
      const cols = Math.max(rows[0]?.length || 0, vals.length);
      const newRow = new Array(cols).fill('');
      vals.forEach((v, i) => { newRow[i] = v; });
      rows.splice(rIdx, 0, newRow);
      applied.push({ op: 'insert_row', row: rIdx, values: newRow, note: op.note || '' });
    } else if (kind === 'delete_row') {
      const rIdx = Number(op.row);
      if (rIdx >= 1 && rIdx < rows.length) {
        rows.splice(rIdx, 1);
        applied.push({ op: 'delete_row', row: rIdx, note: op.note || '' });
      }
    } else if (kind === 'sort_rows') {
      if (rows.length > 2) {
        const cIdx = resolveColIndex(op.col, rows[0] || []);
        const desc = String(op.direction || 'asc').toLowerCase() === 'desc';
        const header = rows[0];
        const body = rows.slice(1);
        const parseNum = (v) => {
          const clean = String(v ?? '').replace(/[€$£,\s%]/g, '');
          return clean !== '' && /^-?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
        };
        body.sort((a, b) => {
          const av = a[cIdx] ?? '';
          const bv = b[cIdx] ?? '';
          const an = parseNum(av);
          const bn = parseNum(bv);
          let cmp;
          if (!Number.isNaN(an) && !Number.isNaN(bn)) cmp = an - bn;
          else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
          return desc ? -cmp : cmp;
        });
        rows.splice(0, rows.length, header, ...body);
        applied.push({ op: 'sort_rows', col: cIdx, direction: desc ? 'desc' : 'asc', note: op.note || '' });
      }
    }
  }
  return { rows, applied };
}

function applyWorkbookOperations(sheetsInput, defaultSheetIndex = 0, operations = []) {
  const sheets = (Array.isArray(sheetsInput) && sheetsInput.length
    ? sheetsInput
    : [{ name: 'Sheet1', rows: [['']] }]
  ).map((s, i) => ({
    name: s.name || `Sheet${i + 1}`,
    rows: (s.rows || []).map((r) => [...r]),
  }));
  let activeIdx = Math.max(0, Math.min(sheets.length - 1, Number(defaultSheetIndex) || 0));
  const applied = [];

  for (const op of operations || []) {
    if (!op || !op.op) continue;
    const kind = String(op.op).toLowerCase();
    if (kind === 'add_sheet') {
      const name = String(op.name || `Sheet${sheets.length + 1}`).trim().slice(0, 31) || `Sheet${sheets.length + 1}`;
      const initRows = Array.isArray(op.rows) && op.rows.length
        ? op.rows.map((r) => (Array.isArray(r) ? r.map((v) => String(v ?? '')) : [String(r ?? '')]))
        : [['']];
      sheets.push({ name, rows: initRows });
      activeIdx = sheets.length - 1;
      applied.push({ op: 'add_sheet', sheetIndex: activeIdx, name, note: op.note || '' });
    } else if (kind === 'rename_sheet') {
      const idx = op.sheetIndex !== undefined
        ? Math.max(0, Math.min(sheets.length - 1, Number(op.sheetIndex) || 0))
        : activeIdx;
      const name = String(op.name || sheets[idx].name).trim().slice(0, 31);
      if (name) {
        sheets[idx].name = name;
        applied.push({ op: 'rename_sheet', sheetIndex: idx, name, note: op.note || '' });
      }
    } else {
      let targetIdx = activeIdx;
      if (op.sheetName) {
        const found = sheets.findIndex((s) => s.name.toLowerCase() === String(op.sheetName).toLowerCase());
        if (found >= 0) targetIdx = found;
      } else if (op.sheetIndex !== undefined) {
        targetIdx = Math.max(0, Math.min(sheets.length - 1, Number(op.sheetIndex) || 0));
      }
      const res = applyTableOperations(sheets[targetIdx].rows, [op]);
      sheets[targetIdx].rows = res.rows;
      applied.push(...res.applied);
    }
  }

  return {
    sheets,
    sheetIndex: activeIdx,
    rows: sheets[activeIdx].rows,
    applied,
  };
}

function evaluateSheetFormulas(rowsInput = [], allSheets = null) {
  const rows = (rowsInput || []).map((r) => [...r]);
  const sheetsMap = new Map();
  if (Array.isArray(allSheets)) {
    for (const sh of allSheets) {
      if (sh && sh.name) sheetsMap.set(String(sh.name).toLowerCase(), sh.rows || []);
    }
  }
  const cache = new Map();
  let evaluatedCount = 0;

  const parseNumeric = (val) => {
    const clean = String(val ?? '').replace(/[€$£,\s]/g, '');
    if (clean.endsWith('%')) {
      const n = Number(clean.slice(0, -1));
      return Number.isFinite(n) ? n / 100 : NaN;
    }
    return clean !== '' && /^-?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : NaN;
  };

  const getCellVal = (targetRows, rIdx, cIdx, visiting) => {
    const key = `${targetRows === rows ? 'self' : 'ext'}:${rIdx}:${cIdx}`;
    if (cache.has(key)) return cache.get(key);
    const raw = String(targetRows?.[rIdx]?.[cIdx] ?? '').trim();
    if (!raw.startsWith('=')) return raw;
    if (visiting.has(key)) return '#REF!';
    visiting.add(key);
    const val = evalFormula(raw.slice(1), targetRows, visiting);
    visiting.delete(key);
    cache.set(key, val);
    return val;
  };

  const expandRange = (rangeStr, defaultRows, visiting) => {
    let targetRows = defaultRows;
    let body = rangeStr.trim();
    const bang = body.indexOf('!');
    if (bang > 0) {
      const sName = body.slice(0, bang).replace(/^'|'$/g, '').toLowerCase();
      body = body.slice(bang + 1);
      targetRows = sheetsMap.get(sName) || defaultRows;
    }
    const [aStr, bStr] = body.split(':');
    const a = parseCellRef(aStr);
    const b = bStr ? parseCellRef(bStr) : a;
    if (!a || !b) return [];
    const vals = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
        vals.push(getCellVal(targetRows, r, c, visiting));
      }
    }
    return vals;
  };

  const evalArithmetic = (expr) => {
    const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
    if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return NaN;
    let pos = 0;
    const parseExpr = () => {
      let left = parseTerm();
      while (tokens[pos] === '+' || tokens[pos] === '-') {
        const op = tokens[pos++];
        const right = parseTerm();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };
    const parseTerm = () => {
      let left = parseFactor();
      while (tokens[pos] === '*' || tokens[pos] === '/') {
        const op = tokens[pos++];
        const right = parseFactor();
        left = op === '*' ? left * right : (right === 0 ? NaN : left / right);
      }
      return left;
    };
    const parseFactor = () => {
      if (tokens[pos] === '-') { pos++; return -parseFactor(); }
      if (tokens[pos] === '+') { pos++; return parseFactor(); }
      if (tokens[pos] === '(') {
        pos++;
        const v = parseExpr();
        if (tokens[pos] === ')') pos++;
        return v;
      }
      const n = Number(tokens[pos++]);
      return Number.isFinite(n) ? n : NaN;
    };
    const res = parseExpr();
    return pos === tokens.length && Number.isFinite(res) ? res : NaN;
  };

  const splitTopArgs = (s) => {
    const parts = [];
    let depth = 0;
    let inQ = false;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { inQ = !inQ; cur += ch; }
      else if (!inQ && ch === '(') { depth++; cur += ch; }
      else if (!inQ && ch === ')') { depth--; cur += ch; }
      else if (!inQ && depth === 0 && ch === ',') { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur.trim());
    return parts;
  };

  const evalFormula = (expr, curRows, visiting) => {
    let s = String(expr || '').trim();
    // Handle IF(cond, trueVal, falseVal)
    const ifM = s.match(/^IF\s*\(([\s\S]+)\)$/i);
    if (ifM) {
      const args = splitTopArgs(ifM[1]);
      if (args.length >= 2) {
        const cmpM = args[0].match(/^([\s\S]+?)(>=|<=|<>|!=|=|>|<)([\s\S]+)$/);
        if (cmpM) {
          const lv = evalFormula(cmpM[1], curRows, visiting);
          const rv = evalFormula(cmpM[3], curRows, visiting);
          const ln = parseNumeric(lv);
          const rn = parseNumeric(rv);
          const bothNum = !Number.isNaN(ln) && !Number.isNaN(rn);
          const a = bothNum ? ln : String(lv).replace(/^"|"$/g, '');
          const b = bothNum ? rn : String(rv).replace(/^"|"$/g, '');
          const op = cmpM[2];
          const ok = op === '>=' ? a >= b : op === '<=' ? a <= b : (op === '<>' || op === '!=') ? a !== b : op === '=' ? a === b : op === '>' ? a > b : a < b;
          const chosen = ok ? args[1] : (args[2] ?? '""');
          return /^"[\s\S]*"$/.test(chosen) ? chosen.slice(1, -1) : evalFormula(chosen, curRows, visiting);
        }
      }
    }

    // Handle ROUND(expr, digits)
    const roundM = s.match(/^ROUND\s*\(([\s\S]+)\)$/i);
    if (roundM) {
      const args = splitTopArgs(roundM[1]);
      if (args.length >= 1) {
        const num = parseNumeric(evalFormula(args[0], curRows, visiting));
        const digits = Math.max(0, Math.min(8, Number(args[1] || 0) || 0));
        if (Number.isFinite(num)) return Number(num.toFixed(digits)).toString();
      }
    }

    // Replace aggregate functions SUM/AVERAGE/AVG/MIN/MAX/COUNT
    s = s.replace(/\b(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\s*\(([^()]+)\)/gi, (_, fn, argStr) => {
      const items = splitTopArgs(argStr).flatMap((part) => {
        if (part.includes(':') || /!/.test(part) || /^[A-Z]+\d+$/i.test(part)) {
          return expandRange(part, curRows, visiting);
        }
        return [evalFormula(part, curRows, visiting)];
      });
      const nums = items.map(parseNumeric).filter((n) => Number.isFinite(n));
      const f = fn.toUpperCase();
      if (f === 'COUNT') return String(nums.length);
      if (!nums.length) return '0';
      if (f === 'SUM') return String(nums.reduce((a, b) => a + b, 0));
      if (f === 'AVERAGE' || f === 'AVG') return String(nums.reduce((a, b) => a + b, 0) / nums.length);
      if (f === 'MIN') return String(Math.min(...nums));
      if (f === 'MAX') return String(Math.max(...nums));
      return '0';
    });

    // Replace standalone cell references (including Sheet1!B2)
    s = s.replace(/(?:'[^']+'!|[A-Za-z0-9_]+!)?[A-Z]{1,3}\d+/g, (tok) => {
      const vals = expandRange(tok, curRows, visiting);
      const raw = vals[0] ?? '0';
      const n = parseNumeric(raw);
      return Number.isFinite(n) ? String(n) : raw;
    });

    if (/^"[\s\S]*"$/.test(s)) return s.slice(1, -1);
    const num = evalArithmetic(s);
    if (Number.isFinite(num)) {
      return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(4)));
    }
    return `=${expr}`;
  };

  const displayRows = rows.map((r, rIdx) =>
    r.map((cell, cIdx) => {
      const s = String(cell ?? '');
      if (!s.startsWith('=')) return s;
      const val = getCellVal(rows, rIdx, cIdx, new Set());
      if (val !== s) evaluatedCount++;
      return val;
    })
  );

  return { displayRows, evaluatedCount };
}

function fillDocxTemplate(templateBuf, replacements = {}) {
  const entries = readZipEntries(templateBuf);
  const map = replacements && typeof replacements === 'object' ? replacements : {};
  const keys = Object.keys(map);
  let replacedCount = 0;

  const replaceInXml = (xml) => {
    // First collapse split runs inside {{...}} placeholders (Word frequently splits {{key}} across adjacent <w:t> tags)
    let out = xml.replace(/\{\{((?:[^}<]|<[^>]+>){1,120})\}\}/g, (full, inner) => {
      const cleanKey = inner.replace(/<[^>]+>/g, '').trim();
      if (Object.prototype.hasOwnProperty.call(map, cleanKey)) {
        replacedCount++;
        return xmlEsc(String(map[cleanKey] ?? ''));
      }
      return full;
    });
    for (const k of keys) {
      const token = `{{${k}}}`;
      if (out.includes(token)) {
        const parts = out.split(token);
        replacedCount += parts.length - 1;
        out = parts.join(xmlEsc(String(map[k] ?? '')));
      }
    }
    return out;
  };

  const outEntries = [];
  for (const [name, data] of entries.entries()) {
    if (/^word\/(document|header\d*|footer\d*)\.xml$/i.test(name)) {
      outEntries.push({ name, data: Buffer.from(replaceInXml(data.toString('utf8')), 'utf8') });
    } else {
      outEntries.push({ name, data });
    }
  }
  return { buffer: createZipBuffer(outEntries), replacedCount };
}

function buildPptxBuffer({ title = 'mx-Cowork Presentation', subtitle = '', slides = null, markdown = '' } = {}) {
  let slideList = Array.isArray(slides) && slides.length ? slides : null;
  if (!slideList) {
    slideList = [];
    const lines = cleanMarkdownForExport(markdown).split(/\r?\n/);
    let cur = null;
    for (const line of lines) {
      const hm = line.match(/^#{1,2}\s+(.+)$/);
      if (hm) {
        if (cur) slideList.push(cur);
        cur = { title: hm[1].trim(), bullets: [] };
      } else if (line.trim()) {
        if (!cur) cur = { title: title || 'Overview', bullets: [] };
        const bm = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.+)$/);
        cur.bullets.push((bm ? bm[1] : line.trim()).replace(/\*\*/g, ''));
      }
    }
    if (cur) slideList.push(cur);
    if (!slideList.length) {
      slideList.push({ title: title || 'Presentation', bullets: [subtitle || 'Generated by mx-Cowork'] });
    }
  }

  // Ensure a clean title slide if the first slide has no bullets or subtitle is provided
  const finalSlides = subtitle && slideList[0]?.title !== title
    ? [{ title, bullets: [subtitle], isTitleSlide: true }, ...slideList]
    : slideList;

  const entries = [];
  const slideRelsXmlParts = [];
  const slideIdListParts = [];
  const contentTypeOverrides = [];

  finalSlides.slice(0, 40).forEach((sl, idx) => {
    const n = idx + 1;
    const sTitle = String(sl.title || `Slide ${n}`).slice(0, 120);
    const bullets = (Array.isArray(sl.bullets) ? sl.bullets : []).slice(0, 12);
    const bodyParas = bullets.length
      ? bullets.map((b) => `<a:p><a:pPr marL="285750" indent="-171450"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="262624"/></a:solidFill></a:rPr><a:t>${xmlEsc(String(b))}</a:t></a:r></a:p>`).join('')
      : '<a:p><a:endParaRPr lang="en-US" sz="1800"/></a:p>';

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${idx === 0 ? 'FAF8F5' : 'FFFFFF'}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="10820400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${idx === 0 ? '3600' : '2800'}" b="1" dirty="0"><a:solidFill><a:srgbClr val="B54E2D"/></a:solidFill></a:rPr><a:t>${xmlEsc(sTitle)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="1524000"/><a:ext cx="10820400" cy="4800600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${bodyParas}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    entries.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml });
    entries.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    });
    slideRelsXmlParts.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
    slideIdListParts.push(`<p:sldId id="${255 + n}" r:id="rId${n}"/>`);
    contentTypeOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  });

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${slideIdListParts.join('')}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;

  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRelsXmlParts.join('\n  ')}
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${contentTypeOverrides.join('\n  ')}
</Types>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'ppt/presentation.xml', data: presentationXml },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    ...entries,
  ]);
}

function summarizeTable(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const headers = rows[0] || [];
  const dataRows = rows.slice(1);
  if (!dataRows.length) return `Columns (${headers.length}): ${headers.join(', ')}`;
  const colSummaries = headers.slice(0, 20).map((h, cIdx) => {
    const nums = [];
    let nonEmpty = 0;
    let formulaCount = 0;
    for (const r of dataRows) {
      const raw = String(r[cIdx] ?? '').trim();
      if (!raw) continue;
      nonEmpty++;
      if (raw.startsWith('=')) { formulaCount++; continue; }
      const clean = raw.replace(/[€$£,\s%]/g, '');
      if (clean && /^-?\d+(?:\.\d+)?$/.test(clean)) nums.push(Number(clean));
    }
    const label = `${colLetter(cIdx)} ("${String(h || `Col${cIdx + 1}`).slice(0, 24)}")`;
    if (nums.length >= Math.max(2, Math.floor(nonEmpty * 0.6))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      const avg = sum / nums.length;
      const fmt = (n) => Number.isInteger(n) ? n.toString() : n.toFixed(2);
      return `${label}: numeric n=${nums.length}, sum=${fmt(sum)}, avg=${fmt(avg)}, min=${fmt(min)}, max=${fmt(max)}${formulaCount ? `, formulas=${formulaCount}` : ''}`;
    }
    return `${label}: text/mixed nonEmpty=${nonEmpty}${formulaCount ? `, formulas=${formulaCount}` : ''}`;
  });
  return `Table Summary (${dataRows.length} data rows × ${headers.length} cols):\n  - ` + colSummaries.join('\n  - ');
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
  fillDocxTemplate,
  buildPptxBuffer,
  buildXlsxBuffer,
  extractTablesFromMarkdown,
  parseCsvText,
  serializeCsv,
  parseXlsxBuffer,
  applyTableOperations,
  applyWorkbookOperations,
  evaluateSheetFormulas,
  summarizeTable,
  colLetter,
  buildIcsText,
  buildPrintableHtml,
};
