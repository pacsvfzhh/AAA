import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import {
  beginDispatchExport, beginProductsExport, beginSharedSettingsExport,
} from './api';
import { createActivityExportSession } from './activityApi';
import { exportActivityData } from './activityTransfer';
import { createArchivesExportSession } from './archiveApi';
import {
  exportArchiveBundle, type ArchiveBundleWorkspace, type ArchiveBundleWorkspaceFactory,
} from './archiveBundle';
import { createArchiveMediaSession } from './archiveMedia';
import { createChatExportSession } from './chatApi';
import { createChatMediaSession, exportChatBundle } from './chatMedia';
import { MAX_CONTAINER_INPUT_BYTES } from './container';
import { dispatchTransferChecks, exportDispatchData } from './dispatchTransfer';
import { createFinanceExportSession } from './financeApi';
import { exportFinanceData } from './financeTransfer';
import { createIdentityExportSession } from './identityApi';
import { exportIdentityData } from './identityTransfer';
import type { ManifestEntry } from './manifest';
import { createNotificationsExportSession } from './notificationsApi';
import { createNotificationsMediaSession, exportNotificationsBundle } from './notificationsMedia';
import { exportProducts } from './productTransfer';
import { exportSharedSettings } from './sharedExport';
import type { SiteDomain, SiteExportDriver } from './siteTransfer';
import { createVerificationExportSession } from './verificationApi';
import { createVerificationMediaSession, exportVerificationBundle } from './verificationMedia';

const { checkAbort, object, uuid } = dispatchTransferChecks;
type Collect = SiteExportDriver['collect'];
type ExportArchive = NonNullable<SiteExportDriver['exportArchive']>;
interface StartedExport {
  catalog: unknown;
  collect: Collect;
  close: SiteExportDriver['close'];
  exportArchive?: ExportArchive;
}
interface CollectedData {
  catalog: unknown;
  entries: ManifestEntry[];
  rows: number;
  bytes: number;
  media?: unknown;
}

// The record/media exporters own validation. Keep their original bytes intact,
// but adapt a service download (up to 50 MiB) to the OPFS/container 1 MiB bound.
function boundedWorkspace(workspace: ArchiveBundleWorkspace, signal?: AbortSignal): ArchiveBundleWorkspace {
  let invalidated = false;
  let cleanup: Promise<void> | undefined;
  return {
    open: path => workspace.open(path),
    async append(path, raw, appendSignal) {
      const writeSignal = appendSignal ?? signal;
      for (let offset = 0; offset < raw.length || offset === 0; offset += MAX_CONTAINER_INPUT_BYTES) {
        checkAbort(signal);
        checkAbort(writeSignal);
        if (invalidated) throw new Error('Site export workspace has been discarded.');
        await workspace.append(path, raw.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES), writeSignal);
        checkAbort(signal);
        checkAbort(writeSignal);
        if (invalidated) throw new Error('Site export workspace has been discarded.');
      }
    },
    abort(reason) {
      invalidated = true;
      return cleanup ??= Promise.resolve().then(() => workspace.abort(reason));
    },
  };
}
function boundedFactory(createWorkspace: ArchiveBundleWorkspaceFactory, signal?: AbortSignal): ArchiveBundleWorkspaceFactory {
  const workspaces = new WeakMap<ArchiveBundleWorkspace, ArchiveBundleWorkspace>();
  return () => {
    const workspace = createWorkspace();
    let bounded = workspaces.get(workspace);
    if (!bounded) {
      bounded = boundedWorkspace(workspace, signal);
      workspaces.set(workspace, bounded);
    }
    // Preserve identity so exportArchiveBundle still rejects reused workspaces.
    return bounded;
  };
}
function collected(result: CollectedData, onProgress: Parameters<Collect>[1]): Awaited<ReturnType<Collect>> {
  const files = result.entries.filter(entry => entry.kind === 'media').length;
  const progress = { rows: result.rows, bytes: result.bytes, files };
  // Also report completed records for a real bundle with no media references.
  onProgress(progress);
  return { catalog: result.catalog, entries: result.entries, ...progress, media: result.media ?? null };
}
function closeReceipt(value: unknown, scope: 'shared-settings' | 'product-catalog'): unknown {
  const receipt = object(value, ['success', 'scope', 'full_site_complete']);
  if (receipt.success !== true || receipt.scope !== scope || receipt.full_site_complete !== false) {
    throw new Error('Site export close was not confirmed; reconcile the task before retrying.');
  }
  return receipt;
}

