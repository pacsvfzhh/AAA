import { getAdminFinancialSessionToken } from './auth';
import { formatSupabaseError, isSupabaseTransientError, supabase } from './supabase';

type AuditAction =
  | 'notification_edit' | 'notification_delete'
  | 'chat_edit' | 'chat_delete' | 'conversation_delete' | 'customer_delete' | 'employee_delete' | 'admin_delete'
  | 'template_edit' | 'template_delete' | 'auto_edit' | 'auto_delete';

export async function mutateAuditedContent(
  action: AuditAction,
  targetIds: string[],
  payload: Record<string, unknown> = {},
  employeeId?: string,
): Promise<{ success: boolean; changed_count: number }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action, targetIds, payload, employeeId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error && typeof error === 'object' && 'context' in error) {
    if (error.context instanceof Response) {
      const details = await error.context.clone().json().catch(() => null);
      const requestError = new Error(typeof details?.error === 'string' ? details.error : formatSupabaseError(error));
      Object.assign(requestError, { status: error.context.status });
      throw requestError;
    }
    if (isSupabaseTransientError(error.context)) {
      throw error.context instanceof Error ? error.context : new Error(formatSupabaseError(error.context));
    }
  }
  if (error || data?.error) throw new Error(data?.error || formatSupabaseError(error));
  return data;
}

export interface AuditDeletionFilters {
  type: string | null;
  owner: string | null;
  action: string | null;
  contentSearch: string | null;
  identitySearch: string | null;
  from: string | null;
  to: string | null;
}

export async function prepareAuditedDeletion(filters: AuditDeletionFilters, eventId?: string): Promise<{ job_id: string; card_count: number; event_count: number }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'prepare_delete', filters, eventId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error || data?.error) throw new Error(data?.error || formatSupabaseError(error));
  return data;
}

export async function prepareAuditedConversationDeletion(eventId: string): Promise<{ job_id: string; card_count: number; event_count: number }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'prepare_conversation_delete', eventId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error || data?.error) throw new Error(data?.error || formatSupabaseError(error));
  return data;
}

export async function listPendingAuditedDeletions(): Promise<Array<{ job_id: string; card_count: number; event_count: number; finished_at: string | null }>> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'pending_deletes', sessionToken: getAdminFinancialSessionToken() },
  });
  if (error || data?.error) throw new Error(data?.error || formatSupabaseError(error));
  return data;
}

export async function cancelAuditDeletionConfirmation(kind: 'content' | 'employee', jobId: string): Promise<{ success: boolean; cancelled: boolean }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'cancel_confirmation', jobKind: kind, jobId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const details = await error.context.clone().json().catch(() => null);
    throw new Error(typeof details?.error === 'string' ? details.error : formatSupabaseError(error));
  }
  if (error || data?.error || data?.success !== true || typeof data?.cancelled !== 'boolean') {
    throw new Error(data?.error || formatSupabaseError(error || new Error('Confirmation cancellation was not confirmed.')));
  }
  return data;
}

export async function executeAuditedDeletion(jobId: string): Promise<{ success: boolean; deleted_events: number; retained_shared_images: number }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'execute_delete', jobId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const details = await error.context.clone().json().catch(() => null);
    throw new Error(typeof details?.error === 'string' ? details.error : formatSupabaseError(error));
  }
  if (error || data?.error || !data?.success) throw new Error(data?.error || formatSupabaseError(error || new Error('Audit deletion was not confirmed.')));
  return data;
}

export async function executeEmployeeArchiveDeletion(jobId: string): Promise<{ retained_shared_images: number }> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'execute_employee_delete', jobId, sessionToken: getAdminFinancialSessionToken() },
  });
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const details = await error.context.clone().json().catch(() => null);
    throw new Error(typeof details?.error === 'string' ? details.error : formatSupabaseError(error));
  }
  if (error || data?.error || !data?.success) throw new Error(data?.error || formatSupabaseError(error || new Error('Employee deletion was not confirmed.')));
  return { retained_shared_images: Number(data.retained_shared_images) || 0 };
}

export async function listPendingEmployeeArchiveDeletions(): Promise<Array<{ job_id: string; file_count: number }>> {
  const { data, error } = await supabase.functions.invoke('content-audit', {
    body: { action: 'pending_employee_deletes', sessionToken: getAdminFinancialSessionToken() },
  });
  if (error || data?.error || !Array.isArray(data)) throw new Error(data?.error || formatSupabaseError(error || new Error('Could not load pending cleanup.')));
  return data;
}

export async function loadAuditedMedia(eventId: string, path: string): Promise<{ url: string; type: string }> {
  const { data, error, response } = await supabase.functions.invoke('content-audit', {
    body: { action: 'media', eventId, path, sessionToken: getAdminFinancialSessionToken() },
  });
  const mediaType = response?.headers.get('X-Audit-Media-Type') ?? '';
  if (error || !(data instanceof Blob) || !/^(image\/(png|jpeg|webp|gif)|video\/mp4)$/.test(mediaType)) {
    throw new Error(formatSupabaseError(error || new Error('The evidence media is unavailable.')));
  }
  return { url: URL.createObjectURL(new Blob([data], { type: mediaType })), type: mediaType };
}
