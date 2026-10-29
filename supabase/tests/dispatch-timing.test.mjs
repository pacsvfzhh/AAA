import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/dateUtils.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const { getServerDeadline } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

const SERVER_NOW = '2026-10-25T12:00:00.000Z';
const DUE_AT = '2026-10-25T12:01:30.000Z';
const SERVER_EPOCH = Date.parse(SERVER_NOW);

for (const skew of [-86_400_000, 86_400_000]) {
  test(`device clock skew of ${skew}ms does not change the server delay`, t => {
    const wallClock = t.mock.method(Date, 'now', () => SERVER_EPOCH + skew);
    t.mock.method(performance, 'now', () => 250.5);

    assert.equal(getServerDeadline(DUE_AT, SERVER_NOW), 90_250.5);
    assert.equal(wallClock.mock.callCount(), 0);
  });
}

test('uses the supplied receipt time without reading either device clock', t => {
  const wallClock = t.mock.method(Date, 'now', () => {
    throw new Error('Unexpected wall clock access');
  });
  const monotonicClock = t.mock.method(performance, 'now', () => {
    throw new Error('Unexpected receipt time access');
  });

  assert.equal(getServerDeadline(DUE_AT, SERVER_NOW, 12.5), 90_012.5);
  assert.equal(wallClock.mock.callCount(), 0);
  assert.equal(monotonicClock.mock.callCount(), 0);
});

test('large wall clock jumps during a countdown do not change its deadline', t => {
  let wallNow = SERVER_EPOCH;
  let monotonicNow = 1_000;
  const wallClock = t.mock.method(Date, 'now', () => wallNow);
  t.mock.method(performance, 'now', () => monotonicNow);
  const deadline = getServerDeadline(DUE_AT, SERVER_NOW);

  for (const [elapsed, jump] of [[1_000, 315_360_000_000], [30_000, -315_360_000_000], [90_000, 0]]) {
    wallNow = SERVER_EPOCH + elapsed + jump;
    monotonicNow = 1_000 + elapsed;
    const serverNow = new Date(SERVER_EPOCH + elapsed).toISOString();

    assert.equal(deadline - performance.now(), 90_000 - elapsed);
    assert.equal(getServerDeadline(DUE_AT, serverNow), deadline);
  }
  assert.equal(wallClock.mock.callCount(), 0);
});

test('server UTC offsets describe the same remaining duration', () => {
  for (const [dueAt, serverNow] of [
    [DUE_AT, SERVER_NOW],
    ['2026-10-25T20:01:30+08:00', SERVER_NOW],
    [DUE_AT, '2026-10-25T05:00:00-07:00'],
    ['2026-10-25T20:01:30+08:00', '2026-10-25T05:00:00-07:00'],
    ['2026-10-25T17:31:30+05:30', '2026-10-25T17:30:00+05:30'],
  ]) {
    assert.equal(getServerDeadline(dueAt, serverNow, 500), 90_500);
  }
});

for (const seconds of [1, 30, 47.125, 60, 90, 120, 150, 3000]) {
  test(`preserves an arbitrary server interval of ${seconds} seconds`, () => {
    const dueAt = new Date(SERVER_EPOCH + seconds * 1_000).toISOString();

    assert.equal(getServerDeadline(dueAt, SERVER_NOW, 250), 250 + seconds * 1_000);
  });
}

test('rereading a scheduled dispatch uses only its remaining server time', () => {
  const dueAt = '2026-10-25T12:02:30.000Z';
  const initialDeadline = getServerDeadline(dueAt, SERVER_NOW, 1_000);
  const rereadServerNow = '2026-10-25T12:01:40.000Z';
  const rereadDeadline = getServerDeadline(dueAt, rereadServerNow, 101_000);

  assert.equal(initialDeadline, 151_000);
  assert.equal(rereadDeadline, initialDeadline);
  assert.equal(rereadDeadline - 101_000, 50_000);
  assert.equal(getServerDeadline(dueAt, rereadServerNow, 25), 50_025);
});

test('expired and exactly due dispatches are immediately due', () => {
  for (const dueAt of ['2026-10-25T11:59:59.999Z', '2026-10-24T12:00:00.000Z', SERVER_NOW]) {
    assert.equal(getServerDeadline(dueAt, SERVER_NOW, 500.25), 500.25);
  }
});

test('rejects invalid due times and invalid server times', () => {
  const error = { name: 'Error', message: 'The dispatch server returned an invalid due time.' };
  for (const invalid of ['', 'not-a-date', '2026-99-99T00:00:00Z', 'Infinity', 'NaN', '+999999-01-01T00:00:00Z']) {
    assert.throws(() => getServerDeadline(invalid, SERVER_NOW, 500), error);
    assert.throws(() => getServerDeadline(DUE_AT, invalid, 500), error);
  }
  assert.throws(() => getServerDeadline('invalid', 'invalid', 500), error);
});
