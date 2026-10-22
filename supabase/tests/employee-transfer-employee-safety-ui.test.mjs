import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';

// Real SQL46/47 clients, paired reader and AES/ZIP; only RPC/fetch/IO are synthetic.
// No real database, Storage, native picker or full-employee recovery acceptance.
const root = fileURLToPath(new URL('../../', import.meta.url));
let playwright;
if (process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE) playwright = await import(pathToFileURL(process.env.EMPLOYEE_TRANSFER_PLAYWRIGHT_MODULE).href);
else {
  try { playwright = await import('playwright'); } catch { /* Optional runner; no package/lock changes. */ }
}
const id = n => `a8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NAME = 'Case-Sensitive-é-員工-CANARY';
const PASSWORD = 'local-admin-password-CANARY';
const PASS = 'independent-encryption-passphrase-CANARY';
const HASH = '$2a$local-account-hash-CANARY';
const STOP_TEXT = '確認停止員工備份任務';
const BEGIN = 'employee_safety_backup_begin', CATALOG = 'get_employee_safety_backup_catalog';
const PAGE = 'get_employee_safety_backup_page', VERIFY = 'employee_safety_backup_verify';
const CLOSE = 'employee_safety_backup_close', STOP = 'employee_safety_backup_stop_owned';
const MEDIA = 'get_employee_safety_backup_media', MEDIA_VERIFY = 'employee_safety_backup_media_verify';
const ORIGIN = 'https://employee-safety-ui-fixture.supabase.co', API_KEY = 'synthetic-ui-anon-key';
const desktopUA = 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36';

// Browser fixtures use the real table inventory so protocol changes cannot silently lose coverage.
function installHarness(api, constants) {
  const { keys, projections, Sha256, readBackup, readPair, entryPath, catalogPath, mediaPath, mediaCatalogPath } = api;
  const { NAME, PASSWORD, PASS, HASH, BEGIN, CATALOG, PAGE, VERIFY, CLOSE, STOP, STOP_TEXT, MEDIA, MEDIA_VERIFY, ORIGIN, API_KEY } = constants;
  const id = n => `a8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const sha = value => new Sha256().update(typeof value === 'string' ? enc.encode(value) : value).digestHex();
  const flags = { records_only: true, media_included: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
  const h = window.__h = {
    calls: [], events: [], forbidden: [], violations: [], workspaces: [], directories: [], reportAttempts: [], reports: [],
    fault: {}, siteCalls: [], waiting: null, release: null, serverRunning: false, signals: [], verifyCount: 0,
    reportSignals: [], reportSettlements: [], edgeCalls: [], mediaVerifyCount: 0, mediaInventoryCount: 0, pageCount: 0,
    mediaRefs: [], mediaBound: new Map(), mediaChecked: new Set(), edgeSignals: [], rechecks: 0,
    keys: [...keys], projectionFields: Object.keys(projections.accounts), flags,
  };
  const check = (ok, reason) => { if (!ok) { h.violations.push(reason); throw Error(reason); } };
  const alive = signal => signal?.throwIfAborted();
  const join = pieces => {
    const result = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) { result.set(piece, offset); offset += piece.length; }
    return result;
  };
  // Exactly the 14 required account fields, including SQL-null-compatible values.
  const values = { id: id(3), username: NAME, password_hash: HASH, employee_id: 'LOCAL-ACCOUNT-CANARY',
    is_verified: false, is_active: true, total_income: 12.5, first_success_order_date: null,
    created_by: id(6), remarks: 'raw-record-CANARY\n原文', created_at: '2026-10-21T00:00:00.123456+00:00',
    updated_at: null, tags: ['原文', null], is_pinned: false };
  check(keys.length === 48 && new Set(keys).size === 48, '48 real table keys required');
  check(h.projectionFields.length === 14, 'account projection changed; update the minimal fixture explicitly');
  check(Object.keys(values).every(key => h.projectionFields.includes(key)), 'unexpected account fields');
  h.account = Object.fromEntries(h.projectionFields.map(key => { check(Object.hasOwn(values, key), 'missing account field'); return [key, values[key]]; }));
  h.texts = Object.fromEntries(keys.map(key => [key, key === 'accounts' ? JSON.stringify(h.account) + '\n' : '']));
  h.refreshCatalog = () => {
    h.catalog = { version: 1, protocol: 'employee-safety-records-v1', scope: 'employee-safety-records', job_id: id(2), site_id: id(1), employee_id: id(3), username: NAME,
      tables: keys.map(key => { const lines = h.texts[key].match(/[^\n]*\n/g) ?? []; return {
        key, rows: lines.length, bytes: enc.encode(h.texts[key]).length, row_hashes_sha256: sha(lines.map(sha).join('')),
      }; }), fingerprint: 'b'.repeat(64), ...flags };
  };
  h.refreshCatalog();
  const mediaFlags = { complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
  h.mediaBytes = Uint8Array.of(255, 216, 255, 0, 1, 2);
  h.addAttachment = () => {
    check(!h.calls.length, 'fixture must precede task');
    const path = `id-front/${id(3)}-PRIVATE-document-CANARY.jpg`, bucket = 'verification-documents';
    const original = `${ORIGIN}/storage/v1/object/public/${bucket}/${path}`;
    const row = { id: id(7), user_id: id(3), real_name: 'PRIVATE-real-name-CANARY', wallet_address: 'PRIVATE-document-number-CANARY',
      phone: 'PRIVATE-phone-CANARY', email: 'PRIVATE-address-CANARY', status: 'pending', audit_remark: null, audited_by: null,
      audited_at: null, created_at: '2026-10-21T00:00:00.123456+00:00', updated_at: null, id_front_url: original, id_back_url: null, selfie_url: null };
    check(JSON.stringify(Object.keys(row).sort()) === JSON.stringify(Object.keys(projections.verification_requests).sort()), 'real verification projection required');
    // Preserve exact line bytes, not JSON reserialization, for row/ref SHA binding.
    h.texts.verification_requests = JSON.stringify(row).replace('"id":', '"\\u0069d":') + ' \r\n';
    h.refreshCatalog();
    const source_url = `employee-safety-media-v1:${id(1)}:${id(2)}:${id(3)}:${h.catalog.fingerprint}:${sha(h.texts.verification_requests)}:${sha(`verification_requests:${row.id}:id_front_url:${original}`)}:${sha(bucket + '/' + path)}`;
    h.mediaRefs = [{ key: sha(source_url), source_url, bucket, path, kind: 'verification', avatar: false, file: null }];
  };
  h.mediaInventory = () => ({ version: 1, scope: 'employee-safety-media', records_catalog: structuredClone(h.catalog),
    files: h.mediaRefs.map(ref => ({ ...ref, file: h.mediaBound.get(ref.key) ?? null })),
    verified: h.mediaRefs.every(ref => h.mediaChecked.has(ref.key)), ...mediaFlags });
  const gate = (name, signal) => new Promise((resolve, reject) => {
    h.waiting = name;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort); h.waiting = null; h.release = null;
      if (error) reject(error); else resolve();
    };
    const abort = () => { h.events.push('gate-aborted:' + name); finish(new DOMException('isolated abort', 'AbortError')); };
    h.release = () => finish();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  h.rpc = (name, args) => {
    let signal, pending;
    const query = {
      abortSignal(value) { signal = value; h.signals.push(value); return query; },
      then(resolve, reject) {
        pending ??= Promise.resolve().then(async () => {
          check([BEGIN, CATALOG, PAGE, VERIFY, CLOSE, STOP, MEDIA, MEDIA_VERIFY].includes(name), 'unexpected RPC: ' + name);
          check(args.p_admin_session_token === id(5), 'admin session not forwarded');
          const fields = name === BEGIN ? ['p_admin_session_token', 'p_admin_password', 'p_username']
            : name === STOP ? ['p_admin_session_token', 'p_admin_password', 'p_confirmation', 'p_job_id']
              : name === CATALOG ? ['p_admin_session_token', 'p_job_token']
                : name === PAGE ? ['p_admin_session_token', 'p_job_token', 'p_catalog_fingerprint', 'p_table_key', 'p_after', 'p_limit']
                  : ['p_admin_session_token', 'p_job_token', 'p_catalog_fingerprint'];
          check(JSON.stringify(Object.keys(args).sort()) === JSON.stringify(fields.sort()), 'RPC argument shape: ' + name);
          h.calls.push({ name, args: structuredClone(args) }); h.events.push(name); alive(signal);
          if (h.fault.holdRpc === name) { h.fault.holdRpc = null; await gate(name, signal); }
          alive(signal);
          if (name === STOP) {
            check(args.p_admin_password === PASSWORD && args.p_confirmation === STOP_TEXT, 'stop requires fresh exact credentials');
            check(args.p_job_id === null || args.p_job_id === id(2), 'wrong stop job');
            if (h.fault.stopFail) throw Error(PASSWORD + PASS + NAME + id(4));
            const cancelled = h.serverRunning; h.serverRunning = false;
            return { data: { success: true, cancelled, job_id: cancelled ? id(2) : null, scope: 'employee-safety-records', full_site_complete: false }, error: null };
          }
          if (name === BEGIN) {
            check(args.p_username === NAME && args.p_admin_password === PASSWORD, 'begin credentials/name must remain exact');
            if (h.fault.begin === 'unavailable') return { data: null, error: { message: PASSWORD + PASS + NAME, code: 'PGRST202' } };
            h.serverRunning = true;
            if (h.fault.begin === 'lost') throw Error(PASSWORD + PASS + NAME + id(4));
            return { data: { success: true, job_id: id(2), job_token: id(4), site_id: id(1), catalog: structuredClone(h.catalog), scope: 'employee-safety-records', full_site_complete: false }, error: null };
          }
          check(args.p_job_token === id(4), 'job token not forwarded');
          if (name === CATALOG) return { data: structuredClone(h.catalog), error: null };
          check(args.p_catalog_fingerprint === h.catalog.fingerprint, 'catalog fingerprint not forwarded');
          if (name === PAGE) {
            if (++h.pageCount === h.fault.holdPageAt) await gate('record-page:' + h.pageCount, signal);
            check(keys.includes(args.p_table_key) && args.p_after === null && args.p_limit === 200, 'wrong page request');
            if (h.fault.page === 'lost') throw Error(PASSWORD + NAME);
            const ndjson = h.texts[args.p_table_key];
            return { data: { table_key: args.p_table_key, count: ndjson ? 1 : 0, bytes: enc.encode(ndjson).length,
              ndjson, next_after: null, sha256: h.fault.page === 'corrupt' ? 'f'.repeat(64) : sha(ndjson), fingerprint: h.catalog.fingerprint }, error: null };
          }
          if ([MEDIA, MEDIA_VERIFY].includes(name)) {
            if (name === MEDIA) h.mediaInventoryCount++; else h.mediaVerifyCount++;
            if (h.fault.mediaMissing === name) return { data: null, error: { code: 'PGRST202', message: PASSWORD + PASS + NAME } };
            if (name === MEDIA_VERIFY && h.fault.mediaVerifyFailAt === h.mediaVerifyCount) return { data: null, error: { message: PASSWORD + PASS } };
            if (name === MEDIA_VERIFY && h.fault.holdMediaVerifyAt === h.mediaVerifyCount) await gate('final-media-verify', signal);
            const inventory = h.mediaInventory();
            if (h.fault.omitMediaRef) inventory.files = [];
            if (h.fault.forgeMediaRef) {
              const ref = inventory.files[0], parts = ref.source_url.split(':');
              parts[h.fault.forgeMediaRef === 'row' ? 5 : 6] = 'e'.repeat(64);
              ref.source_url = parts.join(':'); ref.key = sha(ref.source_url);
            }
            return { data: inventory, error: null };
          }
          if (name === VERIFY) {
            h.verifyCount++;
            return { data: { verified: true, fingerprint: h.fault.driftAt === h.verifyCount ? 'c'.repeat(64) : h.catalog.fingerprint, ...flags }, error: null };
          }
          if (name === CLOSE) {
            check(h.workspaces.length >= 7 && h.workspaces.every(w => w.cleaned && w.cleanups === 1 && !w.cleanupFailed), 'close before ALL plaintext cleanup');
            const files = h.directories.at(-1).files;
            check(files.length === 2 && files.every(f => f.writes === 1), 'close before two independent encrypted saves');
            check(files[0].eof === 3 && files[1].eof === 2, 'close before both ciphertext EOFs and paired full readback');
            check(h.workspaces.at(-2).opened.includes(entryPath('accounts')) && h.workspaces.at(-1).opened.includes(mediaCatalogPath), 'close before pair validation');
            check(h.verifyCount >= 3 && h.mediaVerifyCount >= 3 && h.rechecks === h.mediaRefs.length * 3, 'close before FINAL record/media source checks');
            h.serverRunning = false;
            if (h.fault.closeLost) throw Error(PASSWORD + PASS + id(4));
            return { data: { success: true, scope: 'employee-safety-records', full_site_complete: false }, error: null };
          }
        });
        return pending.then(resolve, reject);
      },
    };
    return query;
  };
  // The real source captures this controlled transport. Never delegate to native fetch.
  window.fetch = async (url, init) => {
    const headers = new Headers(init?.headers), action = headers.get('x-transfer-action');
    check(url === ORIGIN + '/functions/v1/employee-transfer-media', 'unexpected media endpoint');
    check(init.method === 'POST' && init.redirect === 'error' && init.credentials === 'omit' && init.cache === 'no-store' && init.body === undefined, 'unsafe Edge request');
    check(headers.get('apikey') === API_KEY && headers.get('content-type') === 'application/octet-stream'
      && headers.get('x-transfer-scope') === 'employee-safety' && headers.get('x-admin-session-token') === id(5)
      && headers.get('x-transfer-job-token') === id(4) && !headers.has('authorization'), 'wrong Edge auth/scope');
    check(JSON.stringify([...headers.keys()].sort()) === JSON.stringify(['apikey', 'content-type', 'x-transfer-action', 'x-transfer-job-token', 'x-transfer-object-key', 'x-transfer-scope', 'x-admin-session-token'].sort()), 'unexpected Edge headers');
    const ref = h.mediaRefs.find(ref => ref.key === headers.get('x-transfer-object-key'));
    check(Boolean(ref) && ['download', 'recheck-export'].includes(action), 'unexpected Edge action/object');
    check(h.serverRunning, 'media request after task close');
    h.edgeCalls.push({ url, action, key: ref.key }); h.events.push('edge-' + action); h.edgeSignals.push(init.signal); alive(init.signal);
    if (h.fault.holdEdge === action) { h.fault.holdEdge = null; await gate('edge-' + action, init.signal); }
    alive(init.signal);
    const file = { key: ref.key, source_url: ref.source_url, bytes: h.mediaBytes.length, sha256: sha(h.mediaBytes), content_type: 'image/jpeg' };
    if (action === 'download') {
      h.mediaBound.set(ref.key, file); // A lost response may have committed its technical receipt.
      if (h.fault.downloadLost) throw Error(PASSWORD + PASS + ref.source_url);
      return new Response(h.mediaBytes.slice(), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes),
        'x-transfer-sha256': file.sha256, 'x-transfer-content-type': file.content_type } });
    }
    h.rechecks++;
    check(h.mediaBound.has(ref.key), 'recheck before download receipt');
    h.mediaChecked.add(ref.key);
    const receipt = { success: true, key: file.key, bytes: file.bytes, sha256: h.fault.mediaDriftAt === h.rechecks ? 'f'.repeat(64) : file.sha256, content_type: file.content_type, ...mediaFlags };
    const text = JSON.stringify(receipt);
    return new Response(text, { headers: { 'content-type': 'application/json', 'content-length': String(enc.encode(text).length) } });
  };
  h.createWorkspace = () => {
    const data = new Map(), frozen = new Set();
    const w = { cleaned: false, cleanups: 0, appended: [], opened: [],
      async append(path, bytes, signal) {
        alive(signal); check(!w.cleaned && !frozen.has(path), 'append to invalidated/frozen workspace');
        check(path === catalogPath || path === mediaCatalogPath || keys.some(key => path === entryPath(key)) || h.mediaRefs.some(ref => path === mediaPath(ref)), 'unexpected workspace path');
        check(bytes instanceof Uint8Array, 'non-byte workspace append');
        w.appended.push(path); data.set(path, [...(data.get(path) ?? []), new Uint8Array(bytes)]);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        check(!w.cleaned && data.has(path), 'read absent/cleaned workspace'); frozen.add(path); w.opened.push(path);
        const bytes = join(data.get(path));
        for (let offset = 0; offset < bytes.length; offset += 257) { check(!w.cleaned, 'late plaintext read'); yield bytes.slice(offset, offset + 257); }
      } }; },
      async abort() {
        w.cleanups++;
        const index = h.workspaces.indexOf(w);
        if (h.fault.cleanupAt === index) { w.cleanupFailed = true; h.events.push('cleanup-failed:' + index); throw Error(PASSWORD + PASS); }
        w.cleaned = true; data.clear(); h.events.push('cleanup:' + index);
      },
    };
    h.workspaces.push(w); return w;
  };
  h.pickDirectory = async () => {
    h.events.push('synthetic-picker');
    if (h.fault.pickerDenied) throw new DOMException('synthetic picker denied', 'NotAllowedError');
    const directory = { name: 'isolated-employee-records-' + (h.directories.length + 1), files: [],
      createFile(name) {
        check(!directory.files.some(f => f.name === name), 'output overwrite');
        const kind = name.startsWith('employee-attachments-') ? 'media' : 'records';
        const f = { name, kind, bytes: new Uint8Array(), writes: 0, opens: 0, eof: 0, readBytes: 0, reads: [] };
        directory.files.push(f);
        return {
          async write(source, signal) {
            check(++f.writes === 1, 'duplicate encrypted write'); h.events.push('cipher-write'); h.events.push(kind + '-write');
            const pieces = [];
            for await (const bytes of source) { alive(signal); pieces.push(new Uint8Array(bytes)); }
            f.bytes = join(pieces); h.events.push('cipher-saved'); h.events.push(kind + '-saved');
            if (h.fault.holdCipherSave === kind) { h.fault.holdCipherSave = null; await gate('cipher-save:' + kind, signal); }
            if (h.fault.corruptFile || h.fault.corruptSaved === kind) f.bytes[f.bytes.length - 1] ^= 1;
            if (h.fault.saveLost === kind) throw Error(PASSWORD + PASS);
          },
          open() {
            const number = ++f.opens, read = { number, bytes: 0, eof: false };
            f.reads.push(read); h.events.push('cipher-open'); h.events.push(kind + '-open:' + number);
            return { async *[Symbol.asyncIterator]() {
              if (h.fault.holdPairRead === kind && number === (kind === 'records' ? 5 : 4)) {
                h.fault.holdPairRead = null;
                // Signal-less IO must not block cancellation or allow a late close.
                await gate('pair-read:' + kind);
              }
              for (let offset = 0; offset < f.bytes.length; offset += 113) {
                const bytes = f.bytes.slice(offset, offset + 113);
                // Only the full second (paired) read is altered, not the metadata probe.
                if (h.fault.corruptPair === kind && number === (kind === 'records' ? 5 : 4) && offset + bytes.length === f.bytes.length) bytes[bytes.length - 1] ^= 1;
                f.readBytes += bytes.length; read.bytes += bytes.length; yield bytes;
              }
              f.eof++; read.eof = true; h.events.push('cipher-eof'); h.events.push(kind + '-eof:' + number);
            } };
          },
        };
      },
      async writeText(name, text, signal) {
        // Record invocation before checking abort so a NEW post-unmount write is detectable.
        h.events.push('report-attempt'); h.reportAttempts.push({ name, text, directory: directory.name });
        check(signal instanceof AbortSignal, 'report write requires its own AbortSignal');
        h.reportSignals.push(signal);
        let saved = false;
        try {
          alive(signal);
          if (h.fault.holdReport) { h.fault.holdReport = false; await gate('report-write', signal); }
          alive(signal);
          if (h.fault.reportFail) throw Error('synthetic report storage failure');
          h.reports.push({ name, text, directory: directory.name }); h.events.push('report-saved'); saved = true;
        } finally {
          h.reportSettlements.push({ aborted: signal.aborted, saved }); h.events.push('report-settled');
        }
      },
    };
    h.directories.push(directory); return directory;
  };
  const savedFile = f => ({ open: () => ({ async *[Symbol.asyncIterator]() {
    for (let offset = 0; offset < f.bytes.length; offset += 137) yield f.bytes.slice(offset, offset + 137);
  } }) });
  h.readSavedPair = async () => {
    const files = h.directories.at(-1).files;
    return readPair(savedFile(files[0]), savedFile(files[1]), PASS, h.createWorkspace, async reader => {
      const media = {};
      for (const ref of reader.inventory.files) {
        const pieces = []; for await (const raw of reader.open(mediaPath(ref))) pieces.push(raw);
        media[ref.key] = Array.from(join(pieces));
      }
      return { inventory: reader.inventory, manifest: reader.manifest, media,
        flags: { completeEmployeeBackup: reader.completeEmployeeBackup, canArchive: reader.canArchive, canReplace: reader.canReplace, fullSiteComplete: reader.fullSiteComplete } };
    });
  };
  h.readSaved = async () => {
    const f = h.directories.flatMap(d => d.files)[0];
    check(Boolean(f), 'missing saved ciphertext');
    const file = savedFile(f);
    return readBackup(file, PASS, h.createWorkspace, async reader => {
      const texts = {};
      for (const key of keys) { const pieces = []; for await (const raw of reader.open(entryPath(key))) pieces.push(raw); texts[key] = dec.decode(join(pieces)); }
      return { catalog: reader.catalog, manifest: reader.manifest, texts };
    });
  };
}

