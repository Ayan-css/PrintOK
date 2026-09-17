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
 * What each accepted extension must actually start with.
 *
 * The allowlist checked the extension and nothing else, and for Office formats
 * the consequence is not theoretical: the agent cannot render those itself, so
 * it hands them to the OS-registered handler on the shop's counter PC via the
 * `printto` verb, unattended and with no operator review. Whatever the bytes
 * turn out to be, Word or Excel is asked to open them.
 *
 * So the bytes have to agree with the name before the file is accepted. `null`
 * means the format has no reliable signature to check — CSV is genuinely just
 * text — and those are checked for absence of a *different* format's signature
 * instead, so a PDF or an archive cannot arrive wearing a .csv suffix.
 *
 * Every Office format here is a ZIP container (PK\x03\x04); .doc and .xls are
 * the older OLE compound file (D0 CF 11 E0). Both are checked, since .doc is
 * accepted and may legitimately be either.
 */
const MAGIC_BYTES: Record<string, readonly Buffer[] | null> = {
  '.pdf': [Buffer.from('%PDF')],
  '.jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  '.png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  '.webp': [Buffer.from('RIFF')], // 'WEBP' sits at offset 8; checked separately
  '.docx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.xlsx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.pptx': [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  // Either the modern ZIP container or the legacy OLE compound file.
  '.doc': [Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  '.csv': null,
};

/** Signatures that must never appear in a file claiming a signature-less format. */
const FOREIGN_SIGNATURES: readonly Buffer[] = [
  Buffer.from('%PDF'),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from('MZ'),                      // Windows executable
];

/**
 * Whether the file's first bytes match what its name claims.
 *
 * Deliberately a shape check, not a parse: it stops a .docx that is really an
 * executable, which is what matters when the file is about to be opened by
 * whatever program the shop's PC has registered for that extension. It does not
 * and cannot establish that the content is safe.
 */
export function contentMatchesExtension(ext: string, fileBuffer: Buffer): boolean {
  if (fileBuffer.length === 0) return false;

  const expected = MAGIC_BYTES[ext];

  if (expected === null) {
    // No signature of its own, so the test is that it is not pretending to be
    // something else.
    return !FOREIGN_SIGNATURES.some((sig) => fileBuffer.subarray(0, sig.length).equals(sig));
  }

  if (!expected) return false;

  const matches = expected.some((sig) => fileBuffer.subarray(0, sig.length).equals(sig));
  if (!matches) return false;

  // RIFF alone is also AVI and WAV; the form type at offset 8 is what makes it
  // a WebP, and the agent's decoder is what would otherwise meet the surprise.
  if (ext === '.webp') {
    return fileBuffer.length >= 12 && fileBuffer.subarray(8, 12).toString('latin1') === 'WEBP';
  }

  return true;
}

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

  // The name says one thing; the bytes have to agree. Refused before the file
  // is stored, priced or handed to the shop's PC.
  if (!contentMatchesExtension(ext, fileBuffer)) {
    return {
      pageCount: 0,
      format: 'unknown',
      mimeType: 'unknown',
      isSupported: false,
      errorMessage:
        `This file does not look like a ${ext.replace('.', '').toUpperCase()} inside, whatever it is named. ` +
        'Re-export it and try again.',
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

