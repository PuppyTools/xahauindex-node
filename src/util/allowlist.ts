import { BlockList, isIP } from 'node:net';

type AddressFamily = 'ipv4' | 'ipv6';

type ParsedAllowlistEntry =
  | { kind: 'address'; address: string; family: AddressFamily }
  | { kind: 'subnet'; address: string; prefix: number; family: AddressFamily };

function familyOf(address: string): AddressFamily | null {
  const version = isIP(address);
  if (version === 4) {
    return 'ipv4';
  }
  if (version === 6) {
    return 'ipv6';
  }
  return null;
}

function parseAllowlistEntry(entry: string): ParsedAllowlistEntry {
  const slash = entry.lastIndexOf('/');
  if (slash === -1) {
    const family = familyOf(entry);
    if (family === null) {
      throw new Error(`API_RATE_LIMIT_ALLOW entry is not an IP or CIDR: ${entry}`);
    }
    return { kind: 'address', address: entry, family };
  }

  const address = entry.slice(0, slash);
  const prefix = Number.parseInt(entry.slice(slash + 1), 10);
  const family = familyOf(address);
  if (family === null) {
    throw new Error(`API_RATE_LIMIT_ALLOW entry is not an IP or CIDR: ${entry}`);
  }
  const maxPrefix = family === 'ipv4' ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`API_RATE_LIMIT_ALLOW ${family} prefix must be 0-${maxPrefix}: ${entry}`);
  }
  return { kind: 'subnet', address, prefix, family };
}

function addEntry(list: BlockList, entry: string): void {
  const parsed = parseAllowlistEntry(entry);
  if (parsed.kind === 'address') {
    list.addAddress(parsed.address, parsed.family);
    return;
  }
  list.addSubnet(parsed.address, parsed.prefix, parsed.family);
}

function ipAllowedBy(list: BlockList, ip: string): boolean {
  const family = familyOf(ip);
  if (family === 'ipv4') {
    return list.check(ip, 'ipv4');
  }
  if (family === 'ipv6') {
    if (list.check(ip, 'ipv6')) {
      return true;
    }
    if (ip.toLowerCase().startsWith('::ffff:')) {
      const mapped = ip.slice('::ffff:'.length);
      if (familyOf(mapped) === 'ipv4') {
        return list.check(mapped, 'ipv4');
      }
    }
  }
  return false;
}

export function parseIpAllowlist(raw: string): string[] {
  const entries = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const entry of entries) {
    parseAllowlistEntry(entry);
  }
  return entries;
}

export function createIpAllowlist(entries: readonly string[]): (ip: string) => boolean {
  if (entries.length === 0) {
    return () => false;
  }
  const list = new BlockList();
  for (const entry of entries) {
    addEntry(list, entry);
  }
  return (ip) => ipAllowedBy(list, ip);
}

export function ipInAllowlist(entries: readonly string[], ip: string): boolean {
  return createIpAllowlist(entries)(ip);
}
