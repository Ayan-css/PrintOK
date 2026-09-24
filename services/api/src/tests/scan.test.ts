/**
 * The customer page's scanner (apps/customer-web/public/scan.js), checked
 * outside a browser: the perspective maths lands the corners where the crop
 * says, and a scanned document is a PDF this server accepts and bills by page.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { processDocument } from '../documentProcessor';

const source = fs.readFileSync(path.join(__dirname, '../../../../apps/customer-web/public/scan.js'), 'utf8');
const window: any = {};
vm.runInNewContext(source, { window, TextEncoder, File, Blob, document: {} });
const { homography, buildPdf } = window.PrintOkScan._internals;

// A 40×30 JPEG, so the PDF embeds a real image.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAeACgDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmpdsSAAAAAAAAAAAAAAAAAAAf//Z',
  'base64'
);
const fakeCanvas = (width: number, height: number) => ({ width, height, toBlob: (cb: (b: Blob) => void) => cb(new Blob([JPEG])) });

test('the perspective transform maps the page corners onto the crop', () => {
  const quad = [[112, 40], [980, 95], [1010, 1310], [60, 1250]];
  const H = homography(800, 1130, quad);
  const map = (x: number, y: number) => {
    const z = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
  };
  [[0, 0], [800, 0], [800, 1130], [0, 1130]].forEach(([x, y], i) => {
    const [u, v] = map(x, y);
    assert.ok(Math.abs(u - quad[i][0]) < 1e-6 && Math.abs(v - quad[i][1]) < 1e-6, `corner ${i} lands on the crop`);
  });
});

test('a two-page scan is a PDF the server accepts and counts as two pages', async () => {
  const file = await buildPdf([fakeCanvas(1240, 1754), fakeCanvas(1754, 1240)]);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.match(file.name, /\.pdf$/);

  const doc = await processDocument(file.name, bytes);
  assert.strictEqual(doc.isSupported, true, doc.errorMessage);
  assert.strictEqual(doc.format, 'pdf');
  assert.strictEqual(doc.pageCount, 2, 'billed as the pages scanned');
  assert.strictEqual(doc.pageCountVerified, true, 'counted from the document, not guessed');
});
