// Polyfill browser globals required by pdfjs-dist / pdf-parse when running in edge V8 environments
class SimpleDOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  m11 = 1; m12 = 0; m13 = 0; m14 = 0;
  m21 = 0; m22 = 1; m23 = 0; m24 = 0;
  m31 = 0; m32 = 0; m33 = 1; m34 = 0;
  m41 = 0; m42 = 0; m43 = 0; m44 = 1;
  is2D = true;
  isIdentity = true;
  constructor(init?: any) {}
  static fromMatrix(other?: any) { return new SimpleDOMMatrix(); }
  static fromFloat32Array(array?: any) { return new SimpleDOMMatrix(); }
  static fromFloat64Array(array?: any) { return new SimpleDOMMatrix(); }
  multiply(m?: any) { return this; }
  multiplySelf(m?: any) { return this; }
  preMultiplySelf(m?: any) { return this; }
  translate(x = 0, y = 0, z = 0) { return this; }
  scale(x = 1, y = 1, z = 1) { return this; }
  rotate(rot = 0) { return this; }
  invertSelf() { return this; }
  inverse() { return this; }
  transformPoint(point?: any) { return point || { x: 0, y: 0, z: 0, w: 1 }; }
}

if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = SimpleDOMMatrix;
}
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(w = 1, h = 1) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {
    addPath() {}
    rect() {}
    arc() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
  };
}

export {};
