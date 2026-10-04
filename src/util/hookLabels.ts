export interface KnownHookLabel {
  name: string;
  project: string;
  description: string;
  url: string;
  source: 'catalog';
}

interface CatalogEntry extends KnownHookLabel {
  hookHash: string;
  account: string;
}

/**
 * Evernode system hook accounts are stable; hashes change when governance
 * elects new WASM. Hashes below were read from those accounts on Xahau
 * mainnet (`account_objects` type=hook, 2026-10-04).
 *
 * Accounts: https://docs.evernode.org/en/latest/platform/hooks/overview.html
 */
const EVERNODE_URL = 'https://docs.evernode.org/en/latest/platform/hooks/overview.html';

const EVERNODE: readonly CatalogEntry[] = [
  {
    hookHash: 'B0B11C2179638C3EFF12D52454AD46DBB22AB89DBBDB0497028AA7FA88677678',
    account: 'rBvKgF3jSZWdJcwSsmoJspoXLLDVLDp6jg',
    name: 'Evernode governor',
    project: 'Evernode',
    description: 'Governance proposals and hook-candidate elections',
    url: EVERNODE_URL,
    source: 'catalog',
  },
  {
    hookHash: 'B352CB9916C8CA2A47A500EBBD93EBADDC933FB82347B2B95E87B70186D06127',
    account: 'rmv53yu8Wid6kj6AC6NvmiwSXNxRa8vTH',
    name: 'Evernode registry',
    project: 'Evernode',
    description: 'Host registration and registration URITokens',
    url: EVERNODE_URL,
    source: 'catalog',
  },
  {
    hookHash: '1F7C84E14313C4FF2D4F39535428BF10767CCF8E87EFB51306CC3F94D13439EC',
    account: 'rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto',
    name: 'Evernode heartbeat',
    project: 'Evernode',
    description: 'Host heartbeats and reward distribution',
    url: EVERNODE_URL,
    source: 'catalog',
  },
  {
    hookHash: 'EFBB4898CD57CD274636431DBC7E90F04C49EA4721A754F7C40E471C381D91A4',
    account: 'rsfTBRAbD2bYjVuXhJ2RReQXxR4K5birVW',
    name: 'Evernode reputation',
    project: 'Evernode',
    description: 'Host reputation scoring',
    url: EVERNODE_URL,
    source: 'catalog',
  },
];

const BY_HASH = new Map(EVERNODE.map((entry) => [entry.hookHash, entry]));
const BY_ACCOUNT = new Map(EVERNODE.map((entry) => [entry.account, entry]));

function publicLabel(entry: CatalogEntry): KnownHookLabel {
  return {
    name: entry.name,
    project: entry.project,
    description: entry.description,
    url: entry.url,
    source: 'catalog',
  };
}

export function labelForHook(input: {
  hookHash: string;
  account?: string;
}): KnownHookLabel | null {
  const hash = input.hookHash.trim().toUpperCase();
  const fromHash = BY_HASH.get(hash);
  if (fromHash) {
    return publicLabel(fromHash);
  }
  if (input.account !== undefined && input.account !== '') {
    const fromAccount = BY_ACCOUNT.get(input.account);
    if (fromAccount) {
      return publicLabel(fromAccount);
    }
  }
  return null;
}

export function evernodeCatalog(): readonly CatalogEntry[] {
  return EVERNODE;
}
