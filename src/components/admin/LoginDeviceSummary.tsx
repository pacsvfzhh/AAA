import { Apple, ChevronDown, HelpCircle, Monitor, Smartphone, Tablet } from 'lucide-react';
import { resolveLoginDeviceInfo } from '../../lib/deviceInfo';

interface LoginDeviceSummaryProps {
  deviceInfo?: unknown;
  userAgent?: string | null;
  compact?: boolean;
  systemOnly?: boolean;
  inlineUserAgent?: boolean;
  plain?: boolean;
  hideUserAgent?: boolean;
  auditTone?: 'login' | 'logout';
}

const osLabels = {
  android: 'Android',
  ios: 'iOS / iPadOS',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  unknown: '未知作業系統',
} as const;

const deviceTypeLabels = {
  phone: '手機',
  tablet: '平板',
  desktop: '桌面',
  unknown: '裝置未知',
} as const;

const browserLabels = {
  chrome: 'Chrome',
  safari: 'Safari',
  edge: 'Edge',
  firefox: 'Firefox',
  webview: 'WebView',
  opera: 'Opera',
  samsung: 'Samsung Internet',
  other: '其他瀏覽器',
  unknown: '未知瀏覽器',
} as const;

const osStyles = {
  android: 'border-yellow-400/30 bg-yellow-500/10 text-yellow-200',
  ios: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
  windows: 'border-blue-400/30 bg-blue-500/10 text-blue-200',
  macos: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
  linux: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
  chromeos: 'border-rose-400/30 bg-rose-500/10 text-rose-200',
  unknown: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
} as const;

const osTextStyles = {
  android: 'text-yellow-200',
  ios: 'text-emerald-200',
  windows: 'text-blue-200',
  macos: 'text-emerald-200',
  linux: 'text-amber-200',
  chromeos: 'text-rose-200',
  unknown: 'text-slate-300',
} as const;

const formatValue = (label: string, version: string | null) => version ? `${label} ${version}` : label;

export default function LoginDeviceSummary({
  deviceInfo,
  userAgent,
  compact = false,
  systemOnly = false,
  inlineUserAgent = false,
  plain = false,
  hideUserAgent = false,
  auditTone = 'login',
}: LoginDeviceSummaryProps) {
  const info = resolveLoginDeviceInfo(deviceInfo, userAgent);
  const auditTextClass = auditTone === 'logout' ? 'text-orange-200/75' : 'text-emerald-200/75';
  const browserToneClass = auditTone === 'logout' ? 'text-orange-200/80' : 'text-emerald-200/80';
  const usePlainDeviceText = inlineUserAgent || plain;
  const osText = formatValue(osLabels[info.os_family], info.os_version);
  const browserText = formatValue(browserLabels[info.browser_family], info.browser_version);
  const deviceText = `${deviceTypeLabels[info.device_type]} · ${info.device_model || '型號未知'}`;
  const SystemIcon = info.os_family === 'ios' || info.os_family === 'macos'
    ? Apple
    : info.os_family === 'android'
      ? info.device_type === 'tablet' ? Tablet : Smartphone
      : info.os_family === 'unknown'
        ? HelpCircle
        : Monitor;

  if (systemOnly) {
    return (
      <span
        className={`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${osStyles[info.os_family]}`}
        title={osText}
        aria-label={osText}
      >
        {osText}
      </span>
    );
  }

  return (
    <div className={compact && inlineUserAgent
      ? 'flex min-w-0 max-w-[480px] items-start gap-4'
      : compact && plain
        ? 'min-w-[140px] max-w-[190px]'
        : compact
          ? 'min-w-[190px] max-w-[280px]'
          : 'min-w-[240px]'}>
      <div className={usePlainDeviceText
        ? 'flex min-w-0 flex-col items-start gap-0.5 text-[10px] font-normal'
        : 'flex shrink-0 flex-wrap items-center gap-1.5'}>
        <span className={usePlainDeviceText
          ? `inline-flex items-center gap-1 ${osTextStyles[info.os_family]}`
          : `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${osStyles[info.os_family]}`}>
          <SystemIcon className="h-3 w-3" aria-hidden="true" />
          {osText}
        </span>
        {!usePlainDeviceText && <span className="text-slate-600">·</span>}
        <span className={usePlainDeviceText
          ? browserToneClass
          : 'inline-flex items-center rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-200'}>
          {browserText}
        </span>
        {!usePlainDeviceText && <span className="text-slate-600">·</span>}
        <span className={usePlainDeviceText
          ? 'text-slate-400'
          : 'inline-flex items-center rounded-md border border-slate-500/25 bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300'}>
          {deviceText}
        </span>
      </div>
      {inlineUserAgent && userAgent && !systemOnly ? (
        <p
          className={`min-w-0 max-w-[240px] max-h-[2.6em] overflow-hidden break-all font-mono text-[9px] leading-[1.3em] ${auditTextClass}`}
          title={userAgent}
        >
          <span className="mr-1 font-sans font-bold uppercase tracking-[0.12em] opacity-70">UA</span>
          {userAgent}
        </p>
      ) : !hideUserAgent && userAgent && !systemOnly ? (
        <details className="group mt-2 max-w-full">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[10px] font-semibold text-slate-500 transition-colors hover:text-cyan-300">
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
            <span>使用者代理程式</span>
            <span className="font-normal text-slate-600">· 原始稽核證據</span>
          </summary>
          <div className="mt-2 w-full max-w-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.14)]">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                瀏覽器特徵
              </span>
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[9px] font-semibold text-slate-500">唯讀</span>
            </div>
            <p className="max-h-28 overflow-y-auto break-words bg-white p-3 font-mono text-[10px] leading-relaxed text-slate-600">
              {userAgent}
            </p>
          </div>
        </details>
      ) : null}
    </div>
  );
}
