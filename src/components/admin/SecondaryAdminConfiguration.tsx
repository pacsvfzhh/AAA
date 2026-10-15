import { useCallback, useEffect, useState } from 'react';
import { Building2, CheckCircle, Loader2, Pencil, Save, Shield, XCircle } from 'lucide-react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { Admin } from '../../types';

interface SecondaryAdminConfigurationProps {
  admin: Admin;
}

interface BrandingValues {
  company_name: string;
  currency_unit: string;
}

export default function SecondaryAdminConfiguration({ admin }: SecondaryAdminConfigurationProps) {
  const [formValues, setFormValues] = useState<BrandingValues>({ company_name: '', currency_unit: '' });
  const [savedCustomValues, setSavedCustomValues] = useState<Partial<BrandingValues>>({});
  const [globalDefaults, setGlobalDefaults] = useState<BrandingValues>({ company_name: '', currency_unit: 'USDC' });
  const [brandingMode, setBrandingMode] = useState<'custom' | 'global'>('global');
  const [editBrandingMode, setEditBrandingMode] = useState<'custom' | 'global'>('global');
  const [brandingModeConfigId, setBrandingModeConfigId] = useState<string | null>(null);
  const [loginTitle, setLoginTitle] = useState('');
  const [loginSubtitle, setLoginSubtitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const loadConfigs = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('admin_configs')
        .select('id, admin_id, config_type, config_value')
        .or(`admin_id.eq.${admin.id},admin_id.is.null`)
        .in('config_type', ['company_name', 'currency_unit', 'branding_mode']);
      if (error) throw error;

      const custom: Partial<BrandingValues> = {};
      const global: Partial<BrandingValues> = {};
      const modeConfig = data?.find(config => config.admin_id === admin.id && config.config_type === 'branding_mode');
      data?.forEach(config => {
        if (config.config_type !== 'company_name' && config.config_type !== 'currency_unit') return;
        if (config.admin_id === admin.id) custom[config.config_type] = config.config_value;
        if (config.admin_id === null) global[config.config_type] = config.config_value;
      });

      const mode = modeConfig?.config_value === 'global' || (!modeConfig && !Object.keys(custom).length) ? 'global' : 'custom';
      const defaults = { company_name: global.company_name || '', currency_unit: global.currency_unit || 'USDC' };
      setGlobalDefaults(defaults);
      setSavedCustomValues(custom);
      setFormValues({ company_name: custom.company_name || defaults.company_name, currency_unit: custom.currency_unit || defaults.currency_unit });
      setBrandingMode(mode);
      setEditBrandingMode(mode);
      setBrandingModeConfigId(modeConfig?.id || null);
    } catch (error) {
      console.error('Error loading configs:', error);
      setNotification({ type: 'error', message: '載入管理員設定失敗，請稍後再試。' });
    } finally {
      setLoading(false);
    }
  }, [admin.id]);

  useEffect(() => { void loadConfigs(); }, [loadConfigs]);

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.from('system_configs').select('key, value').in('key', ['login_title', 'login_subtitle']);
      if (error) {
        console.error('Error loading login page settings:', error);
        return;
      }
      setLoginTitle(String(data?.find(config => config.key === 'login_title')?.value || ''));
      setLoginSubtitle(String(data?.find(config => config.key === 'login_subtitle')?.value || ''));
    })();
  }, []);

  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(null), 5000);
    return () => clearTimeout(timer);
  }, [notification]);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    const startedAt = Date.now();
    setSaving(true);
    try {
      const ownValuesChanged = formValues.company_name !== (savedCustomValues.company_name || globalDefaults.company_name)
        || formValues.currency_unit !== (savedCustomValues.currency_unit || globalDefaults.currency_unit);
      const saveOwnValues = ownValuesChanged || (editBrandingMode === 'custom'
        && (!savedCustomValues.company_name || !savedCustomValues.currency_unit));
      let modeConfigId = brandingModeConfigId;

      if (saveOwnValues) {
        if (!formValues.company_name || !formValues.currency_unit) throw new Error('品牌名稱及顯示幣別不可留空');

        if (editBrandingMode === 'global' && !modeConfigId) {
          const { data, error } = await supabase.from('admin_configs')
            .insert({ admin_id: admin.id, config_type: 'branding_mode', config_value: 'global', updated_at: new Date().toISOString() })
            .select('id').single();
          if (error) throw error;
          modeConfigId = data.id;
          setBrandingModeConfigId(data.id);
        }

        for (const [configType, configValue] of Object.entries(formValues)) {
          const record = { config_value: configValue, updated_at: new Date().toISOString() };
          const { error } = savedCustomValues[configType as keyof BrandingValues] !== undefined
            ? await supabase.from('admin_configs').update(record).eq('admin_id', admin.id).eq('config_type', configType)
            : await supabase.from('admin_configs').insert({ admin_id: admin.id, config_type: configType, ...record });
          if (error) throw error;
          setSavedCustomValues(current => ({ ...current, [configType]: configValue }));
        }
      }

      if (editBrandingMode !== brandingMode) {
        if (modeConfigId) {
          const { error } = await supabase.from('admin_configs')
            .update({ config_value: editBrandingMode, updated_at: new Date().toISOString() }).eq('id', modeConfigId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from('admin_configs')
            .insert({ admin_id: admin.id, config_type: 'branding_mode', config_value: editBrandingMode, updated_at: new Date().toISOString() })
            .select('id').single();
          if (error) throw error;
          modeConfigId = data.id;
        }
      }

      setBrandingModeConfigId(modeConfigId);
      setBrandingMode(editBrandingMode);
      setNotification({ type: 'success', message: '設定已儲存。' });
    } catch (error) {
      console.error('Error saving configs:', error);
      setNotification({ type: 'error', message: `儲存設定失敗：${formatSupabaseError(error) || '請稍後再試。'}` });
    } finally {
      const remaining = 700 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-slate-950/40 text-sm text-cyan-100">正在載入設定…</div>;
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto bg-[radial-gradient(ellipse_at_12%_0%,rgba(37,99,235,0.18),transparent_42%),radial-gradient(ellipse_at_92%_75%,rgba(13,148,136,0.12),transparent_42%),linear-gradient(145deg,#0e1b30_0%,#142940_55%,#102639_100%)] text-slate-100">
      {notification && (
        <div role={notification.type === 'error' ? 'alert' : 'status'} className={`fixed right-4 top-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${notification.type === 'success' ? 'border-emerald-400/50 bg-emerald-950 text-emerald-50' : 'border-rose-400/50 bg-rose-950 text-rose-50'}`}>
          {notification.type === 'success' ? <CheckCircle className="h-5 w-5 shrink-0 text-emerald-300" /> : <XCircle className="h-5 w-5 shrink-0 text-rose-300" />}
          <span>{notification.message}</span>
          <button type="button" onClick={() => setNotification(null)} aria-label="關閉提示" className="ml-2 rounded p-1 text-slate-300 hover:text-white">×</button>
        </div>
      )}

      <form onSubmit={handleSave} className="flex w-full flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-cyan-300/25 bg-gradient-to-r from-[#1d3059] via-[#194461] to-[#146071] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_30px_rgba(2,12,27,0.18)] sm:px-7 lg:px-9">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-200/35 bg-gradient-to-br from-cyan-300/25 to-blue-500/20 text-cyan-50 shadow-[0_4px_15px_rgba(8,145,178,0.2)]"><Building2 className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0"><h2 className="text-base font-semibold text-white">我的設定</h2><p className="break-words text-sm text-cyan-100">{admin.username} · 二級管理員</p></div>
          <span className={`ml-auto inline-flex min-h-9 shrink-0 items-center gap-2 rounded-xl border px-2.5 py-1 text-xs font-bold tracking-wide shadow-lg ring-1 ring-inset ${brandingMode === 'global' ? 'border-amber-200 bg-gradient-to-r from-amber-200 via-amber-300 to-yellow-400 text-amber-950 shadow-amber-950/30 ring-white/50' : 'border-cyan-100 bg-gradient-to-r from-sky-200 via-cyan-300 to-teal-300 text-slate-950 shadow-cyan-950/30 ring-white/50'}`}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-slate-950/15">
              {brandingMode === 'global' ? <Shield className="h-4 w-4" aria-hidden="true" /> : <Building2 className="h-4 w-4" aria-hidden="true" />}
            </span>
            目前使用{brandingMode === 'global' ? '超管設定' : '自己設定'}
          </span>
        </div>

        <div className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-5 sm:px-7 sm:py-6 lg:px-9">
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-100"><Shield className="h-4 w-4 text-cyan-300" aria-hidden="true" />登入畫面 <span className="text-xs font-medium text-slate-300">· 僅供查看</span></h3>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              <div className="min-w-0 border-l-2 border-cyan-400/70 pl-4">
                <p className="text-xs font-semibold text-cyan-200">登入標題</p>
                <p className="mt-1.5 break-words text-base font-semibold leading-6 text-white">{loginTitle || '未設定'}</p>
              </div>
              <div className="min-w-0 border-l-2 border-cyan-400/70 pl-4">
                <p className="text-xs font-semibold text-cyan-200">登入副標題</p>
                <p className="mt-1.5 break-words text-base font-semibold leading-6 text-white">{loginSubtitle || '未設定'}</p>
              </div>
            </div>
          </section>

          <section className="border-t border-cyan-200/20 pt-5">
            <h3 className="text-sm font-semibold text-white">設定來源</h3>
            <p className="mt-1 text-xs text-slate-300">目前使用{brandingMode === 'global' ? '超管設定' : '自己設定'}；選擇後按「儲存設定」才會生效。</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <button type="button" aria-pressed={editBrandingMode === 'global'} disabled={saving} onClick={() => setEditBrandingMode('global')} className={`min-h-[82px] rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-100 ${editBrandingMode === 'global' ? 'border-amber-300/85 bg-gradient-to-br from-amber-400/30 via-amber-400/15 to-[#533c24]/30 text-amber-50 shadow-[0_10px_25px_rgba(8,16,31,0.25),inset_0_1px_0_rgba(253,230,138,0.18)] ring-1 ring-amber-300/40' : 'border-slate-500/40 bg-[#102136]/65 text-slate-300 hover:border-amber-300/55 hover:bg-amber-300/[0.08] hover:text-amber-50'}`}>
                <span className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-semibold"><Shield className="h-4 w-4 shrink-0" aria-hidden="true" />使用超管設定</span><span className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-300 px-2 py-0.5 text-[10px] font-bold text-amber-950 ${editBrandingMode === 'global' ? '' : 'invisible'}`}><CheckCircle className="h-3 w-3" aria-hidden="true" />已選擇</span></span>
                <span className="mt-1.5 block text-xs opacity-80">顯示超管的品牌與幣別</span>
              </button>
              <button type="button" aria-pressed={editBrandingMode === 'custom'} disabled={saving} onClick={() => setEditBrandingMode('custom')} className={`min-h-[82px] rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-100 ${editBrandingMode === 'custom' ? 'border-cyan-300/85 bg-gradient-to-br from-blue-400/30 via-cyan-400/15 to-[#164753]/35 text-cyan-50 shadow-[0_10px_25px_rgba(8,16,31,0.25),inset_0_1px_0_rgba(165,243,252,0.18)] ring-1 ring-cyan-300/40' : 'border-slate-500/40 bg-[#102136]/65 text-slate-300 hover:border-cyan-300/55 hover:bg-cyan-300/[0.08] hover:text-cyan-50'}`}>
                <span className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-semibold"><Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />使用自己設定</span><span className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-300 px-2 py-0.5 text-[10px] font-bold text-blue-950 ${editBrandingMode === 'custom' ? '' : 'invisible'}`}><CheckCircle className="h-3 w-3" aria-hidden="true" />已選擇</span></span>
                <span className="mt-1.5 block text-xs opacity-80">顯示自己設定的品牌與幣別</span>
              </button>
            </div>
          </section>

          <section className="border-t border-cyan-200/20 pt-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-cyan-100"><Pencil className="h-4 w-4 text-cyan-300" aria-hidden="true" />自己的設定</h3>
            <p className="mt-1 text-xs leading-5 text-slate-300">自己的品牌與幣別會保留，切換設定來源也不會刪除。</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2.5fr)_minmax(150px,1fr)]">
              <label className="block min-w-0 text-xs font-semibold text-slate-200">品牌名稱
                <input type="text" value={formValues.company_name} onChange={event => setFormValues(current => ({ ...current, company_name: event.target.value }))} required={editBrandingMode === 'custom'} maxLength={50} disabled={saving} placeholder="輸入品牌名稱" className="mt-1.5 h-10 w-full rounded-lg border border-slate-300/80 bg-slate-50 px-3 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-300/40 disabled:opacity-100" />
              </label>
              <label className="block min-w-0 text-xs font-semibold text-slate-200">顯示幣別
                <input type="text" value={formValues.currency_unit} onChange={event => setFormValues(current => ({ ...current, currency_unit: event.target.value.replace(/\s+/g, '') }))} required={editBrandingMode === 'custom'} maxLength={10} disabled={saving} placeholder="例如 USDC" className="mt-1.5 h-10 w-full rounded-lg border border-slate-300/80 bg-slate-50 px-3 text-sm text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-300/40 disabled:opacity-100" />
              </label>
            </div>
          </section>

          <section className="border-t border-cyan-200/20 pt-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-100"><Shield className="h-4 w-4" aria-hidden="true" />超管設定 · 對照</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,2.5fr)_minmax(150px,1fr)]">
              <div className="min-w-0"><p className="text-xs text-amber-100/70">品牌名稱</p><p className="mt-1 break-words text-sm font-bold text-white">{globalDefaults.company_name || '未設定'}</p></div>
              <div className="min-w-0"><p className="text-xs text-amber-100/70">顯示幣別</p><p className="mt-1 break-words text-sm font-bold text-white">{globalDefaults.currency_unit || '未設定'}</p></div>
            </div>
          </section>
        </div>

        <div className="border-t border-cyan-200/40 bg-gradient-to-r from-[#213a59] via-[#1b4c64] to-[#125a62] shadow-[0_-10px_28px_rgba(3,16,31,0.22),inset_0_1px_0_rgba(255,255,255,0.1)]">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-7 lg:px-9">
            <div className="min-w-0">
              <p className="text-xs font-bold text-white">確認變更</p>
              <p className="mt-0.5 text-xs text-cyan-100/85">儲存後才會套用最新設定</p>
            </div>
            <button type="submit" disabled={saving} aria-busy={saving} className="relative ml-auto inline-flex h-10 shrink-0 items-center justify-center gap-2 overflow-hidden rounded-lg border border-blue-200/70 bg-gradient-to-r from-blue-700 to-indigo-700 px-5 text-sm font-bold text-white shadow-[0_6px_18px_rgba(6,30,49,0.4)] transition-all hover:from-blue-600 hover:to-indigo-600 hover:shadow-[0_8px_22px_rgba(6,30,49,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-95">{saving ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{saving ? '儲存中…' : '儲存設定'}{saving && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-cyan-200 motion-reduce:animate-none" />}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
