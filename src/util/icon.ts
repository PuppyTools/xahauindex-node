const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)(?:[?#].*)?$/i;

export function normalizeIconUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = raw.trim();
  if (value === '') {
    return null;
  }
  const lowered = value.toLowerCase();
  if (
    lowered.startsWith('data:') ||
    lowered.startsWith('javascript:') ||
    lowered.startsWith('file:')
  ) {
    return null;
  }
  if (lowered.startsWith('ipfs://')) {
    const rest = value.slice('ipfs://'.length).replace(/^\/+/, '');
    if (rest === '' || rest.includes('..')) {
      return null;
    }
    return `ipfs://${rest}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  return value;
}

export function uriLooksLikeImage(uri: string): boolean {
  return IMAGE_EXT.test(uri.split('?')[0] ?? uri);
}

export function extractIconUrlFromMetadata(value: unknown): string | null {
  if (typeof value === 'string') {
    return normalizeIconUrl(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractIconUrlFromMetadata(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['image', 'image_url', 'icon', 'icon_url', 'imageUrl', 'iconUrl']) {
    if (!(key in record)) {
      continue;
    }
    const nested = record[key];
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested) && 'url' in nested) {
      const fromUrl = normalizeIconUrl(typeof nested.url === 'string' ? nested.url : null);
      if (fromUrl) {
        return fromUrl;
      }
    }
    const found = extractIconUrlFromMetadata(nested);
    if (found) {
      return found;
    }
  }
  return null;
}
