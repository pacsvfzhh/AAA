import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabase';

const CACHE_KEY_PREFIX = 'cached_currency_unit';
const DEFAULT_CURRENCY = 'USDC';

let instanceCounter = 0;

function getCacheKey(adminId?: string | null): string {
  return adminId ? `${CACHE_KEY_PREFIX}_${adminId}` : `${CACHE_KEY_PREFIX}_global`;
}

export function useCurrencyUnit(adminId?: string | null) {
  const [currencyUnit, setCurrencyUnit] = useState<string>(() => {
    if (!adminId) return DEFAULT_CURRENCY;
    try {
      return localStorage.getItem(getCacheKey(adminId)) || DEFAULT_CURRENCY;
    } catch {
      return DEFAULT_CURRENCY;
    }
  });

  const adminIdRef = useRef(adminId);
  adminIdRef.current = adminId;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCurrencyUnit = useCallback(async (debounceMs = 0) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const doLoad = async () => {
      const currentAdminId = adminIdRef.current;
      if (!currentAdminId) return;

      try {
        const { data, error } = await supabase
          .from('admin_configs')
          .select('admin_id, config_type, config_value')
          .in('config_type', ['currency_unit', 'branding_mode'])
          .or(`admin_id.eq.${currentAdminId},admin_id.is.null`);

        if (error || adminIdRef.current !== currentAdminId) return;

        const adminConfig = data?.find(c => c.admin_id === currentAdminId && c.config_type === 'currency_unit');
        const globalConfig = data?.find(c => c.admin_id === null && c.config_type === 'currency_unit');
        const useGlobal = data?.some(c => c.admin_id === currentAdminId && c.config_type === 'branding_mode' && c.config_value === 'global');
        const value = (useGlobal ? globalConfig?.config_value : adminConfig?.config_value || globalConfig?.config_value) || DEFAULT_CURRENCY;

        setCurrencyUnit(value);
        try {
          localStorage.setItem(getCacheKey(currentAdminId), value);
        } catch { /* ignore */ }
      } catch {
        // keep cached value
      }
    };

    if (debounceMs > 0) {
      debounceRef.current = setTimeout(doLoad, debounceMs);
    } else {
      await doLoad();
    }
  }, []);

  useEffect(() => {
    if (!adminId) {
      setCurrencyUnit(DEFAULT_CURRENCY);
      return;
    }

    try {
      setCurrencyUnit(localStorage.getItem(getCacheKey(adminId)) || DEFAULT_CURRENCY);
    } catch {
      setCurrencyUnit(DEFAULT_CURRENCY);
    }

    loadCurrencyUnit();

    const channelName = `currency-unit-${adminId}-${++instanceCounter}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'admin_configs',
          filter: "config_type=eq.currency_unit"
        },
        () => {
          loadCurrencyUnit(300);
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'admin_configs',
          filter: 'config_type=eq.branding_mode'
        },
        () => { loadCurrencyUnit(300); }
      )
      .subscribe();

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      supabase.removeChannel(channel);
    };
  }, [adminId, loadCurrencyUnit]);

  return currencyUnit;
}
