import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../../src/lib/employeeTransfer/sha256.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
});
const { Sha256 } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const reference = bytes => createHash('sha256').update(bytes).digest('hex');

test('SHA-256 standard known answers and repeatable digest', () => {
  for (const [message, expected] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ]) {
    const digest = new Sha256().update(Buffer.from(message));
    assert.equal(digest.digestHex(), expected);
    assert.equal(digest.digestHex(), expected);
    assert.throws(() => digest.update(new Uint8Array()), /finalized/);
  }
});

test('SHA-256 matches Node across padding boundaries, view offsets and arbitrary chunking', async t => {
  for (const length of [0, 1, 31, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65536, 1048583]) {
    await t.test(`${length} bytes`, () => {
      const backing = randomBytes(length + 18);
      const bytes = backing.subarray(9, 9 + length);
      const expected = reference(bytes);
      for (const chunkSize of [1, 17, 64, 4093, 1048576]) {
        const digest = new Sha256();
        for (let offset = 0; offset < length; offset += chunkSize) digest.update(bytes.subarray(offset, offset + chunkSize));
        assert.equal(digest.digestHex(), expected);
      }
    });
  }
});

test('SHA-256 consumes a reused buffer immediately and retains bounded working state', () => {
  const digest = new Sha256();
  const referenceDigest = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  for (let i = 0; i < 256; i++) {
    buffer.fill(i);
    digest.update(buffer);
    referenceDigest.update(buffer);
  }
  buffer.fill(0);
  assert.equal(digest.digestHex(), referenceDigest.digest('hex'));
});

test('SHA-256 million-a vector and independent instances', () => {
  const a = new Sha256();
  const b = new Sha256();
  const chunk = Buffer.alloc(1000, 97);
  for (let i = 0; i < 1000; i++) a.update(chunk);
  b.update(Buffer.from('other'));
  assert.equal(a.digestHex(), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  assert.equal(b.digestHex(), reference(Buffer.from('other')));
  assert.throws(() => new Sha256().update('invalid'), TypeError);
});
