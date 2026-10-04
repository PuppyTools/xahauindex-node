import {
  DEFAULT_API_BASE_URL,
  resolveWsMaxPerIp,
  rewriteDocsBaseUrl,
  type Config,
} from '../config.js';
import type {
  CookbookEntry,
  DocsCard,
  OpenApiOperation,
  OpenApiSchema,
  OpenApiSpec,
} from './openapi.js';
import {
  exampleValues,
  operationsOf,
  resolveParameter,
  resolveResponse,
  resolveSchema,
} from './openapi.js';

export const COOKBOOK_START = '<!-- COOKBOOK:START -->';
export const COOKBOOK_END = '<!-- COOKBOOK:END -->';

const TAG_TITLES: Record<string, string> = {
  status: 'Status',
  tokens: 'Tokens',
  uritokens: 'URITokens',
  issuers: 'Issuers',
  prices: 'Prices & trades',
  hooks: 'Hooks',
  subscribe: 'WebSocket',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapePre(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function inlineMarkdown(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replaceAll(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    )
    .replaceAll(/`([^`]+)`/g, '<code>$1</code>')
    .replaceAll('\n', '<br>');
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function cookbookOf(spec: OpenApiSpec): CookbookEntry[] {
  return spec['x-cookbook'] ?? [];
}

function tagOrder(spec: OpenApiSpec): string[] {
  const tagged = spec.tags?.map((tag) => tag.name) ?? [];
  const seen = new Set(tagged);
  for (const { operation } of operationsOf(spec)) {
    for (const tag of operation.tags ?? []) {
      if (!seen.has(tag)) {
        tagged.push(tag);
        seen.add(tag);
      }
    }
  }
  return tagged;
}

function tagTitle(tag: string): string {
  return TAG_TITLES[tag] ?? tag;
}

function tryHref(path: string, operation: OpenApiOperation, baseUrl: string): string | null {
  if (operation['x-websocket'] === true) {
    return null;
  }
  const href = operation['x-try'] ?? (path.includes('{') ? null : path);
  if (href === null) {
    return null;
  }
  if (/^https?:\/\//.test(href)) {
    return href;
  }
  return `${baseUrl}${href.startsWith('/') ? href : `/${href}`}`;
}

function renderCards(cards: DocsCard[] | undefined, empty: string): string {
  if (cards === undefined || cards.length === 0) {
    return `<p class="sub">${escapeHtml(empty)}</p>`;
  }
  return `<div class="grid">${cards
    .map(
      (card) => `<article class="card"><h4>${escapeHtml(card.title)}</h4><p>${inlineMarkdown(card.body)}</p></article>`,
    )
    .join('')}</div>`;
}

function parameterDescription(parameter: {
  description?: string;
  schema?: { description?: string; enum?: unknown[]; default?: unknown; type?: string };
}): string {
  if (parameter.description !== undefined && parameter.description !== '') {
    return parameter.description;
  }
  const schema = parameter.schema;
  if (schema?.description !== undefined && schema.description !== '') {
    return schema.description;
  }
  const bits: string[] = [];
  if (schema?.enum !== undefined && schema.enum.length > 0) {
    bits.push(schema.enum.map(String).join(', '));
  }
  if (schema?.default !== undefined) {
    bits.push(`Default ${String(schema.default)}`);
  }
  if (bits.length === 0 && schema?.type !== undefined) {
    bits.push(schema.type);
  }
  return bits.join('. ');
}

function renderParameters(spec: OpenApiSpec, operation: OpenApiOperation): string {
  const parameters = (operation.parameters ?? []).map((parameter) => resolveParameter(spec, parameter));
  if (parameters.length === 0) {
    return '';
  }
  const rows = parameters
    .map((parameter) => {
      const name = parameter.name ?? '';
      const loc = parameter.in ?? 'query';
      const optional = parameter.required === true ? '' : ' opt';
      const description = parameterDescription(parameter);
      return `<tr><td><code>${escapeHtml(name)}</code></td><td><span class="pill${optional}">${escapeHtml(loc)}</span></td><td>${inlineMarkdown(description)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Param</th><th></th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCodeBlock(label: string, text: string): string {
  return `<details class="sample">
          <summary>
            <span>${escapeHtml(label)}</span>
            <button class="copy" type="button">Copy</button>
          </summary>
          <pre>${escapePre(text)}</pre>
        </details>`;
}

function renderExamples(spec: OpenApiSpec, operation: OpenApiOperation): string {
  const blocks: string[] = [];
  if (operation['x-messages'] !== undefined) {
    for (const message of operation['x-messages']) {
      blocks.push(renderCodeBlock(message.title, prettyJson(message.value)));
    }
    return blocks.join('');
  }
  for (const response of Object.values(operation.responses ?? {})) {
    const resolved = resolveResponse(spec, response);
    const media = resolved.content?.['application/json'];
    for (const value of exampleValues(spec, media)) {
      blocks.push(renderCodeBlock('Sample response', prettyJson(value)));
    }
  }
  return blocks.join('');
}

function renderOperation(
  spec: OpenApiSpec,
  path: string,
  method: string,
  operation: OpenApiOperation,
  baseUrl: string,
): string {
  const websocket = operation['x-websocket'] === true;
  const verb = websocket ? 'WS' : method.toUpperCase();
  const href = tryHref(path, operation, baseUrl);
  const tryLink =
    href === null
      ? ''
      : `<a class="try" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Open</a>`;
  const description = operation.description ?? '';
  return `<article class="endpoint">
          <header>
            <span class="verb${websocket ? ' ws' : ''}">${escapeHtml(verb)}</span>
            <span class="path">${escapeHtml(path)}</span>
            ${tryLink}
          </header>
          <div class="body">
            ${description === '' ? '' : `<p class="sub">${inlineMarkdown(description)}</p>`}
            ${renderParameters(spec, operation)}
            ${renderExamples(spec, operation)}
          </div>
        </article>`;
}

function renderTagSection(spec: OpenApiSpec, tag: string, baseUrl: string): string {
  const ops = operationsOf(spec).filter(({ operation }) => (operation.tags ?? []).includes(tag));
  if (ops.length === 0) {
    return '';
  }
  const tagMeta = spec.tags?.find((item) => item.name === tag);
  const title = tagTitle(tag);
  const description = tagMeta?.description ?? '';
  return `<section id="${escapeHtml(tag)}">
        <h3>${escapeHtml(title)}</h3>
        ${description === '' ? '' : `<p class="sub">${inlineMarkdown(description)}</p>`}
        ${ops.map(({ path, method, operation }) => renderOperation(spec, path, method, operation, baseUrl)).join('')}
      </section>`;
}

function schemaPropertyRows(spec: OpenApiSpec, schema: OpenApiSchema): string {
  const resolved = resolveSchema(spec, schema);
  const properties = resolved.properties ?? {};
  return Object.entries(properties)
    .map(([name, property]) => {
      const resolvedProperty = resolveSchema(spec, property);
      const description =
        resolvedProperty.description ??
        (resolvedProperty.enum === undefined ? '' : resolvedProperty.enum.map(String).join(' · '));
      return `<tr><td><code>${escapeHtml(name)}</code></td><td>${inlineMarkdown(description)}</td></tr>`;
    })
    .join('');
}

function renderSchemas(spec: OpenApiSpec): string {
  const names = spec['x-docs']?.schema_cards ?? [];
  const cards = names
    .map((name) => {
      const schema = spec.components?.schemas?.[name];
      if (schema === undefined) {
        return '';
      }
      return `<article class="card" style="margin-bottom:14px">
          <h4>${escapeHtml(name)}</h4>
          <table>
            <tbody>
              ${schemaPropertyRows(spec, schema)}
            </tbody>
          </table>
        </article>`;
    })
    .filter((card) => card !== '')
    .join('');
  return `<section id="schemas">
        <h3>Schemas</h3>
        <p class="sub">Field-level contract from <code>docs/openapi.yaml</code>. Nullable strings are JSON <code>null</code>, not omitted, unless noted as optional.</p>
        ${cards}
      </section>`;
}

function renderCookbookHtml(entries: CookbookEntry[], baseUrl: string): string {
  const blocks = entries
    .map((entry) => {
      const curl = rewriteDocsBaseUrl(entry.curl.trim(), baseUrl);
      return `<article class="card cookbook">
          <div class="code-head">
            <h4>${escapeHtml(entry.title)}</h4>
            <button class="copy" type="button">Copy</button>
          </div>
          ${entry.note === undefined ? '' : `<p>${inlineMarkdown(entry.note)}</p>`}
          <pre>${escapePre(curl)}</pre>
        </article>`;
    })
    .join('');
  return `<section id="cookbook">
        <h3>Cookbook</h3>
        <p class="sub">Copy-paste against this node. The same list lives in <a href="/docs/cookbook.md">/docs/cookbook.md</a>.</p>
        ${blocks}
      </section>`;
}

function renderErrors(spec: OpenApiSpec): string {
  const errorExample = spec.components?.examples?.NotFound?.value ?? {
    error: { code: 'NOT_FOUND', message: 'Token USD/rHb9… not found' },
  };
  return `<section id="errors">
        <h3>Errors</h3>
        <p class="sub">Failures are not wrapped in the data envelope.</p>
        <pre>${escapePre(prettyJson(errorExample))}</pre>
        <table>
          <thead><tr><th>Code</th><th>When</th></tr></thead>
          <tbody>
            <tr><td><code>NOT_FOUND</code></td><td>Unknown route or object</td></tr>
            <tr><td><code>BAD_REQUEST</code></td><td>Missing IOU issuer, invalid JSON subscribe, or a 400 from validation</td></tr>
            <tr><td><code>RATE_LIMITED</code></td><td>Optional operator limit (<code>API_RATE_LIMIT_MAX</code> / <code>API_WS_MAX_PER_IP</code>). HTTP <code>429</code> plus <code>Retry-After</code></td></tr>
            <tr><td><code>INTERNAL</code></td><td>Unexpected server error</td></tr>
          </tbody>
        </table>
      </section>`;
}

export function renderCookbookMarkdown(
  spec: OpenApiSpec,
  options: { standalone?: boolean; baseUrl?: string } = {},
): string {
  const entries = cookbookOf(spec);
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  const lines: string[] = [];
  if (options.standalone !== false) {
    lines.push(
      '# XahauIndex cookbook',
      '',
      'Generated from `x-cookbook` in [`docs/openapi.yaml`](openapi.yaml). Do not edit this file by hand — run `npm run docs:sync`.',
      '',
      'XahauIndex is an independent PuppyTools project. It is not affiliated with, endorsed by, or a product of the Xahau network or its operators. The XI mark is original artwork inspired by [Xahau/Graphics](https://github.com/Xahau/Graphics).',
      '',
      `Project site: ${spec['x-docs']?.site ?? 'https://xahauindex.dev'}.`,
      '',
      `Base URL: \`${baseUrl}\`. Wait until \`/v1/status\` reports \`snapshot_status: complete\` before expecting token, URIToken, issuer, or Hook lists.`,
      '',
    );
  }
  for (const entry of entries) {
    lines.push(`## ${entry.title}`, '');
    if (entry.note !== undefined) {
      lines.push(entry.note, '');
    }
    lines.push('```bash', rewriteDocsBaseUrl(entry.curl.trim(), baseUrl), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

export function replaceCookbookSection(source: string, cookbook: string): string {
  const start = source.indexOf(COOKBOOK_START);
  const end = source.indexOf(COOKBOOK_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('README.md is missing COOKBOOK markers');
  }
  return `${source.slice(0, start + COOKBOOK_START.length)}\n\n${cookbook.trim()}\n\n${source.slice(end)}`;
}

export function formatDurationMs(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  if (ms % 1000 === 0) {
    const seconds = ms / 1000;
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
  }
  return `${ms} ms`;
}

function renderNotice(docs: NonNullable<OpenApiSpec['x-docs']>): string {
  const notice = docs.notice?.trim() ?? '';
  if (notice === '') {
    return '';
  }
  return `<p class="notice">${inlineMarkdown(notice)}</p>`;
}

function renderSite(docs: NonNullable<OpenApiSpec['x-docs']>): string {
  const site = docs.site?.trim() ?? '';
  if (site === '') {
    return '';
  }
  return `Project site: <a href="${escapeHtml(site)}">${escapeHtml(site.replace(/^https?:\/\//, ''))}</a>.`;
}

function renderDonate(docs: NonNullable<OpenApiSpec['x-docs']>): string {
  const address = docs.donate?.address?.trim() ?? '';
  if (address === '') {
    return '';
  }
  const label = docs.donate?.label?.trim() || 'Donations in XAH';
  return `<p class="donate">${escapeHtml(label)}: <code>${escapeHtml(address)}</code></p>`;
}

function renderTry(spec: OpenApiSpec, config?: Config): string {
  if (config === undefined || config.apiRateLimitMax === null) {
    return '';
  }
  const docs = spec['x-docs'] ?? {};
  const title = docs.try?.title?.trim() || 'Try this node';
  const body =
    docs.try?.body?.trim() ||
    'Feel free to test this instance. These are the limits on this process.';
  const window = formatDurationMs(config.apiRateLimitWindowMs);
  const ws = resolveWsMaxPerIp(config);
  const wsLine =
    ws === null
      ? ''
      : `<li><code>/v1/subscribe</code> — ${ws.toLocaleString('en-US')} concurrent sockets per IP</li>`;
  return `<div class="limits">
        <h3>${escapeHtml(title)}</h3>
        <p>${inlineMarkdown(body)}</p>
        <ul>
          <li>HTTP — ${config.apiRateLimitMax.toLocaleString('en-US')} requests per IP every ${escapeHtml(window)}</li>
          ${wsLine}
        </ul>
      </div>`;
}

export function renderDocsHtml(spec: OpenApiSpec, config?: Config): string {
  const docs = spec['x-docs'] ?? {};
  const baseUrl = config?.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const cookbook = cookbookOf(spec);
  const tags = tagOrder(spec);
  const restTags = tags.filter((tag) => tag !== 'subscribe');
  const navRest = restTags
    .map((tag) => `<a href="#${escapeHtml(tag)}">${escapeHtml(tagTitle(tag))}</a>`)
    .join('\n        ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(spec.info.title)}</title>
  <meta name="description" content="${escapeHtml(docs.lede ?? spec.info.description ?? spec.info.title)}">
  <link rel="icon" href="/docs/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
  <button class="menu" type="button" id="menu">Menu</button>
  <div class="app">
    <aside id="sidebar">
      <div class="brand">
        <img class="mark" src="/docs/xi.svg" alt="">
        <div>
          <h1>XahauIndex</h1>
          <p>Metadata node API</p>
        </div>
      </div>
      <div class="node-meta">
        <div>
          <div class="meta-label">Status</div>
          <div class="status"><span class="dot" id="dot"></span><span id="status">Checking this node…</span></div>
        </div>
        <div>
          <div class="meta-label">Data Range</div>
          <div class="status range"><span id="range">Checking this node…</span></div>
        </div>
      </div>
      <nav>
        <div class="group">Start</div>
        <a href="#overview">Overview</a>
        <a href="#conventions">Conventions</a>
        <a href="#recipes">Recipes</a>
        <a href="#cookbook">Cookbook</a>
        <a href="#errors">Errors</a>
        <div class="group">REST</div>
        ${navRest}
        <div class="group">Realtime</div>
        <a href="#subscribe">WebSocket</a>
        <div class="group">Reference</div>
        <a href="#schemas">Schemas</a>
        <a href="/v1/openapi.yaml">openapi.yaml</a>
        <a href="/docs/cookbook.md">cookbook.md</a>
      </nav>
    </aside>
    <main>
      <header class="hero" id="overview">
        <div class="kicker">${escapeHtml(docs.kicker ?? 'Xahau network · self-hosted')}</div>
        <h2>${escapeHtml(docs.headline ?? spec.info.title)}</h2>
        <p class="lede">${inlineMarkdown(docs.lede ?? spec.info.description ?? '')}</p>
        ${renderNotice(docs)}
        ${renderDonate(docs)}
        ${renderTry(spec, config)}
      </header>

      <section id="conventions">
        <h3>Conventions</h3>
        <p class="sub">Every successful JSON body uses the same envelope. Identifiers never cram <code>:</code> or <code>+</code> into one path segment.</p>
        ${renderCards(docs.conventions, '')}
      </section>

      <section id="recipes">
        <h3>Recipes</h3>
        <p class="sub">Same node, three consumers. All of these are live on this instance after snapshot completes (<code>/v1/status</code> → <code>live</code>).</p>
        ${renderCards(docs.recipes, '')}
      </section>

      ${renderCookbookHtml(cookbook, baseUrl)}
      ${renderErrors(spec)}
      ${restTags.map((tag) => renderTagSection(spec, tag, baseUrl)).join('\n')}
      ${renderTagSection(spec, 'subscribe', baseUrl)}
      ${renderSchemas(spec)}

      <footer>
        ${renderNotice(docs)}
        ${renderSite(docs)}
        This page is generated from <a href="/v1/openapi.yaml">/v1/openapi.yaml</a>.
        Source: <a href="https://github.com/PuppyTools/xahauindex-node">PuppyTools/xahauindex-node</a>.
        MIT.
      </footer>
    </main>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const rangeEl = document.getElementById('range');
    const dot = document.getElementById('dot');
    const ledgerLabel = (value) => Number(value).toLocaleString('en-US');
    const rangeLabel = (data) => {
      const end = Number(data.ledger_index);
      const starts = [data.history_start_ledger, data.snapshot_ledger]
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (!Number.isInteger(end) || end <= 0) {
        return 'No ledger data yet';
      }
      const start = starts.length === 0 ? end : Math.min(...starts, end);
      if (start === end) {
        return ledgerLabel(end);
      }
      return ledgerLabel(start) + ' – ' + ledgerLabel(end);
    };
    fetch('/v1/status')
      .then((r) => r.json())
      .then((body) => {
        const data = body.data || {};
        const label = data.status || 'unknown';
        statusEl.textContent = label === 'live'
          ? 'This node is live at ledger ' + data.ledger_index
          : 'This node is ' + label;
        dot.classList.add(label);
        rangeEl.textContent = rangeLabel(data);
      })
      .catch(() => {
        statusEl.textContent = 'Status unavailable';
        rangeEl.textContent = 'Range unavailable';
      });

    const links = [...document.querySelectorAll('nav a[href^="#"]')];
    const setActive = () => {
      const hash = location.hash || '#overview';
      for (const link of links) {
        link.classList.toggle('active', link.getAttribute('href') === hash);
      }
    };
    window.addEventListener('hashchange', setActive);
    setActive();

    document.getElementById('menu').addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });
    for (const link of links) {
      link.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
      });
    }

    const copyText = async (text) => {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (_error) {
          // fall through to execCommand
        }
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    };

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button.copy');
      if (!button) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const block = button.closest('details, article, .code-block');
      const pre = block ? block.querySelector('pre') : null;
      const text = pre ? pre.textContent || '' : '';
      try {
        await copyText(text);
        button.textContent = 'Copied';
      } catch (_error) {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => { button.textContent = 'Copy'; }, 1200);
    });
  </script>
</body>
</html>
`;
}
