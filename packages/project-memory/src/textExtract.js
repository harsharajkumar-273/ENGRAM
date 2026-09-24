import { readFile } from 'fs/promises';
import path from 'path';

// Native-text extraction only for this prototype — no OCR (Phase 6, deferred).
// Returns { text, pages, unsupported }.
export async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    return { text: await readFile(filePath, 'utf8'), pages: null, unsupported: false };
  }

  if (ext === '.pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = await readFile(filePath);
    const data = await pdfParse(buf);
    return { text: data.text, pages: data.numpages, unsupported: false };
  }

  return { text: null, pages: null, unsupported: true };
}

// Paragraph-based chunker with a hard max-size fallback split, so no chunk
// exceeds maxChars regardless of paragraph length.
export function chunkText(text, { maxChars = 1200 } = {}) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };

  for (const para of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (candidate.length > maxChars && buffer) {
      flush();
      buffer = para;
    } else {
      buffer = candidate;
    }
    while (buffer.length > maxChars) {
      chunks.push(buffer.slice(0, maxChars).trim());
      buffer = buffer.slice(maxChars);
    }
  }
  flush();

  return chunks;
}
