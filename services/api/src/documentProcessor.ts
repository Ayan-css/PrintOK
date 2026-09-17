// pdf-parse v2 exports a class. v1 exported a callable, and this file called it
// as one — `await pdfParse(buffer)` threw TypeError on every single PDF, the
// catch below swallowed it, and every document in the system was counted as one
// page. A fifty-page thesis was billed as one page and printed as fifty, so the
// shop paid for the paper out of its own pocket on every large order.
const { PDFParse } = require('pdf-parse');

export interface ProcessedDocument {
  pageCount: number;
  /**
   * Whether the count was read out of the document or guessed.
   *
   * False for everything that is not a PDF or an image — a .docx page count
   * needs a layout engine, and the one page reported for one is an estimate. It
   * is surfaced rather than hidden so a guess is never quietly charged for as
   * though it were measured.
   */
  pageCountVerified?: boolean;
  format: 'pdf' | 'image' | 'word' | 'excel' | 'csv' | 'unknown';
  mimeType: string;
  isSupported: boolean;
  errorMessage?: string;
}

export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.jpg', '.jpeg', '.png', '.webp',
  '.docx', '.doc',
  '.xlsx', '.csv', '.pptx'
];

/**
 * Validates document format and calculates server-verified page count.
 */
export async function processDocument(
  fileName: string,
  fileBuffer: Buffer
): Promise<ProcessedDocument> {
  const ext = getExtension(fileName);

  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      pageCount: 0,
      format: 'unknown',
      mimeType: 'unknown',
      isSupported: false,
      errorMessage: `Unsupported file format '${ext}'. Allowed formats: PDF, Images (JPG, PNG, WEBP), Word (.docx), Excel (.xlsx), CSV.`,
    };
  }

  // 1. PDF Handling (Exact Parsing)
  if (ext === '.pdf') {
    const counted = await countPdfPages(fileBuffer);
    return {
      // Zero means nothing could read the file at all. One page is the only
      // safe guess, and the caller is told it is a guess.
      pageCount: counted > 0 ? counted : 1,
      pageCountVerified: counted > 0,
      format: 'pdf',
      mimeType: 'application/pdf',
      isSupported: true,
    };
  }

  // 2. Image Handling (1 page per image)
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };
    return {
      pageCount: 1,
      format: 'image',
      mimeType: mimeMap[ext] || 'image/jpeg',
      isSupported: true,
    };
  }

  // 3. Word Documents (.docx, .doc)
  if (['.docx', '.doc'].includes(ext)) {
    return {
      pageCount: 1, // Base page estimate
      format: 'word',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      isSupported: true,
    };
  }

  // 4. Excel & CSV
  if (['.xlsx', '.csv'].includes(ext)) {
    return {
      pageCount: 1,
      format: ext === '.csv' ? 'csv' : 'excel',
      mimeType: ext === '.csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      isSupported: true,
    };
  }

  // 5. PowerPoint
  if (ext === '.pptx') {
    return {
      pageCount: 1,
      format: 'unknown',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      isSupported: true,
    };
  }

  return {
    pageCount: 1,
    format: 'unknown',
    mimeType: 'application/octet-stream',
    isSupported: true,
  };
}

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx === -1) return '';
  return fileName.substring(idx).toLowerCase();
}

/**
 * How many pages a PDF actually has, or 0 if nothing could read it.
 *
 * This number is the price. Everything the customer is quoted and everything
 * the shop is paid comes off it, so a wrong answer here is a wrong answer on
 * every screen and in the ledger.
 *
 * Two readers, in order of trust:
 *
 *   1. **The parser.** `getInfo().total` is the document's own page tree.
 *   2. **Counting `/Type /Page` markers.** Crude, and deliberately kept: PDFs
 *      arrive from phone scanners and government portals with broken cross
 *      reference tables that a strict parser refuses outright, and a shop would
 *      rather print one of those for the right money than turn the customer
 *      away. `/Pages` is excluded so the page-tree node is not counted as a page.
 *
 * A failure is logged loudly either way. The original swallowed every error and
 * returned a confident "1 page", which is how a broken parser call went
 * unnoticed through every order this system has taken.
 */
async function countPdfPages(fileBuffer: Buffer): Promise<number> {
  let parser: any;
  try {
    parser = new PDFParse({ data: new Uint8Array(fileBuffer) });
    const info = await parser.getInfo();
    const total = Number(info?.total);
    if (Number.isInteger(total) && total > 0) return total;
    console.warn('[documentProcessor] The PDF parser reported no page total; falling back to counting markers.');
  } catch (err: any) {
    console.error(
      '[documentProcessor] Could not parse a PDF (%s). Falling back to counting page markers.',
      err?.message || err
    );
  } finally {
    try { await parser?.destroy(); } catch { /* the parser is being discarded anyway */ }
  }

  const markers = fileBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  if (markers && markers.length > 0) return markers.length;

  console.error('[documentProcessor] A PDF could not be counted at all; it will be billed as one page.');
  return 0;
}

/**
 * Generates a single-page PDF separator sheet containing Job Token & Metadata.
 * Uses zero external dependencies by constructing standard PDF 1.4 syntax.
 */
export function generateSeparatorPage(
  jobToken: string,
  shopName: string = 'PrintOk Counter',
  customerName: string = 'Customer',
  fileName: string = 'Document'
): Buffer {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const cleanToken = jobToken.replace(/[()]/g, '');
  const cleanShop = shopName.replace(/[()]/g, '');
  const cleanCustomer = customerName.replace(/[()]/g, '');
  const cleanFile = fileName.replace(/[()]/g, '');

  const streamContent = `BT
/F1 24 Tf
100 700 Td
(PRINTOK PRINT SEPARATOR) Tj
/F1 48 Tf
0 -60 Td
(${cleanToken}) Tj
/F1 16 Tf
0 -50 Td
(Shop: ${cleanShop}) Tj
0 -25 Td
(File: ${cleanFile}) Tj
0 -25 Td
(Customer: ${cleanCustomer}) Tj
0 -25 Td
(Date: ${dateStr}) Tj
ET`;

  const streamLength = Buffer.byteLength(streamContent);

  const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length ${streamLength} >>
stream
${streamContent}
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000313 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
580
%%EOF`;

  return Buffer.from(pdfString, 'utf-8');
}

