import { describe, it, expect } from 'vitest';
import { loadPdfDocument } from '../PdfLoader';

/**
 * Builds a tiny valid single-page PDF (empty page, 300×300pt) with correct
 * xref offsets, so pdf.js can parse it without any real-world assets.
 */
function buildMinimalPdf(): ArrayBuffer {
  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\n',
  ];
  for (const obj of objects) {
    offsets.push(parts.join('').length);
    parts.push(obj);
  }

  const xrefPos = parts.join('').length;
  let xref = 'xref\n0 4\n0000000000 65535 f \n';
  for (let i = 1; i <= 3; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  parts.push(xref);
  parts.push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new TextEncoder().encode(parts.join('')).buffer;
}

describe('loadPdfDocument', () => {
  it('parses a minimal PDF and reports page count + size', async () => {
    const { doc, numPages, firstPage } = await loadPdfDocument(buildMinimalPdf());
    expect(numPages).toBe(1);
    expect(firstPage.width).toBeCloseTo(300, 3);
    expect(firstPage.height).toBeCloseTo(300, 3);
    doc.destroy();
  });
});