const boundaries = `
const h=()=>window.__h;
export const getAdminFinancialSessionToken=()=> 'a8000000-0000-4000-8000-000000000005';
export const supabase={rpc:(...args)=>h().rpc(...args)};
export const SITE_DOMAINS=['shared','products','dispatch','identity','finance','activity','verification','notifications','chat','archives'];
export const getSiteTransferCapabilities=async()=>({version:1,site_id:'a8000000-0000-4000-8000-000000000001',can_export:true,can_import:false,missing_rpcs:[],import_blockers:[],export_protocol:'local'});
export const getSiteTransferHistory=async()=>{h().siteCalls.push('history');return []};
const forbidden=name=>{h().forbidden.push(name);throw Error('forbidden site write')};
export const exportSiteBundleSet=async()=>forbidden('site-export');
export const stopSiteExportTask=async()=>forbidden('site-stop');
export const importSiteBundleSetToMaintenance=async()=>forbidden('site-import');
export const inspectSiteBundleSet=async()=>{h().siteCalls.push('inspect');return {packageId:'a8000000-0000-4000-8000-000000000008',sourceSiteId:'a8000000-0000-4000-8000-000000000009',volumes:[],fullSiteComplete:false,importReady:false}};
export const getSiteImportPreflight=async source=>{h().siteCalls.push('preflight');return {version:1,protocol:'site-maintenance-restore-v2',site_id:'a8000000-0000-4000-8000-000000000001',source_site_id:source,can_restore_to_maintenance:true,blockers:[],missing_rpcs:[],full_site_complete:false,can_release:false}};
export const getSourceCutoverStatus=async()=>({version:1,success:true,scope:'source-cutover',site_id:'a8000000-0000-4000-8000-000000000001',frozen:false,cutoff:null,blockers:[],counts:{pending_automation:0,failed_automation:0,processing_orders:0},full_site_complete:false});
export const freezeSourceCutover=async()=>forbidden('source-freeze');
export const resumeSourceCutover=async()=>forbidden('source-resume');
export const createBrowserWorkspaceFactory=async()=>h().createWorkspace;
export const pickTransferDirectory=()=>h().pickDirectory();
`;
let server, base, script, css;
before(async () => {
  if (!playwright) return;
  const compiled = await build({
    stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
      import Page from './src/components/admin/EmployeeDataMigration.tsx';
      import{EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS as keys,EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH as catalogPath,employeeSafetyBackupEntryPath as entryPath,withAuthenticatedEmployeeSafetyBackup as readBackup}from'./src/lib/employeeTransfer/employeeSafetyBackup.ts';
      import{withAuthenticatedEmployeeSafetyMediaBackup as readPair,employeeSafetyMediaEntryPath as mediaPath,EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH as mediaCatalogPath}from'./src/lib/employeeTransfer/employeeSafetyMedia.ts';
      import{EMPLOYEE_BACKUP_PROJECTIONS as projections}from'./src/lib/employeeTransfer/employeeBackup.ts';
      import{Sha256}from'./src/lib/employeeTransfer/sha256.ts';
      (${installHarness.toString()})({keys,projections,Sha256,readBackup,readPair,entryPath,catalogPath,mediaPath,mediaCatalogPath},${JSON.stringify({ NAME, PASSWORD, PASS, HASH, BEGIN, CATALOG, PAGE, VERIFY, CLOSE, STOP, STOP_TEXT, MEDIA, MEDIA_VERIFY, ORIGIN, API_KEY })});
      const r=createRoot(document.getElementById('root'));window.__unmount=()=>r.unmount();r.render(<Page/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(API_KEY) },
    plugins: [{ name: 'isolated-safety-ui-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(?:\.\.\/(?:auth|supabase)|.*employeeTransfer\/(?:siteTransfer|siteImport|browserStorage|sourceCutover))$/ }, () => ({ path: 'boundaries', namespace: 'synthetic' }));
      builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: boundaries }));
    } }],
  });
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const file of ['EmployeeDataMigration.tsx', 'EmployeeSafetyBackupPanel.tsx', 'EmployeeSiteImport.tsx', 'employeeSafetyBackup.ts', 'employeeSafetyMedia.ts', 'employeeBackup.ts', 'crypto.ts', 'container.ts', 'manifest.ts']) {
    assert.ok(inputs.some(path => path.endsWith('/' + file)), 'must bundle real ' + file);
  }
  assert.ok(!inputs.some(path => /node_modules\/@supabase|src\/lib\/(?:auth|supabase)\.ts|employeeTransfer\/(?:siteTransfer|siteImport|browserStorage)\.ts/.test(path)), 'production access/storage boundaries must not enter bundle');
  script = compiled.outputFiles[0].text;
  // Current styles prevent stale dist output from hiding layout or checkbox regressions.
  const cssSource = await readFile(new URL('../../src/index.css', import.meta.url), 'utf8');
  const componentSources = await Promise.all(['EmployeeDataMigration', 'EmployeeSafetyBackupPanel', 'EmployeeSiteImport'].map(name => readFile(new URL(`../../src/components/admin/${name}.tsx`, import.meta.url), 'utf8')));
  const tailwindConfig = loadTailwindConfig(root + 'tailwind.config.js');
  css = (await postcss([tailwindcss({ ...tailwindConfig, content: componentSources.map(raw => ({ raw, extension: 'tsx' })) })]).process(cssSource, { from: undefined })).css;
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0;background:#0f172a"><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function scenario(browser, run, { unsupported = false, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(!unsupported ? { userAgent: desktopUA } : {}) });
  const foreign = [], errors = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    foreign.push(route.request().url()); return route.abort('blockedbyclient');
  });
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => { foreign.push(socket.url()); socket.close(); });
  await context.addInitScript(({ unsupported }) => {
    if (unsupported) {
      Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
      return;
    }
    // Capability shims ONLY. No native picker or OPFS is exercised by this suite.
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => { throw Error('adapter expected'); } });
    if (!navigator.storage) Object.defineProperty(navigator, 'storage', { configurable: true, value: {} });
    Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: async () => { throw Error('adapter expected'); } });
  }, { unsupported });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base + '/');
    await page.getByText('後端回報可導出；僅代表階段能力，不是整站遷移許可。', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '導入', exact: true }).click();
    await run(page);
    assert.deepEqual(await page.evaluate(() => window.__h.forbidden), [], 'no unrelated site export/import/stop');
    assert.deepEqual(await page.evaluate(() => window.__h.violations), [], 'synthetic adapter contract');
    assert.deepEqual(foreign, [], 'zero external requests (all external URLs are blocked)');
    assert.deepEqual(errors, [], 'zero uncaught browser errors');
  } finally { await context.close(); }
}
const panel = page => page.getByRole('region', { name: '獨立員工記錄與附件備份', exact: true });
const start = page => panel(page).getByRole('button', { name: '開始獨立員工記錄與附件備份', exact: true });
const stop = page => panel(page).getByRole('button', { name: '確認停止本人的員工備份任務', exact: true });
const cancelReport = page => panel(page).getByRole('button', { name: '停止等待報告保存', exact: true });
const reset = page => panel(page).getByRole('button', { name: '核對原檔案後，準備另一份新備份', exact: true });
const importStart = page => page.getByRole('button', { name: '開始實際導入（保持維護）', exact: true });
const ack = page => panel(page).getByRole('checkbox', { name: /^我已核對新站/ });
const rpcCalls = page => page.evaluate(() => window.__h.calls);
const fault = (page, value) => page.evaluate(value => Object.assign(window.__h.fault, value), value);
async function prepare(page) {
  await page.locator('#employee-safety-username').fill(NAME);
  await page.locator('#employee-safety-password').fill(PASSWORD);
  await page.locator('#employee-safety-passphrase').fill(PASS);
  await page.locator('#employee-safety-confirmation').fill(PASS);
  await panel(page).getByRole('button', { name: '選擇員工備份保存目錄', exact: true }).click();
  await ack(page).check();
  assert.equal(await start(page).isEnabled(), true);
}
async function finished(page, reportFailed = false) {
  await panel(page).getByText(reportFailed ? /^結果報告保存失敗/ : /^白名單結果報告已保存/).waitFor();
  await page.waitForFunction(() => !document.getElementById('employee-safety-stop-password').matches(':disabled'));
}
async function report(page) {
  const attempt = await page.evaluate(() => window.__h.reportAttempts.at(-1));
  assert.equal(attempt.name, 'employee-backup-report.json');
  return JSON.parse(attempt.text);
}
async function heldReport(page) {
  await page.waitForFunction(() => window.__h.waiting === 'report-write');
  await panel(page).getByText('正在保存結果報告（不改變備份或任務結果）', { exact: true }).waitFor();
  assert.equal(await cancelReport(page).isEnabled(), true);
  assert.equal(await page.locator('#employee-safety-stop-password').isDisabled(), true, 'reporting still holds local busy');
  assert.equal(await page.evaluate(() => window.__h.reportSignals.length), 1);
  assert.equal(await page.evaluate(() => window.__h.reportSignals[0].aborted), false);
  assert.ok(await page.evaluate(() => window.__h.signals.every(signal => signal !== window.__h.reportSignals[0])), 'report controller is independent of backup RPC controllers');
  await page.evaluate(() => { window.__h.lateReportRelease = window.__h.release; });
}
async function cancelHeldReport(page) {
  await cancelReport(page).click({ timeout: 2000 });
  await page.waitForFunction(() => !document.getElementById('employee-safety-stop-password').matches(':disabled'), null, { timeout: 2000 });
  await panel(page).getByText(/^結果報告保存失敗或已停止等待/).waitFor({ timeout: 2000 });
  assert.equal(await cancelReport(page).count(), 0);
  assert.equal(await page.evaluate(() => window.__h.reportSignals[0].aborted), true);
  assert.deepEqual(await page.evaluate(() => window.__h.reportSettlements), [{ aborted: true, saved: false }]);
  // A late completion of the synthetic picker/workspace adapter must not save a report.
  await page.evaluate(() => window.__h.lateReportRelease());
  assert.equal(await page.evaluate(() => window.__h.reports.length), 0);
  assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 1);
}
function safeReport(value) {
  const raw = JSON.stringify(value);
  for (const canary of [NAME, PASSWORD, PASS, HASH, id(4), id(5), 'LOCAL-ACCOUNT-CANARY', 'raw-record-CANARY']) assert.equal(raw.includes(canary), false, 'report must not contain ' + canary);
  for (const canary of ['PRIVATE-real-name', 'PRIVATE-document', 'PRIVATE-phone', 'PRIVATE-address', ORIGIN, 'employee-safety-media-v1:']) assert.equal(raw.includes(canary), false, 'no raw attachment identity/PII');
  assert.equal(value.version, 2); assert.equal(value.protocol, 'employee-safety-pair-v1');
  assert.equal(value.recordsOnly, false); assert.equal(typeof value.pairVerified, 'boolean');
  assert.equal(value.mediaIncluded, value.pairVerified);
  for (const flag of ['completeEmployeeBackup', 'canArchive', 'canReplace', 'fullSiteComplete', 'rollbackConfirmed']) assert.equal(value[flag], false, flag);
  for (const key of ['encryptedFileState', 'mediaEncryptedFileState']) assert.ok(['not-written', 'unknown', 'saved', 'verified'].includes(value[key]), key);
  assert.match(value.startedAtUTC, /Z$/); assert.match(value.finishedAtUTC, /Z$/);
  assert.deepEqual(Object.keys(value).sort(), ['version', 'protocol', 'startedAtUTC', 'finishedAtUTC', 'status', 'jobId', 'receipt', 'mediaReceipt', 'lastProgress', 'encryptedFileState', 'mediaEncryptedFileState', 'pairVerified', 'temporaryPlaintextCleanupUnconfirmed', 'taskCloseConfirmed', 'recordsOnly', 'mediaIncluded', 'completeEmployeeBackup', 'canArchive', 'canReplace', 'fullSiteComplete', 'rollbackConfirmed'].sort());
  assert.deepEqual(Object.keys(value.lastProgress).sort(), ['stage', 'phase', 'rows', 'files', 'bytes'].sort());
  if (value.receipt) assert.deepEqual(Object.keys(value.receipt).sort(), ['backupId', 'siteId', 'jobId', 'filename', 'fingerprint', 'cipherSha256', 'cipherBytes', 'rows', 'tables'].sort());
  if (value.mediaReceipt) assert.deepEqual(Object.keys(value.mediaReceipt).sort(), ['filename', 'cipherSha256', 'cipherBytes', 'files'].sort());
}
async function noRecovery(page, begins = 1, closes = 0, stops = 0) {
  // Deliberate quiescence window catches effect/timer-triggered retries of ANY RPC or Edge action.
  const before = await page.evaluate(() => ({ rpc: window.__h.calls.length, edge: window.__h.edgeCalls.length }));
  await page.waitForTimeout(120);
  assert.deepEqual(await page.evaluate(() => ({ rpc: window.__h.calls.length, edge: window.__h.edgeCalls.length })), before, 'no automatic RPC/Edge retries');
  const calls = await rpcCalls(page);
  assert.equal(calls.filter(c => c.name === BEGIN).length, begins);
  assert.equal(calls.filter(c => c.name === CLOSE).length, closes);
  assert.equal(calls.filter(c => c.name === STOP).length, stops);
  const text = await page.locator('body').innerText();
  for (const canary of [PASSWORD, PASS, HASH, id(4)]) assert.equal(text.includes(canary), false, 'no raw error/secret rendered');
}
async function openStop(page) { await panel(page).locator('summary').click(); }
async function fillStop(page, confirmation = STOP_TEXT) {
  await page.locator('#employee-safety-stop-password').fill(PASSWORD);
  await page.locator('#employee-safety-stop-confirmation').fill(confirmation);
}
async function prepareParent(page) {
  await page.locator('#migration-files').setInputFiles(Array.from({ length: 11 }, (_, i) => ({ name: `synthetic-${i}.edx`, mimeType: 'application/octet-stream', buffer: Buffer.from('parent inspection adapter only') })));
  await page.locator('#migration-inspect-passphrase').fill(PASS);
  await page.getByRole('button', { name: '僅解密與核驗，不導入', exact: true }).click();
  await page.getByText('輸入檔案各卷解密核驗結果', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查詢目標准入（只讀）', exact: true }).click();
  await page.locator('#migration-import-passphrase').fill(PASS);
  await page.locator('#migration-import-password').fill(PASSWORD);
  await page.getByRole('button', { name: '選擇獨立備份保存目錄', exact: true }).click();
  await page.locator('#migration-import-confirmation').fill('確認導入員工資料');
  await page.getByRole('checkbox', { name: /^我確認這是隔離/ }).check();
  assert.equal(await importStart(page).isEnabled(), true, 'real import form was actionable before backup');
  // Parent inspection deliberately clears export credentials; arm export AFTER it.
  await page.getByRole('tab', { name: '導出', exact: true }).click();
  await page.locator('#migration-admin-password').fill(PASSWORD);
  await page.locator('#migration-passphrase').fill(PASS);
  await page.locator('#migration-confirmation').fill(PASS);
  await page.getByRole('button', { name: '選擇保存目錄', exact: true }).click();
  await page.getByRole('checkbox', { name: /^我了解這是本地驗證版/ }).check();
  assert.equal(await page.locator('#migration-panel-export').getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true }).isEnabled(), true);
  await page.getByRole('tab', { name: '導入', exact: true }).click();
}
async function parentLocked(page) {
  assert.equal(await importStart(page).isDisabled(), true);
  for (const selector of ['#migration-files', '#migration-inspect-passphrase', '#migration-import-password', '#migration-admin-password', '#migration-passphrase']) assert.equal(await page.locator(selector).isDisabled(), true, selector);
  assert.equal(await page.locator('#migration-panel-export').getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '重新檢查能力', exact: true }).isDisabled(), true);
}