// No task is created until its explicit begin. The caller must save, authenticate
// and discard each collected workspace before close, then begin the next domain.
// A failed/unknown begin, collection or close retains the local active-task lock:
// never silently cancel it, retry a write, or start another possibly live task.
export function createSiteExportDrivers(packageId: string, adminPassword: string): SiteExportDriver[] {
  uuid(packageId);
  let active: SiteDomain | null = null;
  let remainingBegins = 10;
  const driver = (
    domain: SiteDomain,
    start: (password: string, signal?: AbortSignal) => Promise<StartedExport>,
    archive = false,
  ): SiteExportDriver => {
    let state: 'new' | 'beginning' | 'ready' | 'collecting' | 'collected' | 'closing' | 'closed' | 'failed' = 'new';
    let started: StartedExport | undefined;
    const collectOnce = async <T>(operation: (task: StartedExport) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      checkAbort(signal);
      if (state !== 'ready' || active !== domain || !started) {
        throw new Error('Site export collection requires an idle, confirmed domain task.');
      }
      state = 'collecting';
      try {
        const result = await operation(started);
        checkAbort(signal);
        state = 'collected';
        return result;
      } catch (error) {
        state = 'failed'; adminPassword = '';
        throw error;
      }
    };
    const result: SiteExportDriver = {
      domain,
      async begin(signal) {
        checkAbort(signal);
        if (state !== 'new' || active !== null) {
          throw new Error('Close the current site export task before beginning another; begin is not retried.');
        }
        active = domain; state = 'beginning';
        try {
          started = await start(adminPassword, signal);
          checkAbort(signal);
          state = 'ready';
          return started.catalog;
        } catch (error) {
          state = 'failed'; adminPassword = '';
          throw error;
        } finally {
          if (--remainingBegins === 0) adminPassword = '';
        }
      },
      async collect(workspace, onProgress, signal) {
        if (archive) throw new Error('Archives require exportArchive; record-only or empty collection is not supported.');
        return collectOnce(task => task.collect(boundedWorkspace(workspace, signal), onProgress, signal), signal);
      },
      async close(signal) {
        checkAbort(signal);
        if (state !== 'collected' || active !== domain || !started) {
          throw new Error('Site export close requires successful collection and caller-confirmed save, authentication and cleanup.');
        }
        state = 'closing';
        try {
          const receipt = await started.close(signal);
          checkAbort(signal);
          state = 'closed'; active = null; started = undefined;
          return receipt;
        } catch (error) {
          state = 'failed'; adminPassword = '';
          throw error;
        }
      },
    };
    if (archive) {
      result.exportArchive = (file, createWorkspace, passphrase, info, onProgress, signal) => collectOnce(task => {
        if (!task.exportArchive) throw new Error('Archive bundle export is not available.');
        return task.exportArchive(file, boundedFactory(createWorkspace, signal), passphrase, info, onProgress, signal);
      }, signal);
    }
    return result;
  };
  return [
    driver('shared', async (password, signal) => {
      const auth = getAdminFinancialSessionToken();
      const task = await beginSharedSettingsExport(password, signal);
      return {
        catalog: task.catalog,
        async collect(workspace, onProgress, signal) {
          // Shared avatars/icons remain URL records only, NOT included media.
          // The underlying catalog/result deliberately keep full_site_complete=false.
          return collected(await exportSharedSettings(task.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        async close(signal) {
          checkAbort(signal);
          const query = supabase.rpc('employee_export_shared_close', {
            p_admin_session_token: auth, p_job_token: task.jobToken,
          });
          const { data, error } = await (signal ? query.abortSignal(signal) : query);
          checkAbort(signal);
          if (error) throw new Error('Shared export close outcome is uncertain; reconcile before retrying.');
          return closeReceipt(data, 'shared-settings');
        },
      };
    }),
    driver('products', async (password, signal) => {
      const task = await beginProductsExport(password, signal);
      return {
        catalog: task.catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportProducts(task.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        close: async signal => closeReceipt(await task.close(signal), 'product-catalog'),
      };
    }),
    driver('dispatch', async (password, signal) => {
      const task = await beginDispatchExport(password, signal);
      return {
        catalog: task.catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportDispatchData(task.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        close: signal => task.close(signal),
      };
    }),
    driver('identity', async (password, signal) => {
      const session = createIdentityExportSession(packageId, password);
      const catalog = await session.begin(signal);
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportIdentityData(session.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('finance', async (password, signal) => {
      const session = createFinanceExportSession(packageId, password);
      const catalog = await session.begin(signal);
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportFinanceData(session.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('activity', async (password, signal) => {
      const session = createActivityExportSession(packageId, password);
      const catalog = await session.begin(signal);
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportActivityData(session.source, workspace, {
            signal, onProgress: progress => onProgress({ rows: progress.rows, bytes: progress.bytes, files: 0 }),
          }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('verification', async (password, signal) => {
      const session = createVerificationExportSession(packageId, password);
      const catalog = await session.begin(signal);
      const job = session.identity();
      if (!job) throw new Error('Verification export task identity was not confirmed.');
      const media = createVerificationMediaSession(job.jobToken, 'export');
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportVerificationBundle(session.source, workspace, media, { signal, onProgress }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('notifications', async (password, signal) => {
      const session = createNotificationsExportSession(packageId, password);
      const catalog = await session.begin(signal);
      const job = session.identity();
      if (!job) throw new Error('Notifications export task identity was not confirmed.');
      const media = createNotificationsMediaSession(job.jobToken, 'export');
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportNotificationsBundle(session.source, workspace, media, { signal, onProgress }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('chat', async (password, signal) => {
      const session = createChatExportSession(packageId, password);
      const catalog = await session.begin(signal);
      const job = session.identity();
      if (!job) throw new Error('Chat export task identity was not confirmed.');
      const media = createChatMediaSession(job.jobToken, 'export');
      return {
        catalog,
        async collect(workspace, onProgress, signal) {
          return collected(await exportChatBundle(session.source, workspace, media, { signal, onProgress }), onProgress);
        },
        close: signal => session.close(signal),
      };
    }),
    driver('archives', async (password, signal) => {
      const session = createArchivesExportSession(packageId, password);
      const catalog = await session.begin(signal);
      const job = session.identity();
      if (!job) throw new Error('Archives export task identity was not confirmed.');
      const media = createArchiveMediaSession(job.jobToken, 'export');
      return {
        catalog,
        async collect() { throw new Error('Archives must use the authenticated archive bundle exporter.'); },
        exportArchive: (file, createWorkspace, passphrase, info, onProgress, signal) => exportArchiveBundle(
          session.source, media, file, createWorkspace, passphrase, info, { signal, onProgress },
        ),
        close: signal => session.close(signal),
      };
    }, true),
  ];
}
