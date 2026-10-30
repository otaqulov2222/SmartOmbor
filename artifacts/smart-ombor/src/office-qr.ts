import { BarcodeFormat, EncodeHintType, QRCodeWriter } from '@zxing/library';

export function officeQrCanvas(value: string, scale = 8) {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 2]]);
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, hints);
  const n = matrix.getWidth();
  const canvas = document.createElement('canvas');
  canvas.width = n * scale;
  canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.get(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return canvas;
}

export function officeQrSvg(value: string) {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 1]]);
  const matrix = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, hints);
  const n = matrix.getWidth();
  const cells: string[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.get(x, y)) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  }
  return { n, html: cells.join('') };
}
