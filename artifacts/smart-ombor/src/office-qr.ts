import { jsPDF } from 'jspdf';
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
  ctx.fillStyle = '#0f1b2d';
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.get(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, line: number) {
  const words = text.split(' ');
  let row = '';
  let top = y;
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (ctx.measureText(next).width > max) {
      ctx.fillText(row, x, top);
      row = word;
      top += line;
    } else row = next;
  }
  if (row) ctx.fillText(row, x, top);
  return top;
}

export async function downloadOfficeQrA4(token: string, copy: { brand: string; office: string; title: string; hint: string; geo: string }) {
  const width = 2480;
  const height = 3508;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#f4f7fb';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#0f1b2d';
  ctx.fillRect(0, 0, width, 320);
  ctx.fillStyle = '#2f54eb';
  ctx.fillRect(0, 320, width, 16);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '700 92px Inter, Segoe UI, sans-serif';
  ctx.fillText(copy.brand, width / 2, 155);
  ctx.font = '500 44px Inter, Segoe UI, sans-serif';
  ctx.fillStyle = '#c7d2fe';
  ctx.fillText(copy.office, width / 2, 230);
  ctx.fillStyle = '#0f1b2d';
  ctx.font = '700 70px Inter, Segoe UI, sans-serif';
  ctx.fillText(copy.title, width / 2, 460);
  const qr = officeQrCanvas(token, 18);
  const size = 1480;
  const x = (width - size) / 2;
  const y = 540;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x - 70, y - 70, size + 140, size + 140, 48);
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.drawImage(qr, x, y, size, size);
  ctx.fillStyle = '#334155';
  ctx.font = '500 42px Inter, Segoe UI, sans-serif';
  wrap(ctx, copy.hint, width / 2, y + size + 180, 1900, 58);
  ctx.fillStyle = '#2f54eb';
  ctx.font = '700 40px Inter, Segoe UI, sans-serif';
  ctx.fillText(copy.geo, width / 2, height - 220);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '400 32px Inter, Segoe UI, sans-serif';
  ctx.fillText('Smart Ombor', width / 2, height - 140);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297);
  doc.save('bordo-ofis-davomat-qr-A4.pdf');
}
