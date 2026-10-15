import { AlertCircle, CheckCircle, Clock, Gift, Radio, Shield, Sparkles, Wallet, Zap, X } from 'lucide-react';
import { useResponsive } from '../../lib/useResponsive';
import { useLanguage } from '../../lib/i18n/context';
import QuickCopyRichContent from './QuickCopyRichContent';
import NotificationDetailBackground from './NotificationDetailBackground';
import { NOTIFICATION_DETAIL_THEMES, getNotificationDetailTone } from './notificationDetailTheme';

export interface EmployeeNotificationDetailData {
  title: string;
  content: string;
  message_type: 'realtime' | 'login_popup';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  notification_category?: string | null;
  reward_amount?: number | null;
  reward_currency?: string | null;
  created_at?: string | null;
  is_read?: boolean;
  read_at?: string | null;
}

interface EmployeeNotificationDetailPanelProps {
  message: EmployeeNotificationDetailData;
  onClose: () => void;
  embedded?: boolean;
  readOnlyPreview?: boolean;
}

function getPriorityIcon(priority: EmployeeNotificationDetailData['priority'], className: string) {
  switch (priority) {
    case 'urgent': return <AlertCircle className={className} />;
    case 'high': return <Zap className={className} />;
    case 'normal': return <Shield className={className} />;
    default: return <Radio className={className} />;
  }
}

