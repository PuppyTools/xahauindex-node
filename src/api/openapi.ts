import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiSchema {
  type?: string;
  description?: string;
  nullable?: boolean;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  $ref?: string;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
}

export interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  $ref?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiExample {
  summary?: string;
  value?: unknown;
  $ref?: string;
}

export interface OpenApiMedia {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, OpenApiExample>;
}

export interface OpenApiResponse {
  description?: string;
  $ref?: string;
  content?: Record<string, OpenApiMedia>;
}

export interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  responses?: Record<string, OpenApiResponse>;
  'x-try'?: string;
  'x-websocket'?: boolean;
  'x-messages'?: Array<{ title: string; value: unknown }>;
}

export interface CookbookEntry {
  title: string;
  curl: string;
  note?: string;
}

export interface DocsCard {
  title: string;
  body: string;
}

export interface DocsExtension {
  kicker?: string;
  headline?: string;
  lede?: string;
  chips?: string[];
  conventions?: DocsCard[];
  recipes?: DocsCard[];
  schema_cards?: string[];
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  tags?: OpenApiTag[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    parameters?: Record<string, OpenApiParameter>;
    schemas?: Record<string, OpenApiSchema>;
    responses?: Record<string, OpenApiResponse>;
    examples?: Record<string, OpenApiExample>;
  };
  'x-docs'?: DocsExtension;
  'x-cookbook'?: CookbookEntry[];
}

export function resolveAsset(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), relativePath),
    join(here, '../..', relativePath),
    join(here, '../../..', relativePath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Missing asset ${relativePath}`);
}

export function loadOpenApiYaml(): string {
  return readFileSync(resolveAsset('docs/openapi.yaml'), 'utf8');
}

export function parseOpenApi(yaml: string): OpenApiSpec {
  const parsed: unknown = parseYaml(yaml);
  if (!isRecord(parsed) || typeof parsed.openapi !== 'string' || !isRecord(parsed.info)) {
    throw new Error('docs/openapi.yaml is not a valid OpenAPI document');
  }
  if (!isRecord(parsed.paths)) {
    throw new Error('docs/openapi.yaml is missing paths');
  }
  return parsed as unknown as OpenApiSpec;
}

export function loadOpenApi(): OpenApiSpec {
  return parseOpenApi(loadOpenApiYaml());
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveRef<T>(spec: OpenApiSpec, ref: string): T {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: unknown = spec;
  for (const part of parts) {
    if (!isRecord(node) || !(part in node)) {
      throw new Error(`Unresolvable $ref ${ref}`);
    }
    node = node[part];
  }
  return node as T;
}

export function resolveParameter(spec: OpenApiSpec, parameter: OpenApiParameter): OpenApiParameter {
  if (parameter.$ref !== undefined) {
    return resolveRef<OpenApiParameter>(spec, parameter.$ref);
  }
  return parameter;
}

export function resolveResponse(spec: OpenApiSpec, response: OpenApiResponse): OpenApiResponse {
  if (response.$ref !== undefined) {
    return resolveRef<OpenApiResponse>(spec, response.$ref);
  }
  return response;
}

export function resolveExample(spec: OpenApiSpec, example: OpenApiExample): OpenApiExample {
  if (example.$ref !== undefined) {
    return resolveRef<OpenApiExample>(spec, example.$ref);
  }
  return example;
}

export function resolveSchema(spec: OpenApiSpec, schema: OpenApiSchema): OpenApiSchema {
  if (schema.$ref !== undefined) {
    return resolveRef<OpenApiSchema>(spec, schema.$ref);
  }
  if (schema.allOf !== undefined && schema.allOf.length > 0) {
    const merged: OpenApiSchema = { ...schema };
    const properties: Record<string, OpenApiSchema> = { ...schema.properties };
    for (const part of schema.allOf) {
      const resolved = resolveSchema(spec, part);
      Object.assign(properties, resolved.properties ?? {});
      if (resolved.description !== undefined && merged.description === undefined) {
        merged.description = resolved.description;
      }
    }
    merged.properties = properties;
    delete merged.allOf;
    delete merged.$ref;
    return merged;
  }
  return schema;
}

export function exampleValues(spec: OpenApiSpec, media: OpenApiMedia | undefined): unknown[] {
  if (media === undefined) {
    return [];
  }
  const values: unknown[] = [];
  if (media.examples !== undefined) {
    for (const example of Object.values(media.examples)) {
      const resolved = resolveExample(spec, example);
      if (resolved.value !== undefined) {
        values.push(resolved.value);
      }
    }
  }
  if (values.length === 0 && media.example !== undefined) {
    values.push(media.example);
  }
  return values;
}

export function operationsOf(
  spec: OpenApiSpec,
): Array<{ path: string; method: string; operation: OpenApiOperation }> {
  const out: Array<{ path: string; method: string; operation: OpenApiOperation }> = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method.startsWith('x-')) {
        continue;
      }
      out.push({ path, method, operation });
    }
  }
  return out;
}
