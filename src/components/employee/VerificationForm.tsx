import { useState, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Upload, User, CreditCard, Phone, Mail, ShieldCheck, Check, X, Info, FileText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getCurrentTimestamp } from '../../lib/dateUtils';
import { validateImageFile } from '../../lib/fileValidation';
import { useLanguage } from '../../lib/i18n/context';

interface VerificationFormProps {
  employeeId: string;
  onVerificationComplete: () => void;
  onClose: () => void;
  existingRequest?: {
    id: string;
    real_name: string;
    wallet_address: string;
    phone: string;
    email: string;
    id_front_url?: string | null;
    id_back_url?: string | null;
    selfie_url?: string | null;
  } | null;
}

const INPUT_CLASS = 'h-12 w-full rounded-xl border border-slate-200 bg-slate-50 pl-11 pr-3.5 text-base text-slate-900 placeholder-slate-400 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 sm:h-11 sm:text-sm';

export default function VerificationForm({ employeeId, onVerificationComplete, onClose, existingRequest }: VerificationFormProps) {
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    realName: existingRequest?.real_name || '',
    idNumber: existingRequest?.wallet_address || '',
    phone: existingRequest?.phone || '',
    address: existingRequest?.email || '',
  });
  const [files, setFiles] = useState<{
    idFront: File | null;
    idBack: File | null;
    selfie: File | null;
  }>({ idFront: null, idBack: null, selfie: null });
  const [uploadProgress, setUploadProgress] = useState<{
    message: string;
    current: number;
    total: number;
    fileName: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const uploadFile = async (file: File, path: string, label: string): Promise<string> => {
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${employeeId}-${Date.now()}.${fileExt}`;
      const filePath = `${path}/${fileName}`;

      const chunks = Math.ceil(file.size / (1024 * 100));
      for (let i = 0; i <= chunks; i++) {
        setUploadProgress({
          message: `${t.verification.uploadingFile} ${label}`,
          current: i,
          total: chunks,
          fileName: file.name
        });
        if (i < chunks) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      const { error: uploadError } = await supabase.storage
        .from('verification-documents')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: true
        });

      if (uploadError) {
        console.error('Upload error:', uploadError);
        throw new Error(`Failed to upload file: ${uploadError.message}`);
      }

      const { data: { publicUrl } } = supabase.storage
        .from('verification-documents')
        .getPublicUrl(filePath);

      return publicUrl;
    } catch (error: unknown) {
      console.error('File upload error:', error);
      throw error;
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>, type: 'idFront' | 'idBack' | 'selfie') => {
    const file = e.target.files?.[0];
    if (file) {
      const validation = await validateImageFile(file);

      if (!validation.valid) {
        setMessage({ type: 'error', text: validation.error || t.verification.fileValidationFailed });
        e.target.value = '';
        return;
      }

      setFiles({ ...files, [type]: file });
      setMessage(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setLoading(true);

    try {
      let idFrontUrl = existingRequest?.id_front_url || null;
      let idBackUrl = existingRequest?.id_back_url || null;
      let selfieUrl = existingRequest?.selfie_url || null;

      if (files.idFront) {
        idFrontUrl = await uploadFile(files.idFront, 'id-front', t.verification.doc1);
      }
      if (files.idBack) {
        idBackUrl = await uploadFile(files.idBack, 'id-back', t.verification.doc2);
      }
      if (files.selfie) {
        selfieUrl = await uploadFile(files.selfie, 'selfie', t.verification.doc3);
      }

      setUploadProgress({
        message: t.verification.submittingVerification,
        current: 100,
        total: 100,
        fileName: t.verification.finalizing
      });

      const { data: existingPending } = await supabase
        .from('verification_requests')
        .select('id')
        .eq('user_id', employeeId)
        .eq('status', 'pending')
        .maybeSingle();

      if (existingRequest || existingPending) {
        const targetId = existingRequest?.id || existingPending?.id;
        const { error } = await supabase
          .from('verification_requests')
          .update({
            real_name: formData.realName,
            wallet_address: formData.idNumber,
            phone: formData.phone,
            email: formData.address,
            id_front_url: idFrontUrl,
            id_back_url: idBackUrl,
            selfie_url: selfieUrl,
            status: 'pending',
            audit_remark: null,
            audited_by: null,
            audited_at: null,
            updated_at: getCurrentTimestamp(),
          })
          .eq('id', targetId!);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('verification_requests')
          .insert({
            user_id: employeeId,
            real_name: formData.realName,
            wallet_address: formData.idNumber,
            phone: formData.phone,
            email: formData.address,
            id_front_url: idFrontUrl,
            id_back_url: idBackUrl,
            selfie_url: selfieUrl,
            status: 'pending',
          });

        if (error) throw error;
      }

      setMessage({ type: 'success', text: t.verification.submitSuccess });

      setTimeout(() => {
        onVerificationComplete();
      }, 2000);
    } catch (error: unknown) {
      console.error('Error submitting verification:', error);
      const errorMessage = error instanceof Error ? error.message : t.verification.submitError;
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      setLoading(false);
      setUploadProgress(null);
    }
  };

  // Same lock as the other employee popups: the page behind must not scroll or bounce on phones.
  useLayoutEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    const previous = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, overflow: body.style.overflow };
    Object.assign(body.style, { position: 'fixed', top: `-${scrollY}px`, left: '0', right: '0', overflow: 'hidden' });
    return () => {
      Object.assign(body.style, previous);
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, onClose]);

  const uploads = [
    { key: 'idFront' as const, inputId: 'id-front-upload', accept: 'image/jpeg,image/jpg,image/png,application/pdf', label: t.verification.doc1, previous: existingRequest?.id_front_url },
    { key: 'idBack' as const, inputId: 'id-back-upload', accept: 'image/jpeg,image/jpg,image/png,application/pdf', label: t.verification.doc2, previous: existingRequest?.id_back_url },
    { key: 'selfie' as const, inputId: 'selfie-upload', accept: 'image/jpeg,image/jpg,image/png', label: t.verification.doc3, previous: existingRequest?.selfie_url },
  ];

  const benefits = [t.verification.enableWithdrawals, t.verification.increaseSecurity, t.verification.complyRegulations, t.verification.protectEarnings];

  return createPortal(
    <div
      className="employee-modal-backdrop fixed inset-0 z-[10000] flex justify-center bg-slate-900/55 sm:items-center sm:p-6"
      style={{ overscrollBehavior: 'contain' }}
      onClick={() => { if (!loading) onClose(); }}
    >
      {/* Phones: full screen. Tablets and up: a centred card that never exceeds the viewport. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="verification-title"
        onClick={(e) => e.stopPropagation()}
        className="employee-modal-surface verification-modal flex h-[100dvh] w-full flex-col overflow-hidden bg-slate-50 sm:h-auto sm:max-h-[min(880px,calc(100dvh-48px))] sm:max-w-[620px] sm:rounded-3xl sm:shadow-[0_30px_80px_-30px_rgba(15,23,42,0.55)] lg:max-w-[680px]"
      >
        <div
          className="relative shrink-0 overflow-hidden bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-600 px-4 pb-5 text-white sm:px-6"
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}
        >
          <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-white/10" aria-hidden="true" />
          <div className="pointer-events-none absolute -bottom-20 right-16 h-36 w-36 rounded-full bg-cyan-300/15" aria-hidden="true" />
          <div className="relative flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="verification-title" className="text-lg font-bold leading-snug">{existingRequest ? t.verification.resubmit : t.verification.title}</h2>
              <p className="mt-0.5 text-[13px] leading-snug text-blue-100">{existingRequest ? t.verification.resetDesc : t.verification.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              aria-label={t.common.close}
              className="verification-form-close emp-close-btn flex shrink-0 items-center justify-center border border-white/20 bg-white/15 transition-colors hover:bg-white/25 disabled:opacity-50"
            >
              <X />
            </button>
          </div>
        </div>

        <form id="verification-form" onSubmit={handleSubmit} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          <section className="rounded-2xl bg-white p-4 ring-1 ring-blue-100">
            <p className="text-sm font-bold text-slate-900">{t.verification.whyVerify}</p>
            <ul className="mt-3 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
              {benefits.map(item => (
                <li key={item} className="flex items-start gap-2 text-[13px] leading-snug text-slate-600">
                  <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-600"><Check className="h-2.5 w-2.5" strokeWidth={3} /></span>
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3.5 rounded-2xl bg-white p-4 ring-1 ring-slate-200/80">
            <p className="text-sm font-bold text-slate-900">{t.verification.personalInfo}</p>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-slate-700">{t.verification.fullName}</span>
              <span className="relative block">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input type="text" value={formData.realName} onChange={(e) => setFormData({ ...formData, realName: e.target.value })} required autoComplete="name" className={INPUT_CLASS} placeholder={t.verification.fullNamePlaceholder} />
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-slate-700">{t.verification.walletAddress}</span>
              <span className="relative block">
                <CreditCard className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                <input type="text" value={formData.idNumber} onChange={(e) => setFormData({ ...formData, idNumber: e.target.value })} required autoComplete="off" spellCheck={false} className={`${INPUT_CLASS} font-mono`} placeholder={t.verification.walletAddressPlaceholder} />
              </span>
              <span className="mt-1.5 flex items-start gap-1.5 text-xs leading-snug text-slate-500">
                <Info className="mt-px h-3.5 w-3.5 shrink-0 text-blue-500" />
                {t.verification.walletAddressHint}
              </span>
            </label>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-slate-700">{t.verification.phoneNumber}</span>
                <span className="relative block">
                  <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                  <input type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} required autoComplete="tel" className={INPUT_CLASS} placeholder={t.verification.phonePlaceholder} />
                </span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-semibold text-slate-700">{t.verification.email}</span>
                <span className="relative block">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                  <input type="email" value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} required autoComplete="email" className={INPUT_CLASS} placeholder={t.verification.emailPlaceholder} />
                </span>
              </label>
            </div>
          </section>

          <section className="rounded-2xl bg-white p-4 ring-1 ring-slate-200/80">
            <p className="text-sm font-bold text-slate-900">
              {t.verification.documentsUpload} <span className="text-xs font-medium text-slate-400">{t.verification.optional}</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{t.verification.documentsUploadDesc}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
              {uploads.map(({ key, inputId, accept, label, previous }) => {
                const file = files[key];
                return (
                  <div key={key}>
                    <input type="file" accept={accept} onChange={(e) => handleFileChange(e, key)} className="hidden" id={inputId} />
                    <label
                      htmlFor={inputId}
                      className={`group flex min-h-[92px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-2 text-center transition-colors ${
                        file ? 'border-emerald-300 bg-emerald-50/60' : previous ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40'
                      }`}
                    >
                      {file ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-emerald-500" />
                          <span className="line-clamp-2 break-all text-[11px] text-emerald-700">{file.name}</span>
                        </>
                      ) : previous ? (
                        <>
                          <CheckCircle className="h-5 w-5 text-blue-500" />
                          <span className="text-[11px] text-blue-600">{t.verification.previouslyUploaded}</span>
                        </>
                      ) : (
                        <>
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-400 shadow-sm ring-1 ring-slate-200 transition-colors group-hover:text-blue-500">
                            <Upload className="h-4 w-4" />
                          </span>
                          <span className="text-[11px] font-medium text-slate-500 group-hover:text-blue-600">{label}</span>
                        </>
                      )}
                    </label>
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 text-center text-[11px] text-slate-400">{t.verification.fileFormatHint}</p>
          </section>

          {uploadProgress && (
            <div className="space-y-2.5 rounded-2xl bg-blue-50 p-4 ring-1 ring-blue-200">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-blue-700">
                  <Upload className="h-4 w-4 shrink-0 animate-pulse" />
                  <span className="truncate">{uploadProgress.message}</span>
                </span>
                <span className="text-xs font-bold text-blue-600">{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-blue-100">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300 ease-out" style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }} />
              </div>
              <p className="truncate text-xs text-slate-500">{uploadProgress.fileName}</p>
            </div>
          )}

          {message && (
            <div role={message.type === 'error' ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm ring-1 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200'}`}>
              {message.text}
            </div>
          )}

          <div className="flex items-start gap-2.5 rounded-2xl bg-amber-50 p-3.5 ring-1 ring-amber-200/80">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 text-xs leading-relaxed text-amber-800">
              <p className="font-semibold">{t.verification.importantNotice}</p>
              <p className="mt-0.5 text-amber-700">{t.verification.importantNoticeMsg}</p>
            </div>
          </div>
        </form>

        <div
          className="flex shrink-0 gap-2.5 border-t border-slate-200 bg-white px-4 pt-3 sm:px-6 sm:pt-4"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="hidden min-h-[46px] rounded-xl px-5 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-50 disabled:opacity-50 sm:block"
          >
            {t.common.cancel}
          </button>
          <button
            type="submit"
            form="verification-form"
            disabled={loading}
            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 text-[15px] font-bold text-white shadow-lg shadow-blue-600/25 transition-all hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CheckCircle className="h-[18px] w-[18px]" />
            {loading ? t.verification.submitting : existingRequest ? t.verification.resubmit : t.verification.submit}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
