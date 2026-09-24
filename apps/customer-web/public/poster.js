/**
 * The QR poster a shop prints and sticks on its counter.
 *
 * Downloading used to hand over the bare QR square, leaving the shop owner to
 * build a poster themselves — so most would print a naked code with no
 * explanation, and a customer who has never seen one would have no idea what it
 * is for or that it costs money.
 *
 * Built as SVG rather than drawn straight onto a canvas for two reasons: it is
 * vector, so it stays crisp whether printed at A5 or A3, and it is a string,
 * which means it can be rendered and looked at outside a browser. The download
 * still hands over a PNG, because that is what prints from a shop PC without an
 * argument.
 *
 * Bilingual on purpose. "QR से Print" is what a customer in a Mumbai
 * stationery shop reads first; the English line underneath is for everyone else
 * and is also the fallback if the machine printing it has no Devanagari font.
 */
(function (global) {
  'use strict';

  // A4 at 150dpi. Big enough to print sharply, small enough to email.
  const W = 1240;
  const H = 1754;

  const BRAND = '#0e5e6f';
  const INK = '#0d0d0d';
  const PAPER = '#faf9f5';

  // Windows ships Nirmala UI, most Linux has Noto, older Windows has Mangal.
  // Without a Devanagari face the Hindi line renders as boxes, which is why
  // every Hindi string here has an English one directly beneath it.
  const DEVANAGARI = "'Nirmala UI','Noto Sans Devanagari','Mangal','Segoe UI',sans-serif";
  const LATIN = "'Space Grotesk','Segoe UI',Arial,sans-serif";

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** One of the three ways a customer can scan, drawn as a small labelled tile. */
  // Lucide (ISC), inlined: a poster rendered to PNG cannot load /icons.svg.
  const ICONS = {
    'camera': '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /> <circle cx="12" cy="13" r="3" />',
    'search': '<circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />',
    'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2" /> <path d="M12 18h.01" />',
  };

  function scanRoute(x, y, glyph, hindi, english) {
    return `
      <g transform="translate(${x} ${y})">
        <rect x="-70" y="0" width="140" height="140" rx="18" fill="#ffffff" stroke="${INK}" stroke-width="3"/>
        <g transform="translate(-30 40) scale(2.5)" fill="none" stroke="${INK}" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">${ICONS[glyph]}</g>
        <text x="0" y="176" font-family="${DEVANAGARI}" font-size="26" fill="${INK}" text-anchor="middle">${esc(hindi)}</text>
        <text x="0" y="208" font-family="${LATIN}" font-size="22" fill="#55554e" text-anchor="middle">${esc(english)}</text>
      </g>`;
  }

  /**
   * @param {{shopName: string, url: string, qrDataUrl: string}} shop
   * @returns {string} SVG markup, self-contained apart from system fonts.
   */
  function buildPosterSvg(shop) {
    const name = esc(shop.shopName || 'This shop');
    const url = esc(shop.url || '');

    // A long shop name has to shrink rather than run off the page.
    const nameSize = name.length > 26 ? 40 : name.length > 18 ? 50 : 62;

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>

  <!-- Brand band -->
  <rect x="0" y="0" width="${W}" height="150" fill="${BRAND}"/>
  <g transform="translate(58 27) scale(3)">
    <path d="M9.5 5.5h9.2l5.8 5.8v14.7a1.5 1.5 0 0 1-1.5 1.5H9.5A1.5 1.5 0 0 1 8 26V7a1.5 1.5 0 0 1 1.5-1.5z" fill="#fbfaf7"/>
    <path d="M18.7 5.5v4.3a1.5 1.5 0 0 0 1.5 1.5h4.3z" fill="#9cc7cf"/>
    <path d="M11.6 18.4l3.3 3.3 6.4-7.1" fill="none" stroke="#d99a1e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="150" y="98" font-family="${LATIN}" font-size="56" font-weight="700" fill="#ffffff">PrintOk</text>

  <!-- The instruction, in the language it will be read in -->
  <text x="${W / 2}" y="290" font-family="${DEVANAGARI}" font-size="96" font-weight="700"
        fill="${INK}" text-anchor="middle">QR से Print करें</text>
  <text x="${W / 2}" y="360" font-family="${LATIN}" font-size="44" fill="#55554e" text-anchor="middle">
    Scan this code to print from your phone
  </text>

  <!-- How to scan it -->
  ${scanRoute(W / 2 - 260, 430, 'camera', 'कैमरा', 'Camera')}
  ${scanRoute(W / 2, 430, 'search', 'गूगल लेंस', 'Google Lens')}
  ${scanRoute(W / 2 + 260, 430, 'smartphone', 'कोई QR ऐप', 'Any QR app')}

  <!-- The code itself, on white so a phone reads it off coloured paper too -->
  <rect x="${W / 2 - 320}" y="700" width="640" height="640" rx="28"
        fill="#ffffff" stroke="${INK}" stroke-width="6"/>
  ${shop.qrDataUrl
      ? `<image x="${W / 2 - 280}" y="740" width="560" height="560"
              xlink:href="${esc(shop.qrDataUrl)}" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${W / 2}" y="1030" font-family="${LATIN}" font-size="32" fill="#8a8a82"
              text-anchor="middle">QR code</text>`}

  <!-- Which shop this belongs to -->
  <text x="${W / 2}" y="1440" font-family="${LATIN}" font-size="${nameSize}" font-weight="700"
        fill="${INK}" text-anchor="middle">${name}</text>

  <!-- The four steps, so nobody has to guess what happens after scanning -->
  <g transform="translate(0 1520)">
    <text x="${W / 2}" y="0" font-family="${DEVANAGARI}" font-size="34" fill="${INK}" text-anchor="middle">
      स्कैन करें → फ़ाइल भेजें → पेमेंट करें → प्रिंट लें
    </text>
    <text x="${W / 2}" y="52" font-family="${LATIN}" font-size="30" fill="#55554e" text-anchor="middle">
      Scan → Upload → Pay → Collect
    </text>
  </g>

  <line x1="70" y1="1636" x2="${W - 70}" y2="1636" stroke="#d9d8d0" stroke-width="3"/>
  <text x="${W / 2}" y="1690" font-family="${LATIN}" font-size="26" fill="#8a8a82" text-anchor="middle">${url}</text>
</svg>`;
  }

  /**
   * Renders the poster to a PNG blob.
   *
   * A shop prints from a Windows PC, where a PNG opens and prints without any
   * argument about what an SVG is.
   */
  function posterToPngBlob(svg, scale = 1) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const src = URL.createObjectURL(blob);

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = W * scale;
          canvas.height = H * scale;

          const ctx = canvas.getContext('2d');
          // Paper, not transparency: a transparent PNG prints as whatever the
          // viewer decides, which on some printers is black.
          ctx.fillStyle = PAPER;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          canvas.toBlob((out) => {
            URL.revokeObjectURL(src);
            out ? resolve(out) : reject(new Error('The poster could not be rendered.'));
          }, 'image/png');
        } catch (err) {
          URL.revokeObjectURL(src);
          reject(err);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error('The poster could not be rendered.'));
      };

      img.src = src;
    });
  }

  global.PrintOkPoster = { buildPosterSvg, posterToPngBlob, WIDTH: W, HEIGHT: H };
})(window);
