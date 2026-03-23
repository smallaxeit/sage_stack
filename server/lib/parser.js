import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parse as csvParse } from 'csv-parse/sync';

export async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fs.readFile(filePath);

  switch (ext) {
    case '.pdf':
      return parsePdf(raw);
    case '.txt':
    case '.md':
      return raw.toString('utf-8');
    case '.json':
      return parseJson(raw);
    case '.csv':
      return parseCsv(raw);
    default:
      console.warn(`Unsupported file type: ${ext}, skipping.`);
      return null;
  }
}

async function parsePdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}

function parseJson(buffer) {
  const obj = JSON.parse(buffer.toString('utf-8'));
  return JSON.stringify(obj, null, 2);
}

function parseCsv(buffer) {
  const records = csvParse(buffer, { columns: true, skip_empty_lines: true });
  return records.map(row => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n');
}

export async function loadContentDir(dirPath) {
  const files = await fs.readdir(dirPath);
  const docs = [];

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      console.log(`Parsing: ${file}`);
      const text = await parseFile(fullPath);
      if (text) {
        docs.push({ source: file, text: text.trim() });
      }
    }
  }

  return docs;
}
