import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderCookbookMarkdown, replaceCookbookSection } from '../src/api/docsPage.js';
import { loadOpenApi } from '../src/api/openapi.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = loadOpenApi();
const cookbook = renderCookbookMarkdown(spec);
writeFileSync(join(root, 'docs/cookbook.md'), cookbook);

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
writeFileSync(
  readmePath,
  replaceCookbookSection(readme, renderCookbookMarkdown(spec, { standalone: false })),
);
console.log('Wrote docs/cookbook.md and refreshed README.md cookbook section');
