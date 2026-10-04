import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractIconUrlFromMetadata, normalizeIconUrl, uriLooksLikeImage } from '../../src/util/icon.js';

describe('icon URLs', () => {
  it('keeps http(s) and ipfs links and rejects embedded bytes', () => {
    assert.equal(normalizeIconUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
    assert.equal(normalizeIconUrl('ipfs://bafyxxx/icon.webp'), 'ipfs://bafyxxx/icon.webp');
    assert.equal(normalizeIconUrl('data:image/png;base64,AAAA'), null);
    assert.equal(normalizeIconUrl('javascript:alert(1)'), null);
    assert.equal(normalizeIconUrl('https://user:pass@cdn.example/a.png'), null);
    assert.equal(uriLooksLikeImage('https://cdn.example/nft.webp?x=1'), true);
    assert.equal(uriLooksLikeImage('https://cdn.example/meta.json'), false);
  });

  it('extracts an image link from metadata JSON without keeping the document', () => {
    assert.equal(
      extractIconUrlFromMetadata({ name: 'NFT', image: 'https://cdn.example/nft.png' }),
      'https://cdn.example/nft.png',
    );
    assert.equal(
      extractIconUrlFromMetadata({ image: { url: 'ipfs://bafy/item.png' } }),
      'ipfs://bafy/item.png',
    );
    assert.equal(extractIconUrlFromMetadata({ image: 'data:image/png;base64,AAAA' }), null);
  });
});
