/**
 * Document scanning and ID card pages, for the customer print page.
 *
 * The camera runs inside the page. Handing off to the phone's camera app is
 * what got the tab killed on low-memory Android phones ("previous operation
 * failed due to low memory"): Chrome is backgrounded, the OS reclaims it, and
 * the customer returns to a reloaded page with nothing uploaded.
 *
 *   PrintOkScan.document(onFile)   scan one or more pages -> onFile(PDF File)
 *   PrintOkScan.single(onCanvas)   scan one flat image    -> onCanvas(canvas)
 *   PrintOkScan.shrinkImage(file)  a large photo, resized to print resolution
 *
 * Auto-detection is a heuristic (Otsu threshold, largest bright region, its
 * extreme corners): it finds a sheet on a darker surface, and the four
 * draggable corners cover every case it does not.
 * ponytail: heuristic edge detection, swap in OpenCV contours if it misses often.
 */
(function (global) {
  'use strict';

  const MAX_CAPTURE = 2560;   // longest side of a captured frame
  const MAX_OUTPUT = 2200;    // longest side of a flattened page (~190 dpi on A4)
  const A4 = [595.28, 841.89]; // points

  // ------------------------------------------------------------ geometry ---

  /** 3x3 homography taking the unit rectangle (w×h) onto quad [tl,tr,br,bl]. */
  function homography(w, h, q) {
    // Solve for H mapping (0,0),(w,0),(w,h),(0,h) -> q[0..3].
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = q[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const s = solve(A, b);
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
  }

  /** Gaussian elimination with partial pivoting, 8×8. */
  function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** Flattens the quad out of `src` (a canvas) into a new canvas. */
  function warp(src, quad) {
    const [tl, tr, br, bl] = quad;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    const scale = Math.min(1, MAX_OUTPUT / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    const H = homography(w, h, quad);
    const sw = src.width, sh = src.height;
    const sdata = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h);
    const d = img.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const z = H[6] * x + H[7] * y + H[8];
        const sx = (H[0] * x + H[1] * y + H[2]) / z;
        const sy = (H[3] * x + H[4] * y + H[5]) / z;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const o = (y * w + x) * 4;
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 255; continue; }
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          d[o + c] = (sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx) * (1 - fy)
                   + (sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx) * fy;
        }
        d[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  /** Four corners of the page in `canvas`, or null when nothing page-like is found. */
  function detect(canvas) {
    const S = 320 / Math.max(canvas.width, canvas.height);
    const w = Math.max(1, Math.round(canvas.width * S));
    const h = Math.max(1, Math.round(canvas.height * S));
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const sctx = small.getContext('2d');
    sctx.filter = 'blur(2px)';
    sctx.drawImage(canvas, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h).data;

    const grey = new Uint8Array(w * h);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < w * h; i++) {
      const g = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
      grey[i] = g; hist[g]++;
    }

    // Otsu: the threshold that best separates paper from the surface under it.
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = w * h - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }

    // Largest connected bright region.
    const seen = new Uint8Array(w * h);
    let bestArea = 0, bestPts = null;
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || grey[start] <= threshold) continue;
      const pts = [];
      stack.push(start); seen[start] = 1;
      while (stack.length) {
        const i = stack.pop(); pts.push(i);
        const x = i % w, y = (i / w) | 0;
        const n = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of n) if (j >= 0 && !seen[j] && grey[j] > threshold) { seen[j] = 1; stack.push(j); }
      }
      if (pts.length > bestArea) { bestArea = pts.length; bestPts = pts; }
    }
    if (!bestPts || bestArea < w * h * 0.12 || bestArea > w * h * 0.97) return null;

    // Its extreme corners: top-left minimises x+y, bottom-right maximises it, and so on.
    let tl, tr, br, bl, a = Infinity, b = -Infinity, c = -Infinity, e = Infinity;
    for (const i of bestPts) {
      const x = i % w, y = (i / w) | 0;
      if (x + y < a) { a = x + y; tl = [x, y]; }
      if (x + y > b) { b = x + y; br = [x, y]; }
      if (x - y > c) { c = x - y; tr = [x, y]; }
      if (x - y < e) { e = x - y; bl = [x, y]; }
    }
    return [tl, tr, br, bl].map(([x, y]) => [x / S, y / S]);
  }

  function inset(canvas, f = 0.06) {
    const w = canvas.width, h = canvas.height;
    return [[w * f, h * f], [w * (1 - f), h * f], [w * (1 - f), h * (1 - f)], [w * f, h * (1 - f)]];
  }

  // -------------------------------------------------------------- filters ---

  function applyFilter(canvas, mode) {
    if (mode === 'colour') return canvas;
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    const n = d.length / 4;
    const g = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) {
      g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
      hist[g[i]]++;
    }
    // Enhanced: stretch so the paper goes white and the ink goes black.
    let lo = 0, hi = 255;
    if (mode === 'enhanced') {
      let acc = 0;
      for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc > n * 0.05) { lo = t; break; } }
      acc = 0;
      for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc > n * 0.35) { hi = t; break; } }
      if (hi - lo < 20) { lo = 0; hi = 255; }
    }
    for (let i = 0; i < n; i++) {
      let v = g[i];
      if (mode === 'enhanced') v = Math.max(0, Math.min(255, ((v - lo) * 255) / (hi - lo)));
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  function rotate(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.height; out.height = canvas.width;
    const ctx = out.getContext('2d');
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  // ------------------------------------------------------------------ PDF ---

  /** One A4 page per image, each fitted with a margin. No library needed. */
  async function buildPdf(canvases) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => { const b = typeof part === 'string' ? enc.encode(part) : part; chunks.push(b); length += b.length; };
    const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const pages = [];
    let next = 3;
    const plan = canvases.map((c) => { const p = { c, page: next, content: next + 1, image: next + 2 }; next += 3; pages.push(p); return p; });

    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((p) => `${p.page} 0 R`).join(' ')}] >>`));

    for (const p of plan) {
      const landscape = p.c.width > p.c.height;
      const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
      const m = 18;
      const s = Math.min((pw - 2 * m) / p.c.width, (ph - 2 * m) / p.c.height);
      const iw = p.c.width * s, ih = p.c.height * s;
      const x = (pw - iw) / 2, y = (ph - ih) / 2;
      const jpeg = new Uint8Array(await (await new Promise((r) => p.c.toBlob(r, 'image/jpeg', 0.85))).arrayBuffer());
      const draw = `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;

      obj(p.page, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${p.image} 0 R >> >> /Contents ${p.content} 0 R >>`));
      obj(p.content, () => { push(`<< /Length ${draw.length} >>\nstream\n`); push(draw); push('\nendstream'); });
      obj(p.image, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${p.c.width} /Height ${p.c.height} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
        push(jpeg); push('\nendstream');
      });
    }

    const xref = length;
    push(`xref\n0 ${next}\n0000000000 65535 f \n`);
    for (let i = 1; i < next; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new File(chunks, `scan-${pages.length}-page${pages.length === 1 ? '' : 's'}.pdf`, { type: 'application/pdf' });
  }

  // --------------------------------------------------------------- images ---

  /** Decodes a photo at print resolution rather than full camera resolution. */
  async function decode(file) {
    try {
      return await decodeResized(file);
    } catch {
      // Browsers without createImageBitmap's resize options: an <img>, drawn
      // down to print resolution.
      const url = URL.createObjectURL(file);
      try {
        const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
        const s = Math.min(1, MAX_CAPTURE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function decodeResized(file) {
    // Asking the decoder for a smaller bitmap avoids ever holding the full
    // 12-50 megapixel image, which is the memory spike on low-end phones.
    const probe = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: 64, resizeQuality: 'low' });
    const ratio = probe.height / probe.width; probe.close();
    const longSide = MAX_CAPTURE;
    const opts = ratio > 1
      ? { resizeHeight: longSide, resizeWidth: Math.round(longSide / ratio) }
      : { resizeWidth: longSide, resizeHeight: Math.round(longSide * ratio) };
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeQuality: 'high', ...opts });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return c;
  }

  /** A large photo re-encoded at print resolution; small files pass through. */
  async function shrinkImage(file) {
    if (!/^image\//.test(file.type) || file.size < 2.5 * 1024 * 1024) return file;
    try {
      const c = await decode(file);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }

  // ------------------------------------------------------------------- UI ---

  const CSS = `
  .scan-overlay{position:fixed;inset:0;z-index:1000;background:#0b1d21;color:#fbfaf7;display:flex;flex-direction:column;
    padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px);font-family:inherit}
  .scan-top,.scan-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px}
  .scan-top h2{font-size:16px;margin:0}
  .scan-stage{flex:1;position:relative;display:grid;place-items:center;overflow:hidden;touch-action:none}
  .scan-stage video,.scan-stage canvas.scan-view{max-width:100%;max-height:100%;display:block}
  .scan-btn{background:rgba(255,255,255,.1);color:inherit;border:1px solid rgba(255,255,255,.25);border-radius:10px;
    padding:10px 14px;font:inherit;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .scan-btn.primary{background:#d99a1e;border-color:#d99a1e;color:#10262b;font-weight:700}
  .scan-shutter{width:68px;height:68px;border-radius:50%;border:4px solid #fbfaf7;background:#fbfaf7;box-shadow:inset 0 0 0 4px #0b1d21;cursor:pointer}
  .scan-handle{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #d99a1e;
    background:rgba(217,154,30,.25);touch-action:none;cursor:grab}
  .scan-svg{position:absolute;inset:0;pointer-events:none}
  .scan-loupe{position:absolute;width:110px;height:110px;border-radius:50%;border:3px solid #fbfaf7;overflow:hidden;pointer-events:none;
    box-shadow:0 6px 18px rgba(0,0,0,.5)}
  .scan-chips{display:flex;gap:6px;flex-wrap:wrap}
  .scan-chip{background:none;color:inherit;border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
  .scan-chip[aria-pressed="true"]{background:#fbfaf7;color:#10262b}
  .scan-thumbs{display:flex;gap:6px;overflow-x:auto;padding:0 14px}
  .scan-thumbs img{height:54px;border-radius:4px;border:1px solid rgba(255,255,255,.3)}
  .scan-note{font-size:13px;opacity:.8;padding:0 14px}
  `;

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) e.append(c);
    return e;
  }

  const icon = (n) => global.PrintOkIcon ? global.PrintOkIcon(n) : '';

  /**
   * The scanner. `multi` collects pages until Done; otherwise the first kept
   * scan is returned.
   */
  function open({ multi, title, onDone }) {
    if (!document.getElementById('scanCss')) document.head.append(el('style', { id: 'scanCss', text: CSS }));

    const overlay = el('div', { class: 'scan-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const stage = el('div', { class: 'scan-stage' });
    const top = el('div', { class: 'scan-top' });
    const bar = el('div', { class: 'scan-bar' });
    const thumbs = el('div', { class: 'scan-thumbs' });
    const note = el('p', { class: 'scan-note' });
    overlay.append(top, stage, thumbs, note, bar);
    document.body.append(overlay);
    document.documentElement.style.overflow = 'hidden';

    const pages = [];
    let stream = null;

    const picker = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    overlay.append(picker);
    picker.addEventListener('change', async () => {
      const f = picker.files[0]; picker.value = '';
      if (f) { note.textContent = 'Reading the photo…'; crop(await decode(f)); }
    });

    function close() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      document.documentElement.style.overflow = '';
    }

    function header(text, extra) {
      top.replaceChildren(el('h2', { text }), extra || '',
        el('button', { class: 'scan-btn', type: 'button', 'aria-label': 'Close scanner', onclick: close }));
      top.lastChild.innerHTML = `${icon('x')} Close`;
    }

    function renderThumbs() {
      thumbs.replaceChildren(...pages.map((c) => el('img', { src: c.toDataURL('image/jpeg', 0.4), alt: '' })));
    }

    async function finish() {
      close();
      onDone(multi ? await buildPdf(pages) : pages[0]);
    }

    // ---- Camera ----
    async function camera() {
      header(multi ? `Scan pages${pages.length ? ` (${pages.length})` : ''}` : title);
      renderThumbs();
      note.textContent = 'Place the page on a darker surface, fill the frame, and hold steady.';
      stage.replaceChildren();

      const importBtn = el('button', { class: 'scan-btn', type: 'button', onclick: () => picker.click() });
      importBtn.innerHTML = `${icon('image')} Photo`;
      const doneBtn = el('button', { class: 'scan-btn primary', type: 'button', onclick: finish });
      doneBtn.innerHTML = `${icon('check')} Done`;
      doneBtn.hidden = !(multi && pages.length);
      const shutter = el('button', { class: 'scan-shutter', type: 'button', 'aria-label': 'Take picture' });
      bar.replaceChildren(importBtn, shutter, doneBtn.hidden ? el('span', { style: 'width:88px' }) : doneBtn);

      try {
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
          });
        }
        const video = el('video', { playsinline: '', muted: '', autoplay: '' });
        video.srcObject = stream;
        stage.append(video);
        await video.play();
        shutter.onclick = () => {
          const s = Math.min(1, MAX_CAPTURE / Math.max(video.videoWidth, video.videoHeight));
          const c = el('canvas');
          c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
          c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
          crop(c);
        };
      } catch {
        // No camera, or permission refused: a photo from the gallery or the
        // phone's camera app works the same from here on.
        shutter.hidden = true;
        note.textContent = 'The camera is not available here. Choose a photo of the page instead.';
        stage.append(el('button', { class: 'scan-btn primary', type: 'button', text: 'Choose a photo', onclick: () => picker.click() }));
      }
    }

    // ---- Perspective crop ----
    function crop(source) {
      header('Adjust the corners');
      thumbs.replaceChildren();
      note.textContent = 'Drag each corner onto the corner of the page.';
      stage.replaceChildren();

      const view = el('canvas', { class: 'scan-view' });
      const vw = stage.clientWidth - 24, vh = stage.clientHeight - 24;
      const scale = Math.min(vw / source.width, vh / source.height, 1);
      view.width = Math.round(source.width * scale);
      view.height = Math.round(source.height * scale);
      view.getContext('2d').drawImage(source, 0, 0, view.width, view.height);

      const wrap = el('div', { style: `position:relative;width:${view.width}px;height:${view.height}px` });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'scan-svg');
      svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('fill', 'rgba(217,154,30,0.15)');
      poly.setAttribute('stroke', '#d99a1e');
      poly.setAttribute('stroke-width', '2');
      svg.append(poly);
      const loupe = el('canvas', { class: 'scan-loupe', width: 110, height: 110, hidden: '' });
      wrap.append(view, svg, loupe);
      stage.append(wrap);

      const found = detect(source);
      let quad = (found || inset(source)).map(([x, y]) => [x * scale, y * scale]);
      if (!found) note.textContent = 'Could not find the page edges. Drag each corner onto the corner of the page.';

      const handles = quad.map((_, i) => {
        const hnd = el('div', { class: 'scan-handle', role: 'slider', 'aria-label': ['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' corner', tabindex: '0' });
        wrap.append(hnd);
        hnd.addEventListener('pointerdown', (e) => {
          hnd.setPointerCapture(e.pointerId);
          const move = (ev) => {
            const r = wrap.getBoundingClientRect();
            quad[i] = [Math.max(0, Math.min(view.width, ev.clientX - r.left)), Math.max(0, Math.min(view.height, ev.clientY - r.top))];
            draw(i);
          };
          const up = () => { hnd.removeEventListener('pointermove', move); hnd.removeEventListener('pointerup', up); loupe.hidden = true; };
          hnd.addEventListener('pointermove', move);
          hnd.addEventListener('pointerup', up);
        });
        hnd.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 10 : 2;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
          if (!d) return;
          e.preventDefault();
          quad[i] = [quad[i][0] + d[0], quad[i][1] + d[1]];
          draw();
        });
        return hnd;
      });

      function draw(active) {
        quad.forEach(([x, y], i) => { handles[i].style.left = `${x}px`; handles[i].style.top = `${y}px`; });
        poly.setAttribute('points', quad.map((p) => p.join(',')).join(' '));
        if (active === undefined) return;
        // The loupe: the finger covers the corner it is placing.
        const [x, y] = quad[active];
        loupe.hidden = false;
        loupe.style.left = `${Math.min(view.width - 110, Math.max(0, x - 55))}px`;
        loupe.style.top = `${y > 150 ? y - 150 : y + 40}px`;
        const lctx = loupe.getContext('2d');
        const sx = x / scale, sy = y / scale;
        lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 110, 110);
        lctx.drawImage(source, sx - 27, sy - 27, 55, 55, 0, 0, 110, 110);
        lctx.strokeStyle = '#d99a1e'; lctx.lineWidth = 2;
        lctx.beginPath(); lctx.moveTo(55, 40); lctx.lineTo(55, 70); lctx.moveTo(40, 55); lctx.lineTo(70, 55); lctx.stroke();
      }
      draw();

      const retake = el('button', { class: 'scan-btn', type: 'button', onclick: camera });
      retake.innerHTML = `${icon('refresh-cw')} Retake`;
      const full = el('button', { class: 'scan-btn', type: 'button', text: 'Whole photo', onclick: () => {
        quad = [[0, 0], [view.width, 0], [view.width, view.height], [0, view.height]]; draw();
      } });
      const keep = el('button', { class: 'scan-btn primary', type: 'button', text: 'Next', onclick: () => {
        note.textContent = 'Straightening…';
        setTimeout(() => finishPage(warp(source, quad.map(([x, y]) => [x / scale, y / scale]))), 20);
      } });
      bar.replaceChildren(retake, full, keep);
    }

    // ---- Filter and keep ----
    function finishPage(flat) {
      header('Check the scan');
      note.textContent = '';
      let base = flat, mode = 'enhanced';
      const view = el('canvas', { class: 'scan-view' });
      const show = () => {
        const out = applyFilter(base, mode);
        const s = Math.min((stage.clientWidth - 24) / out.width, (stage.clientHeight - 24) / out.height, 1);
        view.width = Math.round(out.width * s); view.height = Math.round(out.height * s);
        view.getContext('2d').drawImage(out, 0, 0, view.width, view.height);
      };
      stage.replaceChildren(view);

      const chips = el('div', { class: 'scan-chips', role: 'group', 'aria-label': 'Colour' });
      for (const [m, label] of [['enhanced', 'Enhanced'], ['grey', 'Greyscale'], ['colour', 'Colour']]) {
        const b = el('button', { class: 'scan-chip', type: 'button', text: label, 'aria-pressed': String(m === mode), onclick: () => {
          mode = m; chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); show();
        } });
        chips.append(b);
      }
      const turn = el('button', { class: 'scan-btn', type: 'button', 'aria-label': 'Rotate', onclick: () => { base = rotate(base); show(); } });
      turn.innerHTML = `${icon('refresh-cw')} Rotate`;
      top.insertBefore(chips, top.lastChild);
      show();

      const again = el('button', { class: 'scan-btn', type: 'button', text: 'Back', onclick: camera });
      const keep = el('button', { class: 'scan-btn primary', type: 'button', text: multi ? 'Keep page' : 'Use this', onclick: () => {
        pages.push(applyFilter(base, mode));
        if (multi) camera(); else finish();
      } });
      bar.replaceChildren(again, turn, keep);
    }

    camera();
  }

  // --------------------------------------------------------------- ID card ---

  // Aadhaar, PAN, driving licence and voter ID are all ISO ID-1: 85.6 × 54 mm.
  const CARD = [86, 54];
  const SIZES = [['card', 'Card size', 1], ['bigger', 'Bigger', 1.25], ['large', 'Large', 1.5], ['custom', 'Custom', null]];
  const TOP = 15, GAP = 10, PAGE = [210, 297];
  const fits = (w, h) => w >= 30 && h >= 19 && w <= 180 && TOP + 2 * h + GAP <= PAGE[1] - 15;

  /** Draws `img` to fill the w×h box at x,y, turned to match its shape, edges trimmed. */
  function cover(ctx, img, x, y, w, h) {
    const turn = (img.width > img.height) !== (w > h);
    const iw = turn ? img.height : img.width, ih = turn ? img.width : img.height;
    const s = Math.max(w / iw, h / ih);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.translate(x + w / 2, y + h / 2);
    if (turn) ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, (-img.width * s) / 2, (-img.height * s) / 2, img.width * s, img.height * s);
    ctx.restore();
  }

  /** Both sides on one A4 page image, each at w×h mm, at 200 dpi. */
  function idPage(front, back, w, h) {
    const px = (mm) => Math.round((mm / 25.4) * 200);
    const c = document.createElement('canvas');
    c.width = px(PAGE[0]); c.height = px(PAGE[1]);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const x = (c.width - px(w)) / 2;
    [[front, px(TOP)], [back, px(TOP + h + GAP)]].forEach(([img, y]) => {
      cover(ctx, img, x, y, px(w), px(h));
      ctx.strokeStyle = '#999'; ctx.lineWidth = 2; ctx.strokeRect(x, y, px(w), px(h)); // cut line
    });
    return c;
  }

  /**
   * The ID card panel: scan each side, pick a size by name or drag it on a
   * picture of the page, then hand back one A4 image.
   */
  function idTool(root, onFile) {
    const $ = (id) => root.querySelector(`#${id}`);
    const sides = { front: null, back: null };
    let [w, h] = CARD, preset = 'card';

    const canvas = $('idPreview');
    const ctx = canvas.getContext('2d');
    const K = canvas.width / PAGE[0]; // preview pixels per mm

    function draw() {
      ctx.fillStyle = '#e9e5dc'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
      const x = ((PAGE[0] - w) / 2) * K;
      [['front', TOP], ['back', TOP + h + GAP]].forEach(([side, y]) => {
        const img = sides[side];
        if (img) cover(ctx, img, x, y * K, w * K, h * K);
        else { ctx.fillStyle = '#f1efe9'; ctx.fillRect(x, y * K, w * K, h * K); ctx.fillStyle = '#8a8f8c'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(side === 'front' ? 'Front' : 'Back', x + (w * K) / 2, (y + h / 2) * K + 4); }
        ctx.strokeStyle = '#0e5e6f'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y * K, w * K, h * K);
      });
      // The drag handle, on the front card's bottom-right corner.
      const hx = x + w * K, hy = (TOP + h) * K;
      ctx.fillStyle = '#d99a1e'; ctx.beginPath(); ctx.arc(hx, hy, 8, 0, Math.PI * 2); ctx.fill();
      $('idSizeLabel').textContent = `${Math.round(w)} × ${Math.round(h)} mm`;
      $('idWidth').value = Math.round(w); $('idHeight').value = Math.round(h);
      $('btnMakeIdPage').disabled = !(sides.front && sides.back);
    }

    function choose(name) {
      preset = name;
      root.querySelectorAll('[data-id-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.idSize === name)));
      $('idCustom').hidden = name !== 'custom';
      const f = SIZES.find((s) => s[0] === name)[2];
      if (f) { w = CARD[0] * f; h = CARD[1] * f; }
      draw();
    }
    root.querySelectorAll('[data-id-size]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.idSize)));

    // Drag: the card keeps its shape and stays centred, so only the width is
    // read from the pointer.
    let dragging = false;
    const toMm = (e) => { const r = canvas.getBoundingClientRect(); return [((e.clientX - r.left) * canvas.width) / r.width / K, ((e.clientY - r.top) * canvas.height) / r.height / K]; };
    canvas.addEventListener('pointerdown', (e) => {
      const [mx, my] = toMm(e);
      if (Math.hypot(mx - ((PAGE[0] + w) / 2), my - (TOP + h)) > 14) return;
      dragging = true; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const [mx, my] = toMm(e);
      const nearHandle = Math.hypot(mx - ((PAGE[0] + w) / 2), my - (TOP + h)) <= 14;
      canvas.style.cursor = dragging || nearHandle ? 'nwse-resize' : 'default';
      if (!dragging) return;
      const ratio = h / w;
      const nw = Math.round((mx - PAGE[0] / 2) * 2);
      if (fits(nw, nw * ratio)) { w = nw; h = nw * ratio; preset = 'custom'; choose('custom'); }
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });

    ['idWidth', 'idHeight'].forEach((id) => $(id).addEventListener('change', () => {
      const nw = Number($('idWidth').value), nh = Number($('idHeight').value);
      if (fits(nw, nh)) { w = nw; h = nh; draw(); }
      else { $('idWidth').value = Math.round(w); $('idHeight').value = Math.round(h); }
    }));

    ['front', 'back'].forEach((side) => {
      const btn = $(side === 'front' ? 'idScanFront' : 'idScanBack');
      btn.addEventListener('click', () => open({
        multi: false,
        title: `Scan the ${side}`,
        onDone: (c) => { sides[side] = c; btn.lastChild.textContent = ` ${side === 'front' ? 'Front' : 'Back'} added. Rescan`; draw(); },
      }));
    });

    $('btnMakeIdPage').addEventListener('click', async () => {
      const page = idPage(sides.front, sides.back, w, h);
      const blob = await new Promise((r) => page.toBlob(r, 'image/jpeg', 0.9));
      onFile(new File([blob], 'id-card-both-sides.jpg', { type: 'image/jpeg' }));
    });

    choose(preset);
  }

  global.PrintOkScan = {
    document: (onFile) => open({ multi: true, title: 'Scan a document', onDone: onFile }),
    single: (title, onCanvas) => open({ multi: false, title, onDone: onCanvas }),
    idTool,
    shrinkImage,
    decode,
    // For services/api/src/tests/scan.test.ts, which checks these outside a browser.
    _internals: { homography, buildPdf },
  };
})(window);
