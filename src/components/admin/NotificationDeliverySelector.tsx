import { AlertCircle, Bell, ShieldCheck } from 'lucide-react';
import type { NotificationDeliveryMode } from '../../types';

export type { NotificationDeliveryMode } from '../../types';

interface NotificationDeliverySelectorProps {
  value: NotificationDeliveryMode;
  onChange: (value: NotificationDeliveryMode) => void;
  disabled?: boolean;
  className?: string;
  embedded?: boolean;
}

const options = [
  {
    value: 'realtime_with_login_fallback' as const,
    label: '結合通知',
    description: '在線即時，離線登入彈出',
    icon: ShieldCheck,
    active: 'border-amber-200 bg-gradient-to-r from-amber-400 to-orange-500 text-amber-950 shadow-[0_0_18px_rgba(245,158,11,0.3)]',
    inactive: 'border-amber-700/70 bg-amber-950/30 text-amber-200 hover:border-amber-400/80 hover:bg-amber-950/70',
  },
  {
    value: 'realtime_only' as const,
    label: '即時通知',
    description: '僅在線即時提示',
    icon: Bell,
    active: 'border-blue-200 bg-gradient-to-r from-blue-500 to-sky-500 text-white shadow-[0_0_18px_rgba(14,165,233,0.28)]',
    inactive: 'border-blue-700/70 bg-blue-950/30 text-blue-200 hover:border-blue-400/80 hover:bg-blue-950/70',
  },
  {
    value: 'login_only' as const,
    label: '登入通知',
    description: '登入後逐條彈出',
    icon: AlertCircle,
    active: 'border-violet-200 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_18px_rgba(139,92,246,0.28)]',
    inactive: 'border-violet-700/70 bg-violet-950/30 text-violet-200 hover:border-violet-400/80 hover:bg-violet-950/70',
  },
];

export default function NotificationDeliverySelector({
  value,
  onChange,
  disabled = false,
  className = '',
  embedded = false,
}: NotificationDeliverySelectorProps) {
  return (
    <div className={`${embedded ? 'bg-transparent' : 'rounded-2xl border border-cyan-300/30 bg-gradient-to-r from-cyan-500/[0.08] via-slate-950/75 to-violet-500/[0.08] p-2.5'} ${className}`}>
      <div className={`${embedded ? 'mb-1' : 'mb-2 px-1'} flex items-center justify-between gap-3`}>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-cyan-300" />
          <span className="text-[11px] font-black tracking-[0.08em] text-slate-100">通知類型</span>
        </div>
        <span className="text-[9px] font-semibold text-cyan-100/55">結合通知只顯示於管理員端</span>
      </div>
      <div className={`grid grid-cols-1 sm:grid-cols-3 ${embedded ? 'gap-1.5' : 'gap-2'}`}>
        {options.map(option => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`min-w-0 border px-2.5 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/80 disabled:cursor-not-allowed disabled:opacity-60 ${embedded ? 'rounded-lg py-1.5' : 'rounded-xl py-2'} ${selected ? option.active : option.inactive}`}
            >
              <span className="flex items-center justify-center gap-1.5 text-[11px] font-black">
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {option.label}
              </span>
              <span className={`${embedded ? 'mt-0.5' : 'mt-1'} block truncate text-center text-[9px] font-semibold text-current`}>
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
