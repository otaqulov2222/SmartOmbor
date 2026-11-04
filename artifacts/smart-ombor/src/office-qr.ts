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

function drawCornerBrackets(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, arm = 96, radius = 36) {
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';

  // Top-left
  ctx.beginPath();
  ctx.moveTo(x, y + arm);
  ctx.arcTo(x, y, x + arm, y, radius);
  ctx.lineTo(x + arm, y);
  ctx.stroke();

  // Top-right
  ctx.beginPath();
  ctx.moveTo(x + size - arm, y);
  ctx.arcTo(x + size, y, x + size, y + arm, radius);
  ctx.lineTo(x + size, y + arm);
  ctx.stroke();

  // Bottom-left
  ctx.beginPath();
  ctx.moveTo(x, y + size - arm);
  ctx.arcTo(x, y + size, x + arm, y + size, radius);
  ctx.lineTo(x + arm, y + size);
  ctx.stroke();

  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(x + size - arm, y + size);
  ctx.arcTo(x + size, y + size, x + size, y + size - arm, radius);
  ctx.lineTo(x + size, y + size - arm);
  ctx.stroke();
}

export async function downloadOfficeQrA4(
  token: string,
  copy: { brand: string; office: string; title?: string; hint?: string; geo?: string },
) {
  const width = 2480;
  const height = 3508;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Deep modern background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0b1424');
  bg.addColorStop(0.5, '#0f1b2d');
  bg.addColorStop(1, '#0b1424');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle outer frame
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 4;
  roundRect(ctx, 110, 110, width - 220, height - 220, 64);
  ctx.stroke();

  // Top Brand Badge
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 132px Inter, Segoe UI, sans-serif';
  ctx.fillText(copy.brand || 'BORDO', width / 2, 520);

  // Blue accent pill under brand
  const pillW = 420;
  const pillH = 76;
  const pillX = (width - pillW) / 2;
  const pillY = 580;
  ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
  roundRect(ctx, pillX, pillY, pillW, pillH, 38);
  ctx.fill();
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#93c5fd';
  ctx.font = '700 38px Inter, Segoe UI, sans-serif';
  ctx.fillText('DAVOMAT QR', width / 2, pillY + 51);

  // White elevated QR Card
  const cardSize = 1680;
  const cardX = (width - cardSize) / 2;
  const cardY = 820;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 70;
  ctx.shadowOffsetY = 28;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, cardX, cardY, cardSize, cardSize, 72);
  ctx.fill();
  ctx.restore();

  // QR image inside card
  const qr = officeQrCanvas(token, 20);
  const qrSize = 1360;
  const qrX = (width - qrSize) / 2;
  const qrY = cardY + (cardSize - qrSize) / 2;
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  // Scanner corner brackets around QR
  drawCornerBrackets(ctx, qrX - 28, qrY - 28, qrSize + 56, 110, 32);

  // Minimal clean footer
  ctx.fillStyle = '#64748b';
  ctx.font = '600 36px Inter, Segoe UI, sans-serif';
  ctx.fillText('Smart Ombor', width / 2, height - 240);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 210, 297);
  doc.save('bordo-davomat-qr.pdf');
}
