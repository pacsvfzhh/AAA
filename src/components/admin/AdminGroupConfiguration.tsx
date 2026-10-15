import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Save, Building2, CheckCircle, XCircle, Shield, Loader2, Pencil, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken } from '../../lib/auth';

interface AdminGroup {
  id: string;
  username: string;
  role: string;
  created_at: string;
  brandingMode: 'custom' | 'global';
  brandingModeConfigId: string | null;
  configs: {
    company_name?: string;
    currency_unit?: string;
  };
}

interface ConfigFormValues {
  company_name: string;
  currency_unit: string;
}

export default function AdminGroupConfiguration({ isActive }: { isActive: boolean }) {
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<ConfigFormValues>({ company_name: '', currency_unit: '' });
  const [editBrandingMode, setEditBrandingMode] = useState<'custom' | 'global'>('global');
  const [globalDefaults, setGlobalDefaults] = useState<ConfigFormValues>({
    company_name: '',
    currency_unit: '',
  });
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [loginTitle, setLoginTitle] = useState('');
  const [loginSubtitle, setLoginSubtitle] = useState('');
  const [savingLoginSettings, setSavingLoginSettings] = useState(false);
  const loginTitleRef = useRef<HTMLTextAreaElement>(null);
  const loginSubtitleRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const resizeTextareas = () => {
      for (const textarea of [loginTitleRef.current, loginSubtitleRef.current]) {
        if (!textarea) continue;
        textarea.style.height = '36px';
        textarea.style.height = `${Math.min(52, Math.max(36, textarea.scrollHeight + 2))}px`;
      }
    };

    resizeTextareas();
    window.addEventListener('resize', resizeTextareas);
    return () => window.removeEventListener('resize', resizeTextareas);
  }, [loading, loginTitle, loginSubtitle]);

  useEffect(() => {
    void loadLoginPageSettings();
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const refresh = () => {
      void loadGlobalDefaults();
      void loadGroups();
    };
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 150);
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') scheduleRefresh();
    };

    refresh();
    const channel = supabase.channel('admin-group-settings-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_configs' }, scheduleRefresh)
      .subscribe();
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
      void supabase.removeChannel(channel);
    };
  }, [isActive]);

  const loadLoginPageSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('system_configs')
        .select('key, value')
        .in('key', ['login_title', 'login_subtitle']);

      if (error) throw error;

      data?.forEach(config => {
        if (config.key === 'login_title') {
          setLoginTitle(config.value as string || '');
        } else if (config.key === 'login_subtitle') {
          setLoginSubtitle(config.value as string || '');
        }
      });
    } catch (error) {
      console.error('Error loading login page settings:', error);
    }
  };

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => {
        setNotification(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const loadGlobalDefaults = async (): Promise<ConfigFormValues> => {
    try {
      const { data, error } = await supabase
        .from('admin_configs')
        .select('config_type, config_value')
        .is('admin_id', null)
        .in('config_type', ['company_name', 'currency_unit']);

      if (error) throw error;

      const defaults: Record<string, string> = {};
      data?.forEach(config => {
        defaults[config.config_type] = config.config_value;
      });

      const values = {
        company_name: defaults.company_name || '',
        currency_unit: defaults.currency_unit || 'USDC',
      };
      setGlobalDefaults(values);
      return values;
    } catch (error) {
      console.error('Error loading global defaults:', error);
      return { company_name: '', currency_unit: 'USDC' };
    }
  };

  const loadGroups = async () => {
    try {
      const { data: adminsData, error: adminsError } = await supabase
        .from('admins')
        .select('id, username, role, created_at')
        .in('role', ['super_admin', 'secondary_admin'])
        .order('created_at', { ascending: false });

      if (adminsError) throw adminsError;

      const { data: configsData, error: configsError } = await supabase
        .from('admin_configs')
        .select('id, admin_id, config_type, config_value')
        .not('admin_id', 'is', null)
        .in('config_type', ['company_name', 'currency_unit', 'branding_mode']);

      if (configsError) throw configsError;

      const groupsWithConfigs: AdminGroup[] = (adminsData || []).map((admin) => {
        const adminConfigs = configsData?.filter(c => c.admin_id === admin.id) || [];
        const configs: Record<string, string> = {};
        adminConfigs.filter(config => config.config_type !== 'branding_mode').forEach(config => {
          configs[config.config_type] = config.config_value;
        });
        const modeConfig = adminConfigs.find(config => config.config_type === 'branding_mode');

        return {
          id: admin.id,
          username: admin.username,
          role: admin.role,
          created_at: admin.created_at,
          brandingMode: modeConfig?.config_value === 'global' || (!modeConfig && !Object.keys(configs).length) ? 'global' : 'custom',
          brandingModeConfigId: modeConfig?.id || null,
          configs,
        };
      });

      const sortedGroups = groupsWithConfigs.sort((a, b) => {
        if (a.role === 'super_admin' && b.role !== 'super_admin') return -1;
        if (a.role !== 'super_admin' && b.role === 'super_admin') return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setGroups(sortedGroups);
    } catch (error) {
      console.error('Error loading groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const openEditGroup = (group: AdminGroup) => {
    setEditValues({
      company_name: group.configs.company_name || globalDefaults.company_name,
      currency_unit: group.configs.currency_unit || globalDefaults.currency_unit || 'USDC',
    });
    setEditBrandingMode(group.brandingMode);
    setEditingGroupId(group.id);
  };

  const handleSave = async (e: React.FormEvent, groupId: string) => {
    e.preventDefault();
    const values = editValues;
    setSavingGroupId(groupId);

    try {
      const savedGroup = groups.find(group => group.id === groupId)!;
      const nextMode = savedGroup.role === 'super_admin' ? 'custom' : editBrandingMode;
      const ownValuesChanged = values.company_name !== (savedGroup.configs.company_name || globalDefaults.company_name)
        || values.currency_unit !== (savedGroup.configs.currency_unit || globalDefaults.currency_unit || 'USDC');
      const saveOwnValues = ownValuesChanged || ((savedGroup.role === 'super_admin' || nextMode === 'custom')
        && (!savedGroup.configs.company_name || !savedGroup.configs.currency_unit));
      let modeConfigId = savedGroup.brandingModeConfigId;

      if (saveOwnValues) {
        for (const [configType, configValue] of Object.entries(values)) {
          if (!configValue) throw new Error(`${configType === 'company_name' ? '品牌名稱' : '顯示幣別'}不可留空`);
        }

        if (savedGroup.role === 'secondary_admin' && nextMode === 'global' && !modeConfigId) {
          const { data, error } = await supabase.from('admin_configs')
            .insert({ admin_id: groupId, config_type: 'branding_mode', config_value: 'global', updated_at: new Date().toISOString() })
            .select('id').single();
          if (error) throw error;
          modeConfigId = data.id;
          setGroups(current => current.map(group => group.id === groupId ? { ...group, brandingModeConfigId: data.id } : group));
        }

        const configRecords = Object.entries(values).map(([configType, configValue]) => ({
          admin_id: groupId,
          config_type: configType,
          config_value: configValue,
          updated_at: new Date().toISOString(),
        }));
        const { error: upsertError } = await supabase.from('admin_configs')
          .upsert(configRecords, { onConflict: 'admin_id,config_type' });
        if (upsertError) throw upsertError;
      }

      if (savedGroup.role === 'super_admin' && (saveOwnValues
        || values.company_name !== globalDefaults.company_name
        || values.currency_unit !== globalDefaults.currency_unit)) {
        for (const [configType, configValue] of Object.entries(values)) {
          const record = { config_value: configValue, updated_at: new Date().toISOString() };
          const { data, error } = await supabase.from('admin_configs')
            .update(record).is('admin_id', null).eq('config_type', configType).select('id');
          if (error) throw error;
          if (!data?.length) {
            const { error: insertError } = await supabase.from('admin_configs')
              .insert({ admin_id: null, config_type: configType, ...record });
            if (insertError) throw insertError;
          }
        }
        setGlobalDefaults(values);
      }

      if (nextMode !== savedGroup.brandingMode) {
        if (modeConfigId) {
          const { error } = await supabase.from('admin_configs')
            .update({ config_value: nextMode, updated_at: new Date().toISOString() }).eq('id', modeConfigId);
          if (error) throw error;
        } else if (savedGroup.role === 'secondary_admin') {
          const { data, error } = await supabase.from('admin_configs')
            .insert({ admin_id: groupId, config_type: 'branding_mode', config_value: nextMode, updated_at: new Date().toISOString() })
            .select('id').single();
          if (error) throw error;
          modeConfigId = data.id;
        }
      }

      setGroups(current => current.map(group => group.id === groupId ? {
        ...group, brandingMode: nextMode, brandingModeConfigId: modeConfigId,
        configs: saveOwnValues ? { ...values } : group.configs,
      } : group));
      setEditingGroupId(null);

      setNotification({
        type: 'success',
        message: `「${groups.find(group => group.id === groupId)?.username}」團隊設定已儲存。`,
      });
    } catch (error: unknown) {
      console.error('Error saving config:', error);
      setNotification({
        type: 'error',
        message: '儲存團隊設定失敗，請檢查欄位後再試。',
      });
    } finally {
      setSavingGroupId(null);
    }
  };

  const handleSaveLoginSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLoginSettings(true);

    try {
      const updates = [
        { key: 'login_title', value: loginTitle },
        { key: 'login_subtitle', value: loginSubtitle }
      ];

      const token = getAdminFinancialSessionToken();
      for (const update of updates) {
        const { error } = await supabase.rpc('admin_save_shared_system_config', {
          p_admin_session_token: token,
          p_key: update.key,
          p_value: update.value,
        });

        if (error) throw error;
      }

      setNotification({
        type: 'success',
        message: '登入畫面設定已儲存。',
      });
    } catch (error: unknown) {
      console.error('Error saving login settings:', error);
      setNotification({
        type: 'error',
        message: '儲存登入畫面設定失敗，請稍後再試。',
      });
    } finally {
      setSavingLoginSettings(false);
    }
  };

  const editingGroup = groups.find(group => group.id === editingGroupId);

  if (loading) {
    return (
      <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-slate-950/40 text-sm text-cyan-100">
        正在載入設定…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-slate-950/45 text-slate-100">
      {notification && (
        <div role={notification.type === 'error' ? 'alert' : 'status'} className={`fixed right-4 top-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${notification.type === 'success' ? 'border-emerald-400/50 bg-emerald-950 text-emerald-50' : 'border-rose-400/50 bg-rose-950 text-rose-50'}`}>
          {notification.type === 'success' ? <CheckCircle className="h-5 w-5 shrink-0 text-emerald-300" /> : <XCircle className="h-5 w-5 shrink-0 text-rose-300" />}
          <span>{notification.message}</span>
          <button type="button" onClick={() => setNotification(null)} aria-label="關閉提示" className="ml-2 rounded p-1 text-slate-300 hover:text-white">×</button>
        </div>
      )}

      <section className="grid shrink-0 gap-4 border-y border-violet-300/20 bg-gradient-to-r from-[#302052] via-[#1c3262] to-[#12465a] px-4 py-4 shadow-[inset_0_1px_0_rgba(221,214,254,0.12)] sm:px-7 lg:grid-cols-[190px_minmax(0,1fr)] lg:items-center lg:gap-6 lg:px-9 xl:grid-cols-[220px_minmax(0,1fr)]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400/35 to-cyan-400/20 text-white shadow-sm shadow-indigo-950/40 ring-1 ring-inset ring-white/25"><Shield className="h-[18px] w-[18px]" /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">登入畫面</h2>
            <p className="mt-0.5 text-xs text-violet-100/90">標題與副標題</p>
          </div>
        </div>
        <form onSubmit={handleSaveLoginSettings} className="grid min-w-0 gap-3 sm:grid-cols-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <label className="block min-w-0 text-xs font-semibold tracking-wide text-slate-100">登入標題
            <textarea ref={loginTitleRef} value={loginTitle} onChange={(event) => setLoginTitle(event.target.value.replace(/[\r\n]+/g, ' '))} required maxLength={100} rows={1} placeholder="輸入登入頁標題" className="login-settings-scroll mt-1 block h-9 max-h-[52px] w-full resize-none overflow-y-auto rounded-lg border border-slate-300 bg-slate-50 px-3 py-[5px] text-sm leading-5 text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-500 focus:border-violet-400 focus:bg-white focus:ring-2 focus:ring-violet-400/20" />
          </label>
          <label className="block min-w-0 text-xs font-semibold tracking-wide text-slate-100">登入副標題
            <textarea ref={loginSubtitleRef} value={loginSubtitle} onChange={(event) => setLoginSubtitle(event.target.value.replace(/[\r\n]+/g, ' '))} required maxLength={200} rows={1} placeholder="輸入登入頁副標題" className="login-settings-scroll mt-1 block h-9 max-h-[52px] w-full resize-none overflow-y-auto rounded-lg border border-slate-300 bg-slate-50 px-3 py-[5px] text-sm leading-5 text-slate-900 shadow-sm outline-none transition-colors placeholder:text-slate-500 focus:border-violet-400 focus:bg-white focus:ring-2 focus:ring-violet-400/20" />
          </label>
          <button type="submit" disabled={savingLoginSettings} aria-busy={savingLoginSettings} className="inline-flex h-9 items-center justify-center gap-2 self-end rounded-lg border border-white/20 bg-gradient-to-r from-violet-600 to-blue-600 px-4 text-xs font-semibold text-white shadow-md shadow-indigo-950/30 transition-all hover:from-violet-500 hover:to-blue-500 disabled:cursor-wait disabled:opacity-80 sm:col-span-2 md:col-span-1">{savingLoginSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}{savingLoginSettings ? '儲存中…' : '儲存設定'}</button>
        </form>
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        {groups.length ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="hidden shrink-0 gap-3 border-b border-cyan-200/30 bg-gradient-to-r from-[#253565] via-[#215075] to-[#155867] px-4 py-3 text-xs font-semibold tracking-wide text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] sm:px-7 lg:grid lg:grid-cols-[minmax(105px,1fr)_minmax(138px,1fr)_minmax(170px,2fr)_minmax(88px,.75fr)_minmax(85px,.7fr)] lg:px-9">
              <span>管理員</span><span>設定來源</span><span>品牌名稱</span><span>顯示幣別</span><span>操作</span>
            </div>
            <div className="admin-team-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain bg-slate-950/15">
              {groups.map(group => {
                const isSuperAdmin = group.role === 'super_admin';
                const usesSuperSettings = isSuperAdmin || group.brandingMode === 'global';
                const activeValues = group.brandingMode === 'global' ? globalDefaults : {
                  company_name: group.configs.company_name || globalDefaults.company_name,
                  currency_unit: group.configs.currency_unit || globalDefaults.currency_unit || 'USDC',
                };
                return (
                  <div key={group.id} className={`group relative isolate grid min-w-0 gap-2 border-b border-cyan-300/10 px-4 py-3 transition-[background-color,border-color,box-shadow] duration-200 hover:z-[1] hover:border-cyan-300/35 hover:shadow-[inset_0_1px_0_rgba(125,211,252,0.14),inset_0_-1px_0_rgba(125,211,252,0.12)] sm:grid-cols-2 sm:gap-3 sm:px-7 lg:grid-cols-[minmax(105px,1fr)_minmax(138px,1fr)_minmax(170px,2fr)_minmax(88px,.75fr)_minmax(85px,.7fr)] lg:items-center lg:px-9 ${isSuperAdmin ? 'bg-gradient-to-r from-amber-400/[0.08] via-slate-900/25 to-slate-900/15 hover:from-amber-400/[0.16] hover:via-[#243a4a] hover:to-[#17435b]' : 'bg-gradient-to-r from-blue-400/[0.05] via-slate-900/25 to-slate-900/15 hover:from-blue-400/[0.18] hover:via-[#233f58] hover:to-[#12536b]'}`}>
                    <span aria-hidden="true" className={`pointer-events-none absolute inset-y-3 left-0 w-[3px] rounded-r-full transition-all duration-200 group-hover:inset-y-2 group-hover:w-1 ${isSuperAdmin ? 'bg-amber-400/60 group-hover:bg-amber-300' : 'bg-sky-400/45 group-hover:bg-cyan-300'}`} />
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-[background-color,box-shadow] duration-200 ${isSuperAdmin ? 'bg-amber-400/15 text-amber-200 ring-amber-300/20 group-hover:bg-amber-400/25 group-hover:shadow-[0_0_14px_rgba(251,191,36,0.16)]' : 'bg-blue-400/15 text-blue-200 ring-blue-300/20 group-hover:bg-blue-400/25 group-hover:shadow-[0_0_14px_rgba(56,189,248,0.18)]'}`}><Building2 className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white" title={group.username}>{group.username}</p>
                        <p className="text-[11px] text-slate-400">{group.role === 'super_admin' ? '超級管理員' : '二級管理員'}</p>
                      </div>
                    </div>
                    <div className="min-w-0 self-center">
                      <span className="mb-1 block text-xs font-medium text-slate-300 lg:sr-only">設定來源</span>
                      <span className={`inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-2 text-[11px] font-semibold shadow-sm ${usesSuperSettings ? 'border-amber-300/60 bg-gradient-to-r from-amber-400/25 to-yellow-500/15 text-amber-100 shadow-amber-500/15' : 'border-blue-300/60 bg-gradient-to-r from-blue-500/30 to-cyan-400/15 text-blue-100 shadow-blue-500/15'}`}>
                        {usesSuperSettings ? <Shield className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Building2 className="h-3 w-3 shrink-0" aria-hidden="true" />}
                        <span>{isSuperAdmin ? '超管設定' : group.brandingMode === 'custom' ? '使用自己設定' : '使用超管設定'}</span>
                      </span>
                    </div>
                    <div className="min-w-0 text-xs text-slate-300"><span className="lg:sr-only">品牌名稱</span>
                      <span className="block truncate text-sm font-medium text-slate-100 lg:leading-8" title={activeValues.company_name}>{activeValues.company_name || '未設定'}</span>
                    </div>
                    <div className="min-w-0 text-xs text-slate-300"><span className="lg:sr-only">顯示幣別</span>
                      <span className="block truncate text-sm font-medium text-slate-100 lg:leading-8" title={activeValues.currency_unit}>{activeValues.currency_unit || '未設定'}</span>
                    </div>
                    <div className="flex items-center sm:col-span-2 lg:col-span-1">
                      <button type="button" onClick={() => openEditGroup(group)} disabled={savingGroupId !== null} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-3 text-xs font-semibold text-white shadow-sm shadow-blue-950/40 transition-all hover:from-cyan-400 hover:to-blue-500 hover:shadow-md hover:shadow-cyan-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"><Pencil className="h-3.5 w-3.5" aria-hidden="true" />編輯</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : <p className="px-4 py-10 text-sm text-slate-400 sm:px-7 lg:px-9">目前沒有管理員。</p>}
      </section>

      {editingGroup && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-5">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-group-title"
            onSubmit={(event) => void handleSave(event, editingGroup.id)}
            onKeyDown={(event) => { if (event.key === 'Escape' && savingGroupId === null) setEditingGroupId(null); }}
            className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-cyan-300/25 bg-[#17283d] shadow-2xl shadow-slate-950/70"
          >
            <div className="flex items-start justify-between gap-4 border-b border-cyan-300/20 bg-gradient-to-r from-[#253565] via-[#215075] to-[#155867] px-5 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-cyan-100"><Building2 className="h-5 w-5" aria-hidden="true" /></span>
                <div className="min-w-0">
                  <h2 id="edit-group-title" className="text-base font-semibold text-white">編輯管理員設定</h2>
                  <p className="break-words text-sm text-cyan-100">{editingGroup.username} · {editingGroup.role === 'super_admin' ? '超級管理員' : '二級管理員'}</p>
                </div>
              </div>
              <button type="button" onClick={() => setEditingGroupId(null)} disabled={savingGroupId !== null} aria-label="關閉編輯面板" className="rounded-lg p-1.5 text-cyan-100/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"><X className="h-5 w-5" /></button>
            </div>

            <div className="space-y-5 px-5 py-5 sm:px-7 sm:py-6">
              {editingGroup.role !== 'super_admin' && (
                <section>
                  <h3 className="text-sm font-semibold text-white">設定來源</h3>
                  <p className="mt-1 text-xs text-slate-300">目前使用{editingGroup.brandingMode === 'global' ? '超管設定' : '自己設定'}；選擇後按「儲存設定」才會生效。</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <button type="button" aria-pressed={editBrandingMode === 'global'} disabled={savingGroupId !== null} onClick={() => setEditBrandingMode('global')} className={`min-h-[82px] rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-50 ${editBrandingMode === 'global' ? 'border-amber-300 bg-gradient-to-br from-amber-500/35 via-amber-500/20 to-yellow-400/15 text-amber-50 shadow-lg shadow-amber-950/30 ring-2 ring-amber-300/55' : 'border-slate-600/45 bg-slate-950/25 text-slate-400 hover:border-amber-400/40 hover:bg-amber-400/[0.06] hover:text-amber-100'}`}>
                      <span className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-semibold"><Shield className="h-4 w-4 shrink-0" aria-hidden="true" />使用超管設定</span><span className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-300 px-2 py-0.5 text-[10px] font-bold text-amber-950 ${editBrandingMode === 'global' ? '' : 'invisible'}`}><CheckCircle className="h-3 w-3" aria-hidden="true" />已選擇</span></span>
                      <span className="mt-1.5 block text-xs opacity-80">顯示超管的品牌與幣別</span>
                    </button>
                    <button type="button" aria-pressed={editBrandingMode === 'custom'} disabled={savingGroupId !== null} onClick={() => setEditBrandingMode('custom')} className={`min-h-[82px] rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-50 ${editBrandingMode === 'custom' ? 'border-blue-300 bg-gradient-to-br from-blue-500/40 via-blue-500/25 to-cyan-400/15 text-blue-50 shadow-lg shadow-blue-950/30 ring-2 ring-blue-300/55' : 'border-slate-600/45 bg-slate-950/25 text-slate-400 hover:border-blue-400/40 hover:bg-blue-400/[0.06] hover:text-blue-100'}`}>
                      <span className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-semibold"><Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />使用自己設定</span><span className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-300 px-2 py-0.5 text-[10px] font-bold text-blue-950 ${editBrandingMode === 'custom' ? '' : 'invisible'}`}><CheckCircle className="h-3 w-3" aria-hidden="true" />已選擇</span></span>
                      <span className="mt-1.5 block text-xs opacity-80">顯示此管理員的自訂內容</span>
                    </button>
                  </div>
                </section>
              )}
              <section className={editingGroup.role === 'super_admin' ? '' : 'border-t border-slate-500/40 pt-5'}>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-blue-100"><Pencil className="h-4 w-4" aria-hidden="true" />{editingGroup.role === 'super_admin' ? '超管自己的設定' : '此管理員自己的設定'}</h3>
                {editingGroup.role !== 'super_admin' && <p className="mt-1 text-xs leading-5 text-blue-200/80">自己的品牌與幣別會保留，切換設定來源也不會刪除。</p>}
                <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2.5fr)_minmax(150px,1fr)]">
                  <label className="block min-w-0 text-xs font-semibold text-slate-200">品牌名稱
                    <input type="text" autoFocus value={editValues.company_name} onChange={(event) => setEditValues(current => ({ ...current, company_name: event.target.value }))} required={editingGroup.role === 'super_admin' || editBrandingMode === 'custom'} maxLength={50} disabled={savingGroupId !== null} placeholder="輸入品牌名稱" className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-300/40 disabled:opacity-60" />
                  </label>
                  <label className="block min-w-0 text-xs font-semibold text-slate-200">顯示幣別
                    <input type="text" value={editValues.currency_unit} onChange={(event) => setEditValues(current => ({ ...current, currency_unit: event.target.value.replace(/\s+/g, '') }))} required={editingGroup.role === 'super_admin' || editBrandingMode === 'custom'} maxLength={10} disabled={savingGroupId !== null} placeholder="例如 USDC" className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm text-slate-900 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-300/40 disabled:opacity-60" />
                  </label>
                </div>
              </section>

              <section className="border-t border-slate-500/40 pt-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-100"><Shield className="h-4 w-4" aria-hidden="true" />超管設定 · 對照</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,2.5fr)_minmax(150px,1fr)]">
                  <div className="min-w-0">
                    <p className="text-xs text-amber-100/70">品牌名稱</p>
                    <p className="mt-1 break-words text-sm font-medium text-slate-100">{globalDefaults.company_name || '未設定'}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-amber-100/70">顯示幣別</p>
                    <p className="mt-1 break-words text-sm font-medium text-slate-100">{globalDefaults.currency_unit || '未設定'}</p>
                  </div>
                </div>
              </section>
            </div>

            <div className="flex justify-end gap-2 border-t border-white/10 bg-slate-950/25 px-5 py-4 sm:px-6">
              <button type="button" onClick={() => setEditingGroupId(null)} disabled={savingGroupId !== null} className="h-9 rounded-lg border border-slate-500/60 px-4 text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50">取消</button>
              <button type="submit" disabled={savingGroupId !== null} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-4 text-sm font-semibold text-white hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50">{savingGroupId === editingGroup.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{savingGroupId === editingGroup.id ? '儲存中…' : '儲存設定'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
