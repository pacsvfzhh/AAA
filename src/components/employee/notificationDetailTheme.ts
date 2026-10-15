export type NotificationDetailTone = 'normal' | 'high' | 'urgent' | 'reward';

export interface NotificationDetailTheme {
  headerGradient: string;
  iconBox: string;
  titleText: string;
  metaText: string;
  clockIcon: string;
  metaDivider: string;
  typeTag: string;
  priorityTag: string;
  closeOuter: string;
  closeInner: string;
  closeSolid: string;
  contentGradient: string;
  accentLine: string;
  rewardBannerClass: string;
  scrollbar: string;
  prose: string;
  footerBorder: string;
  unreadIconBox: string;
  unreadIcon: string;
  unreadLabel: string;
  footerButton: string;
  orbPrimary: string;
  orbSecondary: string;
}

const lightHeader = {
  iconBox: 'border-white/20 bg-white/15 text-white',
  titleText: 'text-white',
  metaDivider: 'text-white/20',
  priorityTag: 'border-white/15 bg-white/15 text-white',
  closeOuter: 'text-white focus-visible:ring-white/60',
  closeInner: 'border border-white/10 bg-white/15 group-hover:bg-white/25',
  closeSolid: 'bg-white/15 text-white hover:bg-white/25 focus-visible:ring-white/60',
};

export const NOTIFICATION_DETAIL_THEMES: Record<NotificationDetailTone, NotificationDetailTheme> = {
  normal: {
    ...lightHeader,
    headerGradient: 'from-blue-600 via-blue-500 to-cyan-500',
    metaText: 'text-blue-100/90',
    clockIcon: 'text-cyan-200',
    typeTag: 'border-white/20 bg-white/15 text-sky-100',
    contentGradient: 'linear-gradient(160deg, #ffffff 0%, #f0f7ff 40%, #e6f2fe 100%)',
    accentLine: 'via-blue-300',
    rewardBannerClass: '',
    scrollbar: 'scrollbar-thin',
    prose: '[&_a]:!text-blue-600 [&_blockquote]:!border-l-blue-400 [&_blockquote]:!bg-blue-50/60',
    footerBorder: 'border-blue-100',
    unreadIconBox: 'bg-blue-50 ring-blue-200',
    unreadIcon: 'text-blue-600',
    unreadLabel: 'text-blue-700',
    footerButton: 'bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-lg shadow-blue-500/20 hover:from-blue-700 hover:to-cyan-600',
    orbPrimary: '37,99,235',
    orbSecondary: '14,165,233',
  },
  high: {
    ...lightHeader,
    headerGradient: 'from-emerald-600 via-emerald-500 to-teal-500',
    metaText: 'text-emerald-100/90',
    clockIcon: 'text-teal-200',
    typeTag: 'border-white/20 bg-white/15 text-emerald-50',
    contentGradient: 'linear-gradient(160deg, #ffffff 0%, #ecfdf5 40%, #d9f7e8 100%)',
    accentLine: 'via-emerald-300',
    rewardBannerClass: '',
    scrollbar: 'scrollbar-thin',
    prose: '[&_a]:!text-emerald-700 [&_blockquote]:!border-l-emerald-400 [&_blockquote]:!bg-emerald-50/60',
    footerBorder: 'border-emerald-100',
    unreadIconBox: 'bg-emerald-50 ring-emerald-200',
    unreadIcon: 'text-emerald-600',
    unreadLabel: 'text-emerald-700',
    footerButton: 'bg-gradient-to-r from-emerald-600 to-teal-500 text-white shadow-lg shadow-emerald-500/20 hover:from-emerald-700 hover:to-teal-600',
    orbPrimary: '16,185,129',
    orbSecondary: '20,184,166',
  },
  urgent: {
    ...lightHeader,
    headerGradient: 'from-rose-600 via-red-500 to-orange-500',
    metaText: 'text-rose-100/90',
    clockIcon: 'text-orange-200',
    typeTag: 'border-white/20 bg-white/15 text-rose-50',
    contentGradient: 'linear-gradient(160deg, #ffffff 0%, #fff1f2 40%, #ffe4e6 100%)',
    accentLine: 'via-rose-300',
    rewardBannerClass: '',
    scrollbar: 'scrollbar-thin',
    prose: '[&_a]:!text-rose-600 [&_blockquote]:!border-l-rose-400 [&_blockquote]:!bg-rose-50/60',
    footerBorder: 'border-rose-100',
    unreadIconBox: 'bg-rose-50 ring-rose-200',
    unreadIcon: 'text-rose-600',
    unreadLabel: 'text-rose-700',
    footerButton: 'bg-gradient-to-r from-rose-600 to-orange-500 text-white shadow-lg shadow-rose-500/20 hover:from-rose-700 hover:to-orange-600',
    orbPrimary: '244,63,94',
    orbSecondary: '251,146,60',
  },
  reward: {
    headerGradient: 'from-amber-500 via-yellow-500 to-orange-500',
    iconBox: 'border-amber-950/20 bg-amber-950/15 text-amber-950 shadow-sm shadow-amber-950/10',
    titleText: 'text-amber-950',
    metaText: 'text-amber-950/75',
    clockIcon: 'text-amber-950/70',
    metaDivider: 'text-amber-950/30',
    typeTag: 'border-amber-950/25 bg-amber-950/15 text-amber-950',
    priorityTag: 'border-orange-800/25 bg-orange-800/20 text-orange-950',
    closeOuter: 'text-amber-950 focus-visible:ring-amber-950/35',
    closeInner: 'border border-amber-950/20 bg-amber-950/15 group-hover:bg-amber-950/25',
    closeSolid: 'border border-amber-950/20 bg-amber-950/15 text-amber-950 hover:bg-amber-950/25 focus-visible:ring-amber-950/35',
    contentGradient: 'linear-gradient(160deg, #fffbeb 0%, #fef3c7 45%, #fff7ed 100%)',
    accentLine: 'via-amber-400',
    rewardBannerClass: 'shrink-0 border-b border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 p-4 lg:px-7',
    scrollbar: 'reward-notification-scrollbar',
    prose: '[&_a]:!text-amber-700 [&_blockquote]:!border-l-amber-400 [&_blockquote]:!bg-amber-50/60',
    footerBorder: 'border-amber-100',
    unreadIconBox: 'bg-amber-50 ring-amber-200',
    unreadIcon: 'text-amber-600',
    unreadLabel: 'text-amber-700',
    footerButton: 'bg-gradient-to-r from-amber-500 via-yellow-500 to-orange-500 text-amber-950 shadow-lg shadow-amber-500/25 hover:from-amber-600 hover:via-yellow-600 hover:to-orange-600',
    orbPrimary: '245,158,11',
    orbSecondary: '251,191,36',
  },
};

export function getNotificationDetailTone(priority: string | null | undefined, category: string | null | undefined): NotificationDetailTone {
  if (category === 'performance_reward') return 'reward';
  if (priority === 'urgent') return 'urgent';
  if (priority === 'high') return 'high';
  return 'normal';
}
