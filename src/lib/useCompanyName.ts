import { useState, useEffect, useRef } from 'react';
import { supabase, supabaseConfigurationError } from './supabase';

const CACHE_KEY_PREFIX = 'cached_company_name';
const DEFAULT_COMPANY_NAME = 'AAA SERVICE';

function getCacheKey(adminId?: string | null): string {
  if (adminId === null || adminId === undefined) {
    return `${CACHE_KEY_PREFIX}:global`;
  }
  return `${CACHE_KEY_PREFIX}:${adminId}`;
}

function readCachedName(adminId?: string | null): string {
  try {
    const specific = localStorage.getItem(getCacheKey(adminId));
    if (specific) return specific;
    const global = localStorage.getItem(`${CACHE_KEY_PREFIX}:global`);
    if (global) return global;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall through
  }
  return '';
}

function writeCachedName(adminId: string | null | undefined, value: string) {
  try {
    localStorage.setItem(getCacheKey(adminId), value);
  } catch {
    // ignore
  }
}

export function useCompanyName(adminId?: string | null) {
  const [companyName, setCompanyName] = useState<string>(() => readCachedName(adminId) || DEFAULT_COMPANY_NAME);
  const [loading, setLoading] = useState(true);
  const loadCompanyNameRef = useRef<{
    adminId: string | null | undefined;
    load: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    setCompanyName(readCachedName(adminId) || DEFAULT_COMPANY_NAME);

    if (supabaseConfigurationError) {
      setLoading(false);
      return;
    }

    void loadCompanyNameRef.current?.load();

    const channel = supabase
      .channel(`company-name-changes-${adminId || 'global'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'admin_configs',
          filter: "config_type=eq.company_name"
        },
        () => { void loadCompanyNameRef.current?.load(); }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'admin_configs',
          filter: 'config_type=eq.branding_mode'
        },
        () => { void loadCompanyNameRef.current?.load(); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [adminId]);

  useEffect(() => {
    document.title = '工作平台';
  }, [companyName]);

  const loadCompanyName = async () => {
    try {
      if (adminId === null || adminId === undefined) {
        const { data, error } = await supabase
          .from('admin_configs')
          .select('config_value')
          .eq('config_type', 'company_name')
          .is('admin_id', null)
          .maybeSingle();

        if (error) {
          console.warn('[Company Name] Unable to load company name:', error);
          return;
        }

        if (loadCompanyNameRef.current?.adminId !== adminId) return;
        if (data?.config_value) {
          setCompanyName(data.config_value);
          writeCachedName(null, data.config_value);
        }
      } else {
        const { data, error } = await supabase
          .from('admin_configs')
          .select('admin_id, config_type, config_value')
          .in('config_type', ['company_name', 'branding_mode'])
          .or(`admin_id.eq.${adminId},admin_id.is.null`);

        if (error) {
          console.warn('[Company Name] Unable to load company name:', error);
          return;
        }
        if (loadCompanyNameRef.current?.adminId !== adminId) return;

        const adminConfig = data?.find(c => c.admin_id === adminId && c.config_type === 'company_name');
        const globalConfig = data?.find(c => c.admin_id === null && c.config_type === 'company_name');
        const useGlobal = data?.some(c => c.admin_id === adminId && c.config_type === 'branding_mode' && c.config_value === 'global');
        const finalValue = (useGlobal ? globalConfig?.config_value : adminConfig?.config_value || globalConfig?.config_value) || DEFAULT_COMPANY_NAME;

        setCompanyName(finalValue);
        writeCachedName(adminId, finalValue);
        if (globalConfig?.config_value) {
          writeCachedName(null, globalConfig.config_value);
        }
      }
    } catch (error) {
      console.warn('[Company Name] Unable to load company name:', error);
    } finally {
      if (loadCompanyNameRef.current?.adminId === adminId) setLoading(false);
    }
  };
  loadCompanyNameRef.current = { adminId, load: loadCompanyName };

  return { companyName, loading };
}