for (const engine of ['chromium', 'webkit']) {
  test(`isolated ${engine} employee safety UI: real SQL46/47 clients/paired AES/ZIP, synthetic RPC/Edge/picker/workspace`, { skip: !playwright, timeout: 600000 }, async t => {
    // Cached browsers avoid installing binaries in the repository.
    const executablePath = process.env[`EMPLOYEE_TRANSFER_${engine.toUpperCase()}_EXECUTABLE`];
    const browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      await t.test('actual attachment: 48 pages -> records -> SQL47 download/media AES/ZIP -> paired readback -> final source -> explicit close', () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment());
        await prepare(page); await fault(page, { holdRpc: CLOSE }); await start(page).click();
        await page.waitForFunction(name => window.__h.waiting === name, CLOSE);
        await panel(page).getByText('來源複核或任務結束尚未確認', { exact: true }).waitFor();
        const beforeClose = await page.evaluate(() => ({ calls: window.__h.calls, events: window.__h.events, reports: window.__h.reports,
          keys: window.__h.keys, spaces: window.__h.workspaces.map(w => ({ cleaned: w.cleaned, cleanups: w.cleanups, opened: w.opened })),
          files: window.__h.directories[0].files.map(f => ({ ...f, bytes: f.bytes.length })) }));
        assert.deepEqual(beforeClose.calls.map(c => c.name), [BEGIN, CATALOG, ...Array(48).fill(PAGE), VERIFY, VERIFY,
          MEDIA, MEDIA, MEDIA, MEDIA_VERIFY, MEDIA, MEDIA_VERIFY, MEDIA, MEDIA_VERIFY, VERIFY, CLOSE]);
        assert.deepEqual(beforeClose.calls.filter(c => c.name === PAGE).map(c => c.args.p_table_key), beforeClose.keys);
        const [records, media] = beforeClose.files;
        assert.equal(records.writes, 1); assert.equal(records.opens, 5); assert.equal(records.eof, 3);
        assert.equal(media.writes, 1); assert.equal(media.opens, 4); assert.equal(media.eof, 2);
        for (const file of [records, media]) for (const read of file.reads.filter(read => read.eof)) assert.equal(read.bytes, file.bytes, 'each authenticated read reaches full EOF');
        assert.ok(records.readBytes >= records.bytes * 3 && media.readBytes >= media.bytes * 2);
        assert.equal(beforeClose.reports.length, 0, 'no completed report before explicit close response');
        assert.ok(beforeClose.spaces.every(w => w.cleaned && w.cleanups === 1));
        assert.equal(new Set(beforeClose.spaces[1].opened).size, 49, 'reopened all decrypted tables plus catalog');
        const events = beforeClose.events;
        assert.ok(events.indexOf(VERIFY) < events.indexOf('cipher-write'));
        assert.ok(events.indexOf('cleanup:0') < events.indexOf('cipher-open'));
        assert.ok(events.indexOf('cipher-eof') < events.lastIndexOf(VERIFY));
        const recordVerifies = events.flatMap((event, index) => event === VERIFY ? [index] : []);
        assert.ok(recordVerifies[1] < events.indexOf('cleanup:1'), 'original SQL46 post-readback check precedes cleanup');
        assert.ok(events.indexOf('records-eof:3') < events.indexOf(MEDIA), 'SQL47 begins only after re-authenticating records');
        assert.ok(events.indexOf('media-saved') < events.indexOf('media-eof:2'));
        assert.ok(events.indexOf('records-eof:5') < events.indexOf('media-eof:4'), 'paired records and attachments fully authenticated');
        for (let i = 0; i < beforeClose.spaces.length; i++) assert.ok(events.indexOf('cleanup:' + i) < recordVerifies[2], 'ALL plaintext discarded before last source verification');
        assert.ok(events.indexOf('media-eof:4') < events.lastIndexOf('edge-recheck-export'));
        assert.ok(events.lastIndexOf('edge-recheck-export') < events.lastIndexOf(MEDIA_VERIFY));
        assert.ok(events.lastIndexOf(MEDIA_VERIFY) < recordVerifies[2] && recordVerifies[2] < events.indexOf(CLOSE));
        await panel(page).getByRole('heading', { name: '獨立記錄檔案已核驗', exact: true }).waitFor();
        await panel(page).getByRole('heading', { name: '獨立附件檔案已核驗', exact: true }).waitFor();
        await panel(page).getByText('記錄與附件成對核驗已通過', { exact: true }).waitFor();
        await page.evaluate(() => window.__h.release()); await finished(page);
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'verified-pair-and-task-closed'); assert.equal(result.taskCloseConfirmed, true);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.receipt.tables, 48); assert.equal(result.receipt.rows, 2);
        assert.equal(result.mediaEncryptedFileState, 'verified'); assert.equal(result.mediaReceipt.files, 1); assert.equal(result.pairVerified, true);
        assert.equal(result.temporaryPlaintextCleanupUnconfirmed, false);
        const ciphertext = Buffer.from(await page.evaluate(() => Array.from(window.__h.directories[0].files[0].bytes)));
        assert.equal(result.receipt.cipherBytes, ciphertext.length);
        assert.equal(result.receipt.cipherSha256, createHash('sha256').update(ciphertext).digest('hex'));
        for (const secret of [NAME, PASSWORD, PASS, HASH, 'raw-record-CANARY']) assert.equal(ciphertext.includes(Buffer.from(secret)), false);
        const mediaCiphertext = Buffer.from(await page.evaluate(() => Array.from(window.__h.directories[0].files[1].bytes)));
        assert.equal(result.mediaReceipt.cipherBytes, mediaCiphertext.length);
        assert.equal(result.mediaReceipt.cipherSha256, createHash('sha256').update(mediaCiphertext).digest('hex'));
        assert.match(result.receipt.filename, /^employee-records-[0-9a-f-]+\.edx$/);
        assert.equal(result.mediaReceipt.filename, result.receipt.filename.replace('employee-records-', 'employee-attachments-'));
        for (const secret of [NAME, PASS, HASH, 'PRIVATE-document', 'PRIVATE-real-name', ORIGIN]) assert.equal(mediaCiphertext.includes(Buffer.from(secret)), false);
        const originalCalls = (await rpcCalls(page)).length;
        const originalEdgeCalls = await page.evaluate(() => window.__h.edgeCalls.length);
        const paired = await page.evaluate(() => window.__h.readSavedPair());
        assert.deepEqual(paired.inventory, await page.evaluate(() => window.__h.mediaInventory()));
        assert.equal(paired.manifest.entries.length, 2);
        assert.deepEqual(Object.values(paired.media), [[255, 216, 255, 0, 1, 2]]);
        assert.ok(Object.values(paired.flags).every(value => value === false));
        assert.equal(await page.evaluate(() => window.__h.edgeCalls.length), originalEdgeCalls, 'independent paired reader never calls Edge');
        const decoded = await page.evaluate(() => window.__h.readSaved());
        const expected = await page.evaluate(() => ({ catalog: window.__h.catalog, texts: window.__h.texts, fields: window.__h.projectionFields, keys: window.__h.keys, flags: window.__h.flags }));
        assert.deepEqual(decoded.catalog, expected.catalog); assert.deepEqual(decoded.texts, expected.texts);
        assert.deepEqual(Object.keys(JSON.parse(decoded.texts.accounts)), expected.fields);
        assert.equal(decoded.manifest.entries.length, 49);
        for (const [flag, value] of Object.entries(expected.flags)) assert.equal(decoded.catalog[flag], value);
        assert.equal((await rpcCalls(page)).length, originalCalls, 'independent authenticated reader never calls backend');
        assert.equal(await page.locator('#employee-safety-password').inputValue(), '');
        assert.equal(await page.locator('#employee-safety-passphrase').inputValue(), '');
        assert.equal(await page.locator('#employee-safety-confirmation').inputValue(), '');
        assert.equal(await start(page).isDisabled(), true); assert.equal(await reset(page).isEnabled(), true);
        assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), { local: {}, session: {} });
        await noRecovery(page, 1, 1);
        if (process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT && engine === 'chromium') await page.screenshot({ path: process.env.EMPLOYEE_TRANSFER_UI_SCREENSHOT, fullPage: true });
      }));
      await t.test('zero references still saves/authenticates a distinct media volume and pairs before close, without fetching', () => scenario(browser, async page => {
        await prepare(page); await start(page).click(); await finished(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'verified-pair-and-task-closed'); assert.equal(result.receipt.rows, 1);
        assert.equal(result.mediaReceipt.files, 0); assert.equal(result.pairVerified, true); assert.equal(result.taskCloseConfirmed, true);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, 'verified');
        await panel(page).getByText(/0 個附件引用.*已核對全部記錄，沒有支援格式的附件引用/).waitFor();
        const decoded = await page.evaluate(() => window.__h.readSavedPair());
        assert.equal(decoded.inventory.verified, true); assert.deepEqual(decoded.inventory.files, []);
        assert.deepEqual(decoded.media, {}); assert.equal(decoded.manifest.entries.length, 1);
        assert.deepEqual(await page.evaluate(() => window.__h.edgeCalls), []);
        assert.equal(await page.evaluate(() => window.__h.mediaVerifyCount), 3);
        assert.ok(await page.evaluate(() => window.__h.directories[0].files.length === 2 && window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1)));
        await noRecovery(page, 1, 1);
      }));
      for (const missing of [MEDIA, MEDIA_VERIFY]) await t.test(`SQL47 missing ${missing} retains verified records without claiming media/pair or closing`, () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment());
        await prepare(page); await fault(page, { mediaMissing: missing }); await start(page).click(); await finished(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.receipt.rows, 2);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, 'not-written');
        assert.equal(result.mediaReceipt, null); assert.equal(result.pairVerified, false); assert.equal(result.taskCloseConfirmed, false);
        assert.equal((await rpcCalls(page)).filter(c => c.name === missing).length, 1);
        await panel(page).getByText('記錄與附件成對核驗尚未確認', { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1)));
        await parentLocked(page); await noRecovery(page);
      }));
      for (const [label, changes] of [['omitted reference', { omitMediaRef: true }], ['forged row SHA', { forgeMediaRef: 'row' }], ['forged reference SHA', { forgeMediaRef: 'ref' }]]) {
        await t.test(`${label}: SQL47 inventory must match the actual 48-class NDJSON before ANY download`, () => scenario(browser, async page => {
          await page.evaluate(() => window.__h.addAttachment()); await prepare(page); await fault(page, changes);
          await start(page).click(); await finished(page);
          const result = await report(page); safeReport(result);
          assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, 'not-written');
          assert.equal(result.mediaReceipt, null); assert.equal(result.pairVerified, false); assert.equal(result.taskCloseConfirmed, false);
          assert.deepEqual(await page.evaluate(() => window.__h.edgeCalls), []);
          assert.equal(await page.evaluate(() => window.__h.mediaInventoryCount), 1);
          await parentLocked(page); await noRecovery(page);
        }));
      }
      for (const [label, changes, mediaState, hasReceipt, paired, cleanup] of [
        ['download response loss after technical receipt', { downloadLost: true }, 'not-written', false, false, false],
        ['source bytes drift before media encryption', { mediaDriftAt: 1 }, 'not-written', false, false, false],
        ['source bytes drift after media authentication', { mediaDriftAt: 2 }, 'verified', false, false, false],
        ['source bytes drift after paired readback', { mediaDriftAt: 3 }, 'verified', true, true, false],
        ['media save response loss', { saveLost: 'media' }, 'unknown', false, false, false],
        ['saved media ciphertext tampering', { corruptSaved: 'media' }, 'saved', false, false, false],
        ['paired record second full-read tampering', { corruptPair: 'records' }, 'verified', true, false, false],
        ['paired media second full-read tampering', { corruptPair: 'media' }, 'verified', true, false, false],
        ['media snapshot cleanup failure', { cleanupAt: 3 }, 'saved', false, false, true],
        ['media authenticated-readback cleanup failure', { cleanupAt: 4 }, 'verified', false, false, true],
        ['paired-media cleanup failure', { cleanupAt: 6 }, 'verified', true, false, true],
        ['last SQL47 source verify failure', { mediaVerifyFailAt: 3 }, 'verified', true, true, false],
        ['last SQL46 source verify failure', { driftAt: 3 }, 'verified', true, true, false],
      ]) await t.test(`${label}: accurate independent file states, no close/retry/replacement`, () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment()); await prepare(page); await fault(page, changes);
        await start(page).click(); await finished(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.receipt.rows, 2);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, mediaState);
        assert.equal(Boolean(result.mediaReceipt), hasReceipt); assert.equal(result.pairVerified, paired);
        assert.equal(result.taskCloseConfirmed, false); assert.equal(result.temporaryPlaintextCleanupUnconfirmed, cleanup);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        assert.equal(await reset(page).count(), 0);
        const state = await page.evaluate(() => ({ edges: window.__h.edgeCalls, bound: window.__h.mediaBound.size, mediaVerifies: window.__h.mediaVerifyCount,
          verifies: window.__h.verifyCount, files: window.__h.directories[0].files.map(f => ({ kind: f.kind, writes: f.writes, bytes: f.bytes.length, opens: f.opens, eof: f.eof })),
          spaces: window.__h.workspaces.map(w => ({ cleaned: w.cleaned, cleanups: w.cleanups, failed: Boolean(w.cleanupFailed), appended: w.appended })) }));
        assert.equal(state.edges.filter(c => c.action === 'download').length, 1);
        assert.equal(state.bound, 1, 'no fake technical-receipt rollback');
        assert.ok(state.spaces.every((w, index) => w.cleanups === 1 && (index === changes.cleanupAt ? w.failed && !w.cleaned : w.cleaned)));
        if (cleanup) assert.ok(state.spaces[changes.cleanupAt].appended.some(path => path.includes('employee-safety-media') || path.startsWith('media/')), 'fault targets actual media plaintext');
        if (changes.downloadLost) assert.equal(state.edges.length, 1);
        if (changes.corruptPair) {
          assert.equal(state.files.find(f => f.kind === changes.corruptPair).opens, changes.corruptPair === 'records' ? 5 : 4);
          assert.equal(state.mediaVerifies, 2, 'failed pair cannot reach final source verify');
        }
        if (changes.mediaVerifyFailAt) { assert.equal(state.mediaVerifies, 3); assert.equal(state.verifies, 2, 'final media failure precedes final record verify'); }
        if (changes.driftAt === 3) { assert.equal(state.verifies, 3); assert.equal(state.mediaVerifies, 3); }
        await parentLocked(page); await noRecovery(page);
      }));
      await t.test('real progress is record/file/byte counts, followed by paired readback and final source verification (no estimates)', () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment()); await prepare(page);
        await fault(page, { holdRpc: PAGE, holdPageAt: 2, holdEdge: 'recheck-export', holdMediaVerifyAt: 3 }); await start(page).click();
        const progress = () => panel(page).locator('[aria-label="員工備份實際進度"]').locator('dd').allTextContents();
        await page.waitForFunction(name => window.__h.waiting === name, PAGE);
        const initial = await progress();
        assert.equal(initial[0], '記錄：驗證超管並建立員工記錄快照'); assert.equal(initial[1], '0'); assert.equal(initial[2], '0'); assert.equal(initial[3], '0');
        await parentLocked(page);
        await page.evaluate(() => window.__h.release()); await page.waitForFunction(() => window.__h.waiting === 'record-page:2');
        const firstPage = await progress(); assert.equal(firstPage[0], '記錄：分頁讀取員工及關聯記錄');
        assert.equal(firstPage[1], '1'); assert.equal(firstPage[2], '0');
        const firstBytes = await page.evaluate(() => new TextEncoder().encode(JSON.stringify(window.__h.catalog) + '\n' + window.__h.texts.accounts).length);
        assert.equal(Number(firstPage[3].replaceAll(',', '')), firstBytes);
        await page.evaluate(() => window.__h.release());
        await page.waitForFunction(() => window.__h.waiting === 'edge-recheck-export');
        const downloaded = await progress(); assert.equal(downloaded[0], '附件：下載並核對實際附件');
        assert.equal(downloaded[1], '2'); assert.equal(downloaded[2], '1');
        const recordBytes = await page.evaluate(() => window.__h.catalog.tables.reduce((n, t) => n + t.bytes, 0) + new TextEncoder().encode(JSON.stringify(window.__h.catalog) + '\n').length);
        assert.equal(Number(downloaded[3].replaceAll(',', '')), recordBytes + 6, 'bytes are processed raw record entries plus downloaded media');
        assert.equal((await rpcCalls(page)).some(c => c.name === CLOSE), false);
        await page.evaluate(() => window.__h.release()); await page.waitForFunction(() => window.__h.waiting === 'final-media-verify');
        const final = await progress(); assert.equal(final[0], '成對檔案已核驗，最後複核來源記錄及附件');
        assert.equal(final[1], '2'); assert.equal(final[2], '1');
        assert.ok(Number(final[3].replaceAll(',', '')) > recordBytes + 6);
        await panel(page).getByText('記錄與附件成對核驗已通過', { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1)));
        assert.equal((await rpcCalls(page)).some(c => c.name === CLOSE), false);
        await parentLocked(page); await page.evaluate(() => window.__h.release()); await finished(page);
        const result = await report(page); safeReport(result);
        assert.deepEqual(result.lastProgress, { stage: 'close', phase: 'close', rows: 2, files: 1, bytes: Number(final[3].replaceAll(',', '')) });
        assert.equal((await progress())[0], '記錄與附件核對完成，請求結束技術任務');
        assert.equal((await panel(page).innerText()).includes('%'), false);
        await noRecovery(page, 1, 1);
      }));
      for (const unmount of [false, true]) await t.test(`during actual attachment download ${unmount ? 'unmount' : 'local cancel'} aborts only and preserves the owned task`, () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment()); await prepare(page); await fault(page, { holdEdge: 'download' }); await start(page).click();
        await page.waitForFunction(() => window.__h.waiting === 'edge-download');
        await panel(page).getByRole('heading', { name: '獨立記錄檔案已核驗', exact: true }).waitFor();
        await parentLocked(page);
        if (unmount) await page.evaluate(() => window.__unmount());
        else await panel(page).getByRole('button', { name: '停止本機備份處理', exact: true }).click();
        await page.waitForFunction(() => window.__h.waiting === null && window.__h.edgeSignals[0].aborted && window.__h.workspaces.every(w => w.cleaned), null, { timeout: 2000 });
        assert.ok(await page.evaluate(() => window.__h.events.includes('gate-aborted:edge-download')));
        assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        if (unmount) {
          assert.equal(await page.locator('#root').innerText(), '');
          assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 0);
        } else {
          await finished(page); const result = await report(page); safeReport(result);
          assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, 'not-written');
          assert.equal(result.mediaReceipt, null); assert.equal(result.pairVerified, false); assert.equal(result.taskCloseConfirmed, false);
          await parentLocked(page); await openStop(page); await fillStop(page); await stop(page).click();
          await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
          assert.equal((await rpcCalls(page)).find(c => c.name === STOP).args.p_job_id, id(2));
          assert.equal(await reset(page).isEnabled(), true);
        }
        assert.equal(await page.evaluate(() => window.__h.edgeCalls.length), 1);
        await noRecovery(page, 1, 0, unmount ? 0 : 1);
      }));
      for (const phase of ['save', 'pair']) for (const unmount of [false, true]) await t.test(`attachment ${phase} ${unmount ? 'unmount' : 'cancel'} keeps both files and cannot close even after late IO completes`, () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment()); await prepare(page);
        await fault(page, phase === 'save' ? { holdCipherSave: 'media' } : { holdPairRead: 'media' }); await start(page).click();
        const gateName = phase === 'save' ? 'cipher-save:media' : 'pair-read:media';
        await page.waitForFunction(name => window.__h.waiting === name, gateName);
        await page.evaluate(() => { window.__h.lateMediaRelease = window.__h.release; });
        await parentLocked(page);
        const before = await page.evaluate(() => ({ files: window.__h.directories.at(-1).files.map(f => ({ name: f.name, writes: f.writes, bytes: f.bytes.length })),
          edges: window.__h.edgeCalls.length, mediaVerifies: window.__h.mediaVerifyCount }));
        assert.equal(before.files.length, 2); assert.ok(before.files.every(f => f.bytes > 0 && f.writes === 1));
        assert.equal(before.mediaVerifies, phase === 'save' ? 1 : 2);
        if (unmount) await page.evaluate(() => window.__unmount());
        else await panel(page).getByRole('button', { name: '停止本機備份處理', exact: true }).click();
        await page.waitForFunction(() => window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1), null, { timeout: 2000 });
        if (unmount) {
          assert.equal(await page.locator('#root').innerText(), '');
          assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 0);
        } else {
          await finished(page); const result = await report(page); safeReport(result);
          assert.equal(result.status, 'unconfirmed'); assert.equal(result.encryptedFileState, 'verified');
          assert.equal(result.mediaEncryptedFileState, phase === 'save' ? 'unknown' : 'verified');
          assert.equal(Boolean(result.mediaReceipt), phase === 'pair');
          assert.equal(result.pairVerified, false); assert.equal(result.taskCloseConfirmed, false);
          assert.equal(result.temporaryPlaintextCleanupUnconfirmed, false);
          assert.equal(result.lastProgress.stage, phase === 'save' ? 'media' : 'pair');
          assert.equal(await reset(page).count(), 0); await parentLocked(page);
        }
        await page.evaluate(() => window.__h.lateMediaRelease());
        await page.waitForFunction(() => window.__h.waiting === null);
        await noRecovery(page);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        assert.equal(await page.evaluate(() => window.__h.edgeCalls.length), before.edges);
        assert.equal(await page.evaluate(() => window.__h.mediaVerifyCount), before.mediaVerifies);
        assert.deepEqual(await page.evaluate(() => window.__h.directories.at(-1).files.map(f => ({ name: f.name, writes: f.writes, bytes: f.bytes.length }))), before.files, 'late IO cannot overwrite or delete either ciphertext');
        assert.ok(await page.evaluate(() => window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1)));
      }));
      await t.test('cancelling stalled report after attachment failure preserves records and pending parent lock, leaving explicit stop reachable', () => scenario(browser, async page => {
        await prepareParent(page); await page.evaluate(() => window.__h.addAttachment());
        await prepare(page); await fault(page, { downloadLost: true, holdReport: true }); await start(page).click();
        await heldReport(page); await parentLocked(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.mediaEncryptedFileState, 'not-written');
        assert.equal(result.pairVerified, false); assert.equal(result.taskCloseConfirmed, false);
        await cancelHeldReport(page); await parentLocked(page); assert.deepEqual(await report(page), result);
        await openStop(page); await fillStop(page); await stop(page).click();
        await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
        assert.equal(await importStart(page).isEnabled(), true); await noRecovery(page, 1, 0, 1);
      }));
      await t.test('changing exact username invalidates acknowledgment even when changing it back', () => scenario(browser, async page => {
        await prepare(page); await page.locator('#employee-safety-username').fill('Changed-Name');
        assert.equal(await ack(page).isChecked(), false); assert.equal(await start(page).isDisabled(), true);
        await page.locator('#employee-safety-username').fill(NAME);
        assert.equal(await start(page).isDisabled(), true); await ack(page).check();
        assert.equal(await start(page).isEnabled(), true); assert.deepEqual(await rpcCalls(page), []);
      }));
      await t.test('empty/whitespace/overlong names, missing password, short and mismatched keys cannot start', () => scenario(browser, async page => {
        await prepare(page);
        for (const username of ['', ' ', ' ' + NAME, NAME + ' ', '𠮷'.repeat(257)]) {
          await page.locator('#employee-safety-username').fill(username); await ack(page).check();
          assert.equal(await start(page).isDisabled(), true, 'invalid exact name');
          await panel(page).locator('form').first().dispatchEvent('submit');
        }
        await page.locator('#employee-safety-username').fill(NAME); await ack(page).check();
        await page.locator('#employee-safety-password').fill(''); assert.equal(await start(page).isDisabled(), true);
        await page.locator('#employee-safety-password').fill(PASSWORD);
        for (const [key, confirmation] of [['13-characters', '13-characters'], [PASS, PASS + '-mismatch']]) {
          await page.locator('#employee-safety-passphrase').fill(key); await page.locator('#employee-safety-confirmation').fill(confirmation);
          assert.equal(await start(page).isDisabled(), true); await panel(page).locator('form').first().dispatchEvent('submit');
        }
        assert.deepEqual(await rpcCalls(page), []);
      }));
      for (const mode of ['unavailable', 'lost']) await t.test(`backend begin ${mode}: no automatic retry/close and safe unknown outcome`, () => scenario(browser, async page => {
        await prepare(page); await fault(page, { begin: mode }); await start(page).click(); await finished(page);
        await panel(page).getByRole('alert').filter({ hasText: /^本次員工備份未能確認全部完成/ }).waitFor();
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.jobId, null); assert.equal(result.receipt, null);
        assert.equal(result.taskCloseConfirmed, false); assert.equal(result.encryptedFileState, 'not-written');
        assert.equal(result.mediaEncryptedFileState, 'not-written'); assert.equal(result.mediaReceipt, null); assert.equal(result.pairVerified, false);
        assert.equal(await start(page).isDisabled(), true); assert.equal(await reset(page).count(), 0);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), mode === 'lost');
        await noRecovery(page);
      }));
      for (const [label, changes, expectedState, expectedVerifies] of [
        ['page response loss', { page: 'lost' }, 'not-written', 0],
        ['corrupt exported page', { page: 'corrupt' }, 'not-written', 0],
        ['source drift before encryption', { driftAt: 1 }, 'not-written', 1],
        ['source drift after complete readback', { driftAt: 2 }, 'verified', 2],
        ['saved ciphertext corruption', { corruptFile: true }, 'saved', 1],
        ['record save response loss', { saveLost: 'records' }, 'unknown', 1],
      ]) await t.test(`${label} prevents close and never retries or reports success`, () => scenario(browser, async page => {
        await prepare(page); await fault(page, changes); await start(page).click(); await finished(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.jobId, id(2)); assert.equal(result.receipt, null);
        assert.equal(result.encryptedFileState, expectedState); assert.equal(result.taskCloseConfirmed, false);
        assert.equal(result.mediaEncryptedFileState, 'not-written'); assert.equal(result.mediaReceipt, null); assert.equal(result.pairVerified, false);
        assert.equal(await page.evaluate(() => window.__h.verifyCount), expectedVerifies);
        assert.ok(await page.evaluate(() => window.__h.workspaces.every(w => w.cleaned && w.cleanups === 1)));
        if (changes.page) assert.equal((await rpcCalls(page)).filter(c => c.name === PAGE).length, 1);
        if (changes.driftAt) assert.equal((await rpcCalls(page)).filter(c => c.name === PAGE).length, 48);
        assert.equal(await reset(page).count(), 0); await parentLocked(page); await noRecovery(page);
      }));
      await t.test('lost close response retains verified receipt but leaves task outcome unknown', () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment());
        await prepare(page); await fault(page, { closeLost: true }); await start(page).click(); await finished(page);
        await panel(page).getByText('來源複核或任務結束尚未確認', { exact: true }).waitFor();
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.encryptedFileState, 'verified');
        assert.equal(result.taskCloseConfirmed, false); assert.equal(result.receipt.rows, 2); assert.equal(result.receipt.tables, 48);
        assert.equal(result.mediaEncryptedFileState, 'verified'); assert.equal(result.mediaReceipt.files, 1); assert.equal(result.pairVerified, true);
        await panel(page).getByText('記錄與附件成對核驗已通過', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__h.serverRunning), false, 'server may have closed, but no receipt means UI must remain pending');
        assert.equal(await reset(page).count(), 0); await parentLocked(page); await noRecovery(page, 1, 1);
      }));
      await t.test('busy/pending lock previously actionable parent export/import, not explicit known-job stop; fresh prepare required', () => scenario(browser, async page => {
        await prepareParent(page); await prepare(page); await fault(page, { holdRpc: PAGE, page: 'lost' }); await start(page).click();
        await page.waitForFunction(name => window.__h.waiting === name, PAGE); await parentLocked(page);
        await page.evaluate(() => window.__h.release()); await finished(page); await parentLocked(page);
        await openStop(page); assert.equal(await stop(page).isDisabled(), true);
        await fillStop(page, STOP_TEXT + ' '); assert.equal(await stop(page).isDisabled(), true);
        await page.locator('#employee-safety-stop-confirmation').fill(STOP_TEXT);
        await page.locator('#employee-safety-stop-password').fill(''); assert.equal(await stop(page).isDisabled(), true);
        await panel(page).locator('details form').dispatchEvent('submit'); await noRecovery(page);
        await fillStop(page); assert.equal(await stop(page).isEnabled(), true, 'pending must not disable explicit stop');
        await fault(page, { stopFail: true }); await stop(page).click();
        await panel(page).getByText(/^無法確認停止結果/).waitFor(); await parentLocked(page); await noRecovery(page, 1, 0, 1);
        assert.equal(await page.locator('#employee-safety-stop-password').inputValue(), '');
        assert.equal(await page.locator('#employee-safety-stop-confirmation').inputValue(), '');
        await fault(page, { stopFail: false }); await fillStop(page); await stop(page).click();
        await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
        assert.equal(await importStart(page).isEnabled(), true); assert.equal(await page.locator('#migration-panel-export').getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true }).isEnabled(), true);
        const stops = (await rpcCalls(page)).filter(c => c.name === STOP);
        assert.deepEqual(stops.map(c => c.args.p_job_id), [id(2), id(2)]);
        assert.equal(await start(page).isDisabled(), true); assert.equal(await reset(page).isEnabled(), true);
        const savedReport = await report(page); assert.equal(savedReport.status, 'unconfirmed', 'stop must not rewrite failure as successful backup');
        await noRecovery(page, 1, 0, 2);
        await reset(page).click();
        assert.equal(await page.locator('#employee-safety-username').inputValue(), ''); assert.equal(await ack(page).isChecked(), false);
        assert.equal(await start(page).isDisabled(), true);
        await noRecovery(page, 1, 0, 2);
        await fault(page, { page: null }); await prepare(page); await start(page).click(); await finished(page);
        assert.equal(await page.evaluate(() => window.__h.directories.at(-1).files[0].writes), 1);
        await noRecovery(page, 2, 1, 2);
      }));
      await t.test('begin response loss stop sends null job id; no auto rerun after explicit stop', () => scenario(browser, async page => {
        await prepare(page); await fault(page, { begin: 'lost' }); await start(page).click(); await finished(page);
        await openStop(page); await fillStop(page); assert.equal(await stop(page).isEnabled(), true); await stop(page).click();
        await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
        const calls = await rpcCalls(page); assert.equal(calls.find(c => c.name === STOP).args.p_job_id, null);
        assert.equal(await reset(page).isEnabled(), true); assert.equal(await start(page).isDisabled(), true);
        assert.equal((await report(page)).receipt, null); await noRecovery(page, 1, 0, 1);
      }));
      await t.test('failed explicit stop BEFORE any backup locks every new-backup control until a fresh successful stop', () => scenario(browser, async page => {
        await prepareParent(page); await prepare(page);
        assert.deepEqual(await rpcCalls(page), [], 'valid form and chosen directory have not begun a backup');
        // Model a pre-existing owned task; this page has never received its begin receipt.
        await page.evaluate(() => { window.__h.serverRunning = true; });
        const pickerCount = await page.evaluate(() => window.__h.events.filter(event => event === 'synthetic-picker').length);
        await openStop(page); await fillStop(page); await fault(page, { stopFail: true }); await stop(page).click();
        await panel(page).getByText(/^無法確認停止結果/).waitFor();
        await page.waitForFunction(() => !document.getElementById('employee-safety-stop-password').matches(':disabled'));
        for (const selector of ['#employee-safety-username', '#employee-safety-password', '#employee-safety-passphrase', '#employee-safety-confirmation']) assert.equal(await page.locator(selector).isDisabled(), true, selector);
        assert.equal(await ack(page).isDisabled(), true);
        assert.equal(await start(page).isDisabled(), true);
        const choose = panel(page).getByRole('button', { name: '選擇員工備份保存目錄', exact: true });
        assert.equal(await choose.isDisabled(), true);
        await panel(page).locator('form').first().dispatchEvent('submit');
        await choose.dispatchEvent('click');
        assert.equal(await page.evaluate(() => window.__h.events.filter(event => event === 'synthetic-picker').length), pickerCount, 'pending must not choose a fresh directory');
        await parentLocked(page); await noRecovery(page, 0, 0, 1);
        assert.equal(await stop(page).isDisabled(), true, 'failed stop clears credentials');
        await fillStop(page); assert.equal(await stop(page).isEnabled(), true, 'pending still permits owner stop with fresh credentials');
        await fault(page, { stopFail: false }); await stop(page).click();
        await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
        await page.waitForFunction(() => !document.getElementById('employee-safety-username').matches(':disabled'));
        for (const selector of ['#employee-safety-username', '#employee-safety-password', '#employee-safety-passphrase', '#employee-safety-confirmation']) assert.equal(await page.locator(selector).isEnabled(), true, selector);
        assert.equal(await ack(page).isEnabled(), true); assert.equal(await choose.isEnabled(), true);
        assert.equal(await start(page).isEnabled(), true, 'original valid inputs are now available only for explicit submission');
        assert.equal(await importStart(page).isEnabled(), true);
        assert.equal(await page.locator('#migration-panel-export').getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true }).isEnabled(), true);
        assert.deepEqual((await rpcCalls(page)).map(call => ({ name: call.name, job: call.args.p_job_id })), [{ name: STOP, job: null }, { name: STOP, job: null }]);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), false);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 0);
        await noRecovery(page, 0, 0, 2);
      }));
      await t.test('stalled report after FAILED begin can be cancelled promptly without clearing pending or closing the unknown task', () => scenario(browser, async page => {
        await prepareParent(page); await prepare(page); await fault(page, { begin: 'lost', holdReport: true }); await start(page).click();
        await heldReport(page); await parentLocked(page);
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'unconfirmed'); assert.equal(result.jobId, null); assert.equal(result.receipt, null);
        assert.equal(result.taskCloseConfirmed, false); assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        await cancelHeldReport(page);
        await parentLocked(page);
        await panel(page).getByText(/^員工備份任務結果尚未確認/).waitFor();
        assert.equal(await reset(page).count(), 0); assert.equal(await start(page).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.__h.signals.some(signal => signal.aborted)), false, 'report-only cancel must not abort the independent backup controller');
        assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        assert.deepEqual(await report(page), result); await noRecovery(page);
        await openStop(page); await fillStop(page);
        assert.equal(await stop(page).isEnabled(), true, 'report cancellation promptly makes owner stop reachable');
        await stop(page).click();
        await panel(page).getByText(/^服務端已確認停止本人的員工記錄備份技術任務/).waitFor();
        assert.equal((await rpcCalls(page)).find(call => call.name === STOP).args.p_job_id, null);
        assert.equal(await reset(page).isEnabled(), true); assert.equal(await start(page).isDisabled(), true);
        await noRecovery(page, 1, 0, 1);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 1);
        assert.equal(await page.evaluate(() => window.__h.reports.length), 0);
      }));
      await t.test('stalled report-only cancellation after SUCCESS preserves verified receipt/close confirmation and unlocks parent without rerun', () => scenario(browser, async page => {
        await prepareParent(page); await page.evaluate(() => window.__h.addAttachment()); await prepare(page); await fault(page, { holdReport: true }); await start(page).click();
        await heldReport(page); await parentLocked(page);
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        const result = await report(page); safeReport(result);
        assert.equal(result.status, 'verified-pair-and-task-closed'); assert.equal(result.taskCloseConfirmed, true);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(result.receipt.rows, 2); assert.equal(result.receipt.tables, 48);
        assert.equal(result.mediaEncryptedFileState, 'verified'); assert.equal(result.mediaReceipt.files, 1); assert.equal(result.pairVerified, true);
        const mediaBefore = await page.evaluate(() => { const file = window.__h.directories.at(-1).files[1]; return { name: file.name, size: file.bytes.length, writes: file.writes, opens: file.opens, eof: file.eof }; });
        const fileBefore = await page.evaluate(() => { const file = window.__h.directories.flatMap(directory => directory.files)[0]; return { name: file.name, size: file.bytes.length, writes: file.writes, opens: file.opens, eof: file.eof }; });
        // SQL47 deadline signals are intentionally aborted when each request finishes.
        // Cancelling the report must not change ANY existing signal or abort the still-live SQL46 session requests.
        const signalsBefore = await page.evaluate(() => window.__h.signals.map(signal => signal.aborted));
        await cancelHeldReport(page);
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        const receiptView = panel(page).locator('[aria-label="員工記錄備份核驗結果"]');
        assert.ok((await receiptView.innerText()).includes(result.receipt.filename));
        assert.ok((await receiptView.innerText()).includes(result.receipt.cipherSha256));
        assert.equal(await page.locator('#migration-files').isEnabled(), true);
        assert.equal(await importStart(page).isEnabled(), true);
        assert.equal(await page.locator('#migration-panel-export').getByRole('button', { name: '開始目前十個領域加密導出', exact: true, includeHidden: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '重新檢查能力', exact: true }).isEnabled(), true);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), false);
        assert.deepEqual(await page.evaluate(() => window.__h.signals.map(signal => signal.aborted)), signalsBefore, 'report cancellation leaves completed media deadlines and backup controllers unchanged');
        assert.ok(await page.evaluate(names => window.__h.calls.every((call, i) => names.includes(call.name) || !window.__h.signals[i].aborted), [MEDIA, MEDIA_VERIFY]), 'report cancel does not abort SQL46 session requests');
        assert.deepEqual(await report(page), result);
        assert.deepEqual(await page.evaluate(() => { const file = window.__h.directories.flatMap(directory => directory.files)[0]; return { name: file.name, size: file.bytes.length, writes: file.writes, opens: file.opens, eof: file.eof }; }), fileBefore);
        assert.deepEqual(await page.evaluate(() => { const file = window.__h.directories.at(-1).files[1]; return { name: file.name, size: file.bytes.length, writes: file.writes, opens: file.opens, eof: file.eof }; }), mediaBefore);
        const pair = await page.evaluate(() => window.__h.readSavedPair()); assert.equal(pair.inventory.files.length, 1);
        const decoded = await page.evaluate(() => window.__h.readSaved());
        assert.deepEqual(JSON.parse(decoded.texts.accounts), await page.evaluate(() => window.__h.account));
        assert.equal(decoded.manifest.entries.length, 49);
        assert.equal(await start(page).isDisabled(), true); assert.equal(await reset(page).isEnabled(), true);
        await noRecovery(page, 1, 1);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 1);
        assert.equal(await page.evaluate(() => window.__h.reports.length), 0);
      }));
      for (const succeeded of [false, true]) await t.test(`unmount during held ${succeeded ? 'SUCCESS' : 'FAILED'} report aborts writing promptly with no late save or recovery action`, () => scenario(browser, async page => {
        await prepare(page); await fault(page, { holdReport: true, ...(!succeeded ? { begin: 'lost' } : {}) }); await start(page).click();
        await heldReport(page);
        const result = await report(page); safeReport(result); assert.equal(result.taskCloseConfirmed, succeeded);
        const writesBeforeUnmount = await page.evaluate(() => window.__h.reportAttempts.length);
        assert.equal(writesBeforeUnmount, 1);
        await page.evaluate(() => window.__unmount());
        await page.waitForFunction(() => window.__h.reportSignals[0].aborted && window.__h.reportSettlements.length === 1 && window.__h.waiting === null, null, { timeout: 2000 });
        assert.equal(await page.locator('#root').innerText(), '');
        assert.deepEqual(await page.evaluate(() => window.__h.reportSettlements), [{ aborted: true, saved: false }]);
        assert.ok(await page.evaluate(() => window.__h.events.includes('gate-aborted:report-write')));
        await page.evaluate(() => window.__h.lateReportRelease());
        await noRecovery(page, 1, succeeded ? 1 : 0);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), writesBeforeUnmount, 'unmount cannot start another report write');
        assert.equal(await page.evaluate(() => window.__h.reports.length), 0, 'aborted report must not be committed by a late release');
        assert.equal(await page.evaluate(() => window.__h.serverRunning), !succeeded);
        assert.ok(await page.evaluate(() => window.__h.workspaces.every(workspace => workspace.cleaned)));
        assert.deepEqual(await report(page), result);
      }));
      await t.test('denied synthetic directory permission never begins a task', () => scenario(browser, async page => {
        await fault(page, { pickerDenied: true });
        await panel(page).getByRole('button', { name: '選擇員工備份保存目錄', exact: true }).click();
        await panel(page).getByText(/^未取得員工備份目錄/).waitFor();
        assert.equal(await start(page).isDisabled(), true); assert.deepEqual(await rpcCalls(page), []);
        assert.equal(await page.evaluate(() => window.__h.directories.length), 0);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), 0);
      }));
      await t.test('report save failure retains verified result/task-close evidence without rerun', () => scenario(browser, async page => {
        await prepare(page); await fault(page, { reportFail: true }); await start(page).click(); await finished(page, true);
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        const result = await report(page); safeReport(result); assert.equal(result.taskCloseConfirmed, true);
        assert.equal(result.encryptedFileState, 'verified'); assert.equal(await page.evaluate(() => window.__h.reports.length), 0);
        assert.equal(await start(page).isDisabled(), true); assert.equal(await reset(page).isEnabled(), true);
        assert.equal(await page.locator('#migration-files').isEnabled(), true); await noRecovery(page, 1, 1);
      }));
      await t.test('switching actual parent tabs preserves the same in-flight run and verified result', () => scenario(browser, async page => {
        await prepare(page); await fault(page, { holdRpc: PAGE }); await start(page).click();
        await page.waitForFunction(name => window.__h.waiting === name, PAGE);
        await page.getByRole('tab', { name: '紀錄', exact: true }).click();
        await page.getByText('服務端階段任務紀錄', { exact: true }).waitFor();
        assert.equal(await panel(page).isVisible(), false);
        assert.equal(await page.evaluate(() => window.__h.signals.some(s => s.aborted)), false);
        await page.getByRole('tab', { name: '導出', exact: true }).click();
        await page.getByRole('button', { name: '查看員工備份狀態', exact: true }).click();
        await panel(page).getByText('員工記錄與附件備份執行中', { exact: true }).waitFor();
        await page.evaluate(() => window.__h.release()); await finished(page);
        const before = await report(page);
        await page.getByRole('tab', { name: '紀錄', exact: true }).click();
        await page.getByRole('tab', { name: '導入', exact: true }).click();
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        assert.deepEqual(await report(page), before); await noRecovery(page, 1, 1);
      }));
      await t.test('local cancel only aborts processing; server task requires a separate explicit stop', () => scenario(browser, async page => {
        await prepare(page); await fault(page, { holdRpc: PAGE }); await start(page).click();
        await page.waitForFunction(name => window.__h.waiting === name, PAGE);
        await panel(page).getByRole('button', { name: '停止本機備份處理', exact: true }).click(); await finished(page);
        assert.equal(await page.evaluate(() => window.__h.serverRunning), true);
        assert.ok(await page.evaluate(() => window.__h.events.some(e => e.startsWith('gate-aborted:'))));
        await parentLocked(page); await noRecovery(page);
      }));
      for (const held of [BEGIN, PAGE]) await t.test(`unmount during ${held} aborts only, never automatically stops/closes/restarts`, () => scenario(browser, async page => {
        await prepare(page); await fault(page, { holdRpc: held }); await start(page).click();
        await page.waitForFunction(name => window.__h.waiting === name, held);
        const writesBeforeUnmount = await page.evaluate(() => window.__h.reportAttempts.length);
        assert.equal(writesBeforeUnmount, 0);
        await page.evaluate(() => window.__unmount());
        await page.waitForFunction(() => window.__h.signals.some(s => s.aborted) && window.__h.waiting === null && window.__h.workspaces.every(w => w.cleaned), null, { timeout: 2000 });
        assert.equal(await page.locator('#root').innerText(), '');
        assert.ok(await page.evaluate(name => window.__h.events.includes('gate-aborted:' + name), held));
        await noRecovery(page);
        assert.equal(await page.evaluate(() => window.__h.reportAttempts.length), writesBeforeUnmount, 'unmount must not start a NEW report write');
        assert.equal(await page.evaluate(() => window.__h.reportSignals.length), 0);
        assert.equal(await page.evaluate(() => window.__h.reports.length), 0);
      }));
      await t.test('375px supported-path result and explicit-stop controls do not overflow', () => scenario(browser, async page => {
        await page.evaluate(() => window.__h.addAttachment()); await prepare(page); await start(page).click(); await finished(page); await openStop(page);
        await fillStop(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no document horizontal overflow');
        await panel(page).getByRole('heading', { name: '獨立附件檔案已核驗', exact: true }).waitFor();
        await panel(page).getByText('記錄與附件成對核驗已通過', { exact: true }).waitFor();
        await panel(page).getByText('來源複核及任務結束已確認', { exact: true }).waitFor();
        const result = await report(page); safeReport(result); assert.equal(result.mediaReceipt.files, 1);
        const bounds = await panel(page).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 375);
        for (const label of ['員工記錄備份核驗結果', '員工附件備份核驗結果', '員工備份成對核驗狀態']) {
          const box = await panel(page).locator(`[aria-label="${label}"]`).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 375, label);
        }
        for (const selector of ['#employee-safety-stop-password', '#employee-safety-stop-confirmation']) {
          const box = await page.locator(selector).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 375);
        }
        await noRecovery(page, 1, 1);
      }, { viewport: { width: 375, height: 812 } }));
      await t.test('unsupported browser has no UA spoof and cannot choose directory or begin', () => scenario(browser, async page => {
        await panel(page).getByText(/加密保存及回讀需要安全連線/).waitFor();
        assert.equal(await page.locator('#employee-safety-username').isDisabled(), true);
        assert.equal(await panel(page).getByRole('button', { name: '選擇員工備份保存目錄', exact: true }).isDisabled(), true);
        assert.equal(await start(page).isDisabled(), true);
        await panel(page).locator('form').first().dispatchEvent('submit');
        assert.deepEqual(await rpcCalls(page), []); assert.equal(await page.evaluate(() => window.__h.directories.length), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }, { unsupported: true, viewport: { width: 375, height: 812 } }));
    } finally { await browser.close(); }
  });
}
