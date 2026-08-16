import { describe, expect, it } from 'vitest';
import { DocumentRouter } from './index.js';

function makeTextPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

describe('DocumentRouter', () => {
  it('parses plain text locally', async () => {
    const result = await new DocumentRouter().parse(Buffer.from('hello runtime'), { mime: 'text/plain', extension: 'txt' });
    expect(result.markdown).toBe('hello runtime');
    expect(result.parser).toBe('plain-text');
  });

  it('classifies and parses a native-text PDF without OCR', async () => {
    const result = await new DocumentRouter().parse(makeTextPdf('Hello Feather Runtime'), { mime: 'application/pdf', extension: 'pdf' });
    expect(result.markdown).toContain('Hello Feather Runtime');
    expect(result.parser).toContain('pdf-inspector');
  });
});
