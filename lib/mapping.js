import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mappingPath = path.join(__dirname, '..', 'mapping.json');

let cache;

export function loadMapping() {
  if (!cache) {
    const file = fs.readFileSync(mappingPath, 'utf-8');
    cache = JSON.parse(file);
  }
  return cache;
}

export function refreshMapping() {
  cache = null;
  return loadMapping();
}

export { mappingPath };
