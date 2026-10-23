'use strict';
// Turns uploaded documents into small "chunks" the search can find.
// - Catalogue JSON: one chunk per product and one per FAQ entry (best for menus).
// - Text / Markdown / PDF: split by paragraphs into ~800-character chunks.

const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 800;
const OVERLAP_CHARS = 120;

// Render any value (string, number, list, object) as readable text.
function renderValue(value, currency) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((v) => renderValue(v, currency)).join('; ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => {
        const text = renderValue(v, currency);
        return k === 'price' && typeof v === 'number' ? `${k}: ${currency}${v.toFixed(2)}` : `${k}: ${text}`;
      })
      .join(', ');
  }
  return String(value);
}

function itemToText(item, currency) {
  const lines = [`Product: ${item.name}${item.id ? ` (${item.id})` : ''}`];
  for (const [key, value] of Object.entries(item)) {
    if (key === 'name' || key === 'id') continue;
    if (key === 'price' && typeof value === 'number') {
      lines.push(`price: ${currency}${value.toFixed(2)}`);
    } else {
      lines.push(`${key}: ${renderValue(value, currency)}`);
    }
  }
  return lines.join('\n');
}

function chunkCatalogue(catalogue, source) {
  const currency = catalogue.business?.currency || 'RM';
  const chunks = [];
  if (catalogue.business) {
    chunks.push({
      id: `${source}#business`,
      source,
      text: `Business information\n${renderValue(catalogue.business, currency).split(', ').join('\n')}`,
    });
  }
  for (const item of catalogue.items || []) {
    chunks.push({ id: `${source}#${item.id || item.name}`, source, text: itemToText(item, currency) });
  }
  (catalogue.faq || []).forEach((entry, i) => {
    chunks.push({ id: `${source}#faq-${i + 1}`, source, text: `FAQ\nQ: ${entry.q}\nA: ${entry.a}` });
  });
  return chunks;
}

function chunkText(text, source) {
  const paragraphs = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push({ id: `${source}#${chunks.length + 1}`, source, text: current.trim() });
  };
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > MAX_CHARS) {
      push();
      current = current.slice(-OVERLAP_CHARS); // small overlap so context isn't cut mid-thought
    }
    if (para.length > MAX_CHARS) {
      for (let i = 0; i < para.length; i += MAX_CHARS - OVERLAP_CHARS) {
        current += (current ? '\n\n' : '') + para.slice(i, i + MAX_CHARS);
        push();
        current = '';
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  push();
  return chunks;
}

async function pdfToText(buffer) {
  let mod;
  try {
    mod = require('pdf-parse');
  } catch {
    throw new Error('Reading PDFs needs the pdf-parse package. Run: npm install pdf-parse');
  }
  if (typeof mod === 'function') return (await mod(buffer)).text; // pdf-parse v1
  if (mod.PDFParse) {
    const parser = new mod.PDFParse({ data: buffer }); // pdf-parse v2
    const result = await parser.getText();
    return result.text;
  }
  throw new Error('Unsupported pdf-parse version');
}

async function loadFile(filePath) {
  const source = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return chunkCatalogue(JSON.parse(fs.readFileSync(filePath, 'utf8')), source);
  if (ext === '.pdf') return chunkText(await pdfToText(fs.readFileSync(filePath)), source);
  if (['.txt', '.md', '.csv'].includes(ext)) return chunkText(fs.readFileSync(filePath, 'utf8'), source);
  throw new Error(`Unsupported file type: ${ext} (use .json, .pdf, .txt, .md or .csv)`);
}

module.exports = { loadFile, chunkCatalogue, chunkText };
