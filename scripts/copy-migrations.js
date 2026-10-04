import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const publicFrom = join(root, 'public');
const publicTo = join(root, 'dist', 'public');
mkdirSync(publicTo, { recursive: true });
cpSync(publicFrom, publicTo, { recursive: true });

const openapiFrom = join(root, 'docs', 'openapi.yaml');
const openapiTo = join(root, 'dist', 'docs');
mkdirSync(openapiTo, { recursive: true });
cpSync(openapiFrom, join(openapiTo, 'openapi.yaml'));