export default function EmployeeNotificationDetailPanel({ message, onClose, embedded = false, readOnlyPreview = false }: EmployeeNotificationDetailPanelProps) {
  const { t, dateLocale } = useLanguage();
  const { isDesktop } = useResponsive();
  const isReward = message.notification_category === 'performance_reward';
  const tone = getNotificationDetailTone(message.priority, message.notification_category);
  const theme = NOTIFICATION_DETAIL_THEMES[tone];
  const createdAt = new Date(message.created_at || Date.now());

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden bg-[#f0f5ff] ${readOnlyPreview ? 'cursor-default' : ''} ${!embedded && isDesktop ? 'lg:h-[82vh] lg:max-w-2xl lg:rounded-3xl lg:shadow-2xl' : ''}`}
      onClick={readOnlyPreview ? event => event.preventDefault() : undefined}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={embedded ? undefined : 'employee-notification-detail-title'}
    >
      <div className="relative flex-shrink-0 overflow-hidden">
        <div className={`absolute inset-0 bg-gradient-to-br ${theme.headerGradient}`} />
        <div className="absolute right-0 top-0 h-48 w-48 opacity-[0.06]">
          <div className="absolute right-6 top-6 h-24 w-24 rotate-12 rounded-2xl border-2 border-white" />
          <div className="absolute right-28 top-2 h-14 w-14 -rotate-6 rounded-xl border-2 border-white" />
        </div>
        <div className="absolute bottom-0 left-0 h-24 w-24 -translate-x-1/3 translate-y-1/2 rounded-full bg-white/[0.04]" />

        <div className="relative px-4 pb-3 pt-6 lg:px-6">
          {!readOnlyPreview && <button
            type="button"
            onClick={onClose}
            aria-label={t.messages.close}
            className={`notification-panel-close emp-close-btn absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg backdrop-blur-sm transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default lg:right-6 lg:top-5 ${theme.closeSolid}`}
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>}

          <div className={`flex items-start gap-2.5 ${readOnlyPreview ? '' : 'pr-14 lg:pr-12'}`}>
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border backdrop-blur-sm sm:h-10 sm:w-10 ${theme.iconBox}`}>
              {isReward ? <Gift className="h-5 w-5" strokeWidth={2} /> : getPriorityIcon(message.priority, 'h-5 w-5 text-white')}
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={embedded ? undefined : 'employee-notification-detail-title'} className={`mb-1 break-words text-lg font-bold leading-tight lg:text-xl ${theme.titleText}`}>
                {message.title}
              </h2>
              <div className={`flex flex-wrap items-center gap-2 text-sm font-medium ${theme.metaText}`}>
                <div className="flex items-center gap-1.5">
                  <Clock className={`h-3.5 w-3.5 ${theme.clockIcon}`} />
                  <span>{createdAt.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                </div>
                <span className={theme.metaDivider}>|</span>
                <span>{createdAt.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>

          <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${readOnlyPreview ? '' : 'pr-14 lg:pr-12'}`}>
            <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${theme.typeTag}`}>
              {message.message_type === 'login_popup' ? t.messages.loginNotification : t.messages.liveMessage}
            </span>
            <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${theme.priorityTag}`}>
              {message.priority === 'urgent' ? t.messages.priorityUrgent : message.priority === 'high' ? t.messages.priorityHigh : message.priority === 'normal' ? t.messages.priorityNormal : t.messages.priorityLow} {t.messages.priority}
            </span>
          </div>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden p-0">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ background: theme.contentGradient }}>
          <NotificationDetailBackground tone={tone} />
          <div className={`absolute left-6 right-6 top-0 z-10 h-[2px] rounded-full bg-gradient-to-r from-transparent to-transparent ${theme.accentLine}`} />

          {isReward && (
            <div className={`relative ${theme.rewardBannerClass}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-black text-amber-800">{t.messages.rewardBonusLabel}</p>
                  <p className="mt-0.5 text-[11px] font-black uppercase tracking-wider text-amber-600 sm:tracking-[0.16em]">{t.messages.rewardWalletLabel}</p>
                </div>
                <p className="shrink-0 text-2xl font-black text-amber-700">+{Number(message.reward_amount || 0).toFixed(2)} <span className="text-base">{message.reward_currency}</span></p>
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-amber-200/80 pt-3">
                <Wallet className="h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-xs font-semibold leading-5 text-emerald-700">{t.messages.rewardAddedMessage}</p>
              </div>
            </div>
          )}

          <div className={`relative min-h-0 flex-1 overflow-y-auto p-4 lg:p-5 ${theme.scrollbar}`}>
            <QuickCopyRichContent
              html={message.content}
              copyLabel={t.messages.quickCopy}
              copiedLabel={t.messages.copied}
              className={`prose prose-sm lg:prose-base max-w-none leading-relaxed ${theme.prose} [&_a]:underline [&_img]:!rounded-xl [&_img]:!shadow-md [&_blockquote]:!p-4 [&_blockquote]:!rounded-r-lg [&_h1]:!text-slate-900 [&_h2]:!text-slate-800 [&_h3]:!text-slate-700 [&_p]:!text-slate-700 [&_li]:!text-slate-700 message-content-dark`}
              style={{ wordBreak: 'break-word', overflowWrap: 'break-word', color: '#1e293b' }}
              interactive={!readOnlyPreview}
            />
          </div>
        </div>
      </div>

      {!readOnlyPreview && <div className={`relative flex-shrink-0 border-t bg-white p-4 lg:p-5 ${theme.footerBorder}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {message.is_read ? (
              <>
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 ring-1 ring-emerald-200">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t.messages.read}</p>
                  <p className="text-sm font-semibold text-slate-700">{new Date(message.read_at || message.created_at || Date.now()).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                </div>
              </>
            ) : (
              <>
                <div className={`flex h-9 w-9 items-center justify-center rounded-xl ring-1 ${theme.unreadIconBox}`}>
                  <Sparkles className={`h-4 w-4 ${theme.unreadIcon}`} />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{t.messages.notification}</p>
                  <p className={`text-sm font-semibold ${theme.unreadLabel}`}>{t.messages.markAsRead}</p>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`min-h-[44px] rounded-xl px-6 py-2.5 text-sm font-semibold transition-all active:scale-95 ${theme.footerButton}`}
          >
            {t.messages.close}
          </button>
        </div>
      </div>}
    </div>
  );
}
