import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Pin, Calendar, Bell, Sparkles, Radio, ChevronRight, Zap, Star, Eye, TrendingUp, Lock, Shield, Layers, Database } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Announcement, AnnouncementListItem } from '../../types';
import { useDeviceOptimization } from '../../lib/useDeviceOptimization';
import { useLanguage } from '../../lib/i18n/context';
import AnnouncementDetailModal from '../AnnouncementDetailModal';
import PageLoader from './PageLoader';

interface AnnouncementBoardProps {
  userId: string;
}

// Cache keys for sessionStorage
const CACHE_KEYS = {
  ADMIN_ID: 'announcement_admin_id',
  CATEGORIES: 'announcement_categories',
  CAROUSEL_ENABLED: 'announcement_carousel_enabled',
  CAROUSEL_SPEED: 'announcement_carousel_speed',
  ANNOUNCEMENTS: 'announcements_cache',
  CACHE_TIME: 'announcements_cache_time',
  CACHE_USER_ID: 'announcements_cache_user_id'
};

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000;

const normalizeCarouselSpeed = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.min(5, Math.max(0.1, parsed)) : 0.6;
};

export default function AnnouncementBoard({ userId }: AnnouncementBoardProps) {
  const { deviceType } = useDeviceOptimization();
  const { t, dateLocale } = useLanguage();

  const translateCategory = (category: string) => {
    const key = `category${category.charAt(0).toUpperCase()}${category.slice(1).toLowerCase()}` as keyof typeof t.announcements;
    return (t.announcements[key] as string) || category;
  };

  const isActuallyMobile = typeof window !== 'undefined' && window.innerWidth < 600;

  // Detect iOS devices for special optimization
  // Only flag as iOS for actual mobile/tablet touch devices, not Mac desktops
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && window.innerWidth <= 1366);

  // Only disable carousel on actual phones - tablets and desktops keep carousel
  const isMobileDevice = deviceType === 'phone' || isActuallyMobile;

  // Tablets and desktops get full visual effects; only phones get reduced effects
  // iOS devices get even more optimized experience
  const showDesktopEffects = !isMobileDevice && !isIOS;

  // Tablet-specific detection for optimized layout
  const isTabletDevice = deviceType === 'tablet';
  const supportsHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const [announcements, setAnnouncements] = useState<AnnouncementListItem[]>(() => {
    try {
      const cachedUserId = sessionStorage.getItem(CACHE_KEYS.CACHE_USER_ID);
      const cached = sessionStorage.getItem(CACHE_KEYS.ANNOUNCEMENTS);
      const cacheTime = sessionStorage.getItem(CACHE_KEYS.CACHE_TIME);

      if (cachedUserId !== userId) {
        sessionStorage.removeItem(CACHE_KEYS.ANNOUNCEMENTS);
        sessionStorage.removeItem(CACHE_KEYS.CACHE_TIME);
        sessionStorage.removeItem(CACHE_KEYS.ADMIN_ID);
        return [];
      }

      if (cached && cacheTime) {
        const age = Date.now() - parseInt(cacheTime);
        if (age < CACHE_DURATION) {
          return JSON.parse(cached);
        }
      }
    } catch {
      // Ignore cache errors
    }
    return [];
  });
  const [loading, setLoading] = useState(false);
  const [announcementsPending, setAnnouncementsPending] = useState(true);
  // Tab switches toggle display:none, which would replay staggered entrances and leave cards blank.
  const [cardsEntered, setCardsEntered] = useState(false);
  const loadUserAdminRef = useRef<(() => Promise<string | null>) | null>(null);
  const loadCategoriesRef = useRef<(() => Promise<void>) | null>(null);
  const loadInitialAnnouncementsRef = useRef<(() => Promise<void>) | null>(null);
  const loadAnnouncementsRef = useRef<((skipLoadingState?: boolean) => Promise<void>) | null>(null);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const contentCacheRef = useRef<Map<string, string>>(new Map());
  const [userAdminId, setUserAdminId] = useState<string | null>(() => {
    const cachedUserId = sessionStorage.getItem(CACHE_KEYS.CACHE_USER_ID);
    if (cachedUserId !== userId) {
      return null;
    }
    return sessionStorage.getItem(CACHE_KEYS.ADMIN_ID);
  });
  const [adminResolved, setAdminResolved] = useState(() => {
    const cachedUserId = sessionStorage.getItem(CACHE_KEYS.CACHE_USER_ID);
    return cachedUserId === userId && sessionStorage.getItem(CACHE_KEYS.ADMIN_ID) !== null;
  });
  const isCarouselPausedRef = useRef(false);
  const touchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const carouselLoopMarkerRef = useRef<HTMLDivElement | null>(null);
  const carouselTrackRef = useRef<HTMLDivElement | null>(null);
  const lastAutoScrollAtRef = useRef(0);
  const isLoadingRef = useRef(false);
  const backgroundRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPageVisibleRef = useRef(typeof document !== 'undefined' ? !document.hidden : true);
  const [carouselEnabled, setCarouselEnabled] = useState(() => {
    const cached = sessionStorage.getItem(CACHE_KEYS.CAROUSEL_ENABLED);
    return cached !== null ? cached === 'true' : true;
  });
  const [carouselSpeed, setCarouselSpeed] = useState(() => {
    const cached = sessionStorage.getItem(CACHE_KEYS.CAROUSEL_SPEED);
    return normalizeCarouselSpeed(cached);
  });
  const [categories, setCategories] = useState<Map<string, { icon_name: string; color_scheme: string }>>(() => {
    // Load from cache
    try {
      const cached = sessionStorage.getItem(CACHE_KEYS.CATEGORIES);
      if (cached) {
        const parsed = JSON.parse(cached);
        return new Map(Object.entries(parsed));
      }
    } catch {
      // Ignore cache errors
    }
    return new Map();
  });

  const getCategoryIcon = (announcement: AnnouncementListItem | Announcement) => {
    const iconMap: Record<string, LucideIcon> = {
      'bell': Bell,
      'sparkles': Sparkles,
      'radio': Radio,
      'zap': Zap,
      'star': Star,
      'eye': Eye,
      'trending-up': TrendingUp,
      'trendingup': TrendingUp,
      'lock': Lock,
      'shield': Shield,
      'layers': Layers,
      'database': Database,
    };

    const categoryInfo = announcement.category ? categories.get(announcement.category) : null;
    const iconName = categoryInfo?.icon_name?.toLowerCase() || 'bell';
    const IconComponent = iconMap[iconName] || Bell;
    return IconComponent;
  };

  const getCategoryColor = (announcement: AnnouncementListItem | Announcement) => {
    const colorMap: { [key: string]: string } = {
      'red': '#f87171',
      'blue': '#60a5fa',
      'green': '#4ade80',
      'yellow': '#facc15',
      'purple': '#c084fc',
      'slate': '#94a3b8',
    };

    const categoryInfo = announcement.category ? categories.get(announcement.category) : null;
    const colorScheme = categoryInfo?.color_scheme?.toLowerCase() || 'slate';
    return colorMap[colorScheme] || '#22d3ee';
  };

  const handleAnnouncementClick = useCallback(async (item: AnnouncementListItem) => {
    const cachedContent = contentCacheRef.current.get(item.id);
    if (cachedContent) {
      setSelectedAnnouncement({ ...item, content: cachedContent } as Announcement);
      return;
    }

    setContentLoading(true);
    setSelectedAnnouncement({ ...item, content: '' } as Announcement);

    try {
      const { data, error } = await supabase
        .from('announcements')
        .select('content')
        .eq('id', item.id)
        .maybeSingle();

      if (error) throw error;
      const content = data?.content || '';
      contentCacheRef.current.set(item.id, content);
      setSelectedAnnouncement({ ...item, content } as Announcement);
    } catch (error) {
      console.error('Error loading announcement content:', error);
      setSelectedAnnouncement({ ...item, content: 'Failed to load content.' } as Announcement);
    } finally {
      setContentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cardsEntered || announcements.length === 0) return;
    const timer = setTimeout(() => setCardsEntered(true), 600 + Math.min(announcements.length, 20) * 80);
    return () => clearTimeout(timer);
  }, [cardsEntered, announcements.length]);

  useEffect(() => {
    // Parallel loading for better performance
    Promise.all([
      loadUserAdminRef.current?.(),
      loadCategoriesRef.current?.(),
      loadInitialAnnouncementsRef.current?.()
    ]);

    // Cleanup on unmount
    return () => {
      if (backgroundRefreshTimeoutRef.current) {
        clearTimeout(backgroundRefreshTimeoutRef.current);
        backgroundRefreshTimeoutRef.current = null;
      }
      if (touchTimeoutRef.current) {
        clearTimeout(touchTimeoutRef.current);
        touchTimeoutRef.current = null;
      }
      isLoadingRef.current = false;
    };
  }, [userId]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisibleRef.current = !document.hidden;
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      // Check cache first
      const cached = sessionStorage.getItem(CACHE_KEYS.CATEGORIES);
      if (cached && categories.size > 0) {
        // Already have cached data in state, skip
        return;
      }

      const { data, error } = await supabase
        .from('announcement_categories')
        .select('name, icon_name, color_scheme')
        .eq('is_active', true);

      if (error) throw error;

      const categoryMap = new Map();
      data?.forEach(cat => {
        categoryMap.set(cat.name, {
          icon_name: cat.icon_name,
          color_scheme: cat.color_scheme
        });
      });
      setCategories(categoryMap);

      // Cache the result
      try {
        const cacheObj: Record<string, { icon_name: string; color_scheme: string }> = {};
        categoryMap.forEach((value, key) => {
          cacheObj[key] = value;
        });
        sessionStorage.setItem(CACHE_KEYS.CATEGORIES, JSON.stringify(cacheObj));
      } catch {
      // Ignore cache errors
    }
    } catch (error) {
      console.error('Error loading categories:', error);
    }
  }, [categories.size]);

  loadCategoriesRef.current = loadCategories;

  useEffect(() => {
    let realtimeVersion = 0;

    const setupCarouselSettings = async () => {
      const requestVersion = realtimeVersion;
      try {
        const [{ data: enabledData, error: enabledError }, { data: speedData, error: speedError }] = await Promise.all([
          supabase.from('system_configs').select('value').eq('key', 'announcement_carousel_enabled').maybeSingle(),
          supabase.from('system_configs').select('value').eq('key', 'announcement_carousel_speed').maybeSingle(),
        ]);

        if (enabledError) throw enabledError;
        if (speedError) throw speedError;
        if (requestVersion !== realtimeVersion) return;

        if (enabledData?.value !== undefined) {
          const enabled = enabledData.value === true;
          setCarouselEnabled(enabled);
          sessionStorage.setItem(CACHE_KEYS.CAROUSEL_ENABLED, enabled.toString());
        }
        if (speedData?.value !== undefined) {
          const speed = normalizeCarouselSpeed(speedData.value);
          setCarouselSpeed(speed);
          sessionStorage.setItem(CACHE_KEYS.CAROUSEL_SPEED, speed.toString());
        }
      } catch (error) {
        console.error('Error loading carousel settings:', error);
      }
    };

    const channel = supabase
      .channel('carousel_settings_changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'system_configs' },
        (payload) => {
          realtimeVersion += 1;
          const newRecord = payload.new as { key?: string; value?: unknown };
          if (newRecord.key === 'announcement_carousel_enabled') {
            const enabled = newRecord.value === true;
            setCarouselEnabled(enabled);
            sessionStorage.setItem(CACHE_KEYS.CAROUSEL_ENABLED, enabled.toString());
          } else if (newRecord.key === 'announcement_carousel_speed') {
            const speed = normalizeCarouselSpeed(newRecord.value);
            setCarouselSpeed(speed);
            sessionStorage.setItem(CACHE_KEYS.CAROUSEL_SPEED, speed.toString());
          }
        }
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR') void setupCarouselSettings();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const isAnnouncementDetailOpen = Boolean(selectedAnnouncement);
  useLayoutEffect(() => {
    if (!isAnnouncementDetailOpen) return;

    const scrollY = window.scrollY;
    const body = document.body;
    const previousStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.overflow = 'hidden';

    return () => {
      Object.assign(body.style, previousStyles);
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, [isAnnouncementDetailOpen]);

  useEffect(() => {
    if (!adminResolved) return;

    // Subscribe to real-time updates with debouncing
    let reloadTimeout: NodeJS.Timeout | null = null;

    const channel = supabase
      .channel('announcements_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'announcements'
        },
        () => {
          if (reloadTimeout) {
            clearTimeout(reloadTimeout);
          }

          reloadTimeout = setTimeout(() => {
            try {
              sessionStorage.removeItem(CACHE_KEYS.ANNOUNCEMENTS);
              sessionStorage.removeItem(CACHE_KEYS.CACHE_TIME);
            } catch {
              // Ignore storage errors
            }

            void loadAnnouncementsRef.current?.(true);
          }, 300);
        }
      )
      .subscribe();

    return () => {
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
      }
      supabase.removeChannel(channel);
    };
  }, [adminResolved, userAdminId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || announcements.length <= 1 || !carouselEnabled || selectedAnnouncement) return;

    let animationFrameId = 0;
    let lastTimestamp: number | null = null;
    let scrollPosition = container.scrollTop;
    let loopStart = 0;
    let canScroll = false;
    let subPixelOffset = 0;

    const setSubPixelOffset = (offset: number) => {
      const track = carouselTrackRef.current;
      if (!track || offset === subPixelOffset) return;
      subPixelOffset = offset;
      track.style.transform = offset ? `translate3d(0, ${-offset}px, 0)` : '';
    };

    const updateLoopBoundary = () => {
      const marker = carouselLoopMarkerRef.current;
      const first = carouselTrackRef.current?.firstElementChild as HTMLElement | null;
      loopStart = marker && first ? marker.offsetTop - first.offsetTop : container.scrollHeight / 2;
      canScroll = loopStart > 0 && container.scrollHeight > container.clientHeight;
    };

    const autoScroll = (timestamp: number) => {
      // A hidden tab (display: none) has nothing to scroll: stop instead of polling every frame; the ResizeObserver restarts it.
      if (!canScroll) {
        setSubPixelOffset(0);
        animationFrameId = 0;
        return;
      }

      if (isCarouselPausedRef.current || !isPageVisibleRef.current) {
        setSubPixelOffset(0);
        scrollPosition = container.scrollTop;
        lastTimestamp = timestamp;
        animationFrameId = requestAnimationFrame(autoScroll);
        return;
      }

      if (lastTimestamp === null) lastTimestamp = timestamp;
      const deltaSeconds = Math.min((timestamp - lastTimestamp) / 1000, 1 / 30);
      lastTimestamp = timestamp;
      scrollPosition += carouselSpeed * 48 * deltaSeconds;

      if (scrollPosition >= loopStart) scrollPosition -= loopStart;
      lastAutoScrollAtRef.current = performance.now();
      container.scrollTop = scrollPosition;
      // scrollTop snaps to whole pixels; the track transform carries the remainder so motion stays continuous.
      setSubPixelOffset(scrollPosition - container.scrollTop);
      animationFrameId = requestAnimationFrame(autoScroll);
    };

    const startLoop = () => {
      if (animationFrameId || !canScroll) return;
      lastTimestamp = null;
      scrollPosition = container.scrollTop;
      animationFrameId = requestAnimationFrame(autoScroll);
    };

    const resizeObserver = new ResizeObserver(() => {
      updateLoopBoundary();
      startLoop();
    });
    resizeObserver.observe(container);
    if (carouselLoopMarkerRef.current) resizeObserver.observe(carouselLoopMarkerRef.current);

    updateLoopBoundary();
    startLoop();

    return () => {
      resizeObserver.disconnect();
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      setSubPixelOffset(0);
    };
  }, [announcements.length, carouselEnabled, carouselSpeed, selectedAnnouncement]);

  // Detect manual scrolling and add class to disable animations
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let scrollTimeout: NodeJS.Timeout;
    let isScrolling = false;

    const handleScrollStart = () => {
      if (performance.now() - lastAutoScrollAtRef.current < 80) return;

      if (!isScrolling) {
        isScrolling = true;
        container.classList.add('scrolling');
      }

      if (isCarouselPausedRef.current) {
        if (touchTimeoutRef.current) clearTimeout(touchTimeoutRef.current);
        touchTimeoutRef.current = setTimeout(() => {
          isCarouselPausedRef.current = false;
        }, 700);
      }

      // Clear existing timeout
      clearTimeout(scrollTimeout);

      // Set timeout to remove class after scrolling stops
      scrollTimeout = setTimeout(() => {
        isScrolling = false;
        container.classList.remove('scrolling');
      }, 150); // 150ms after scroll stops
    };

    // Listen for scroll events
    container.addEventListener('scroll', handleScrollStart, { passive: true });

    // Also listen for touch events on mobile
    container.addEventListener('touchmove', handleScrollStart, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScrollStart);
      container.removeEventListener('touchmove', handleScrollStart);
      clearTimeout(scrollTimeout);
      container.classList.remove('scrolling');
    };
  }, []);

  const loadUserAdmin = useCallback(async () => {
    try {
      // Check cache first
      const cached = sessionStorage.getItem(CACHE_KEYS.ADMIN_ID);
      if (cached) {
        setUserAdminId(cached);
        setAdminResolved(true);
        return cached;
      }

      const { data, error } = await supabase
        .from('users')
        .select('created_by')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;
      const adminId = data?.created_by || null;
      setUserAdminId(adminId);
      setAdminResolved(true);

      // Cache the result with userId
      if (adminId) {
        sessionStorage.setItem(CACHE_KEYS.ADMIN_ID, adminId);
        sessionStorage.setItem(CACHE_KEYS.CACHE_USER_ID, userId);
      }

      return adminId;
    } catch (error) {
      console.error('Error loading user admin:', error);
      setAdminResolved(true);
      return null;
    }
  }, [userId]);
  loadUserAdminRef.current = loadUserAdmin;

  // Initial load with user lookup embedded in query
  const loadInitialAnnouncements = async () => {
    // Prevent duplicate loads
    if (isLoadingRef.current) {
      return;
    }

    // Don't show loading overlay on initial load to prevent black screen flash
    // Data loads fast enough that overlay is unnecessary
    try {
      // Check cache first
      const cachedAnnouncements = sessionStorage.getItem(CACHE_KEYS.ANNOUNCEMENTS);
      const cacheTime = sessionStorage.getItem(CACHE_KEYS.CACHE_TIME);

      if (cachedAnnouncements && cacheTime) {
        const age = Date.now() - parseInt(cacheTime);
        // Reduced cache duration from 5 minutes to 1 minute for fresher data
        const REDUCED_CACHE_DURATION = 60 * 1000; // 1 minute
        if (age < REDUCED_CACHE_DURATION) {
          // Use cached data immediately - already loaded in state initializer
          // No need to call setAnnouncements again
          setLoading(false);
          setAnnouncementsPending(false);

          // Clear any pending background refresh
          if (backgroundRefreshTimeoutRef.current) {
            clearTimeout(backgroundRefreshTimeoutRef.current);
          }

          // Background refresh after 500ms to ensure data is up-to-date
          backgroundRefreshTimeoutRef.current = setTimeout(() => {
            void loadAnnouncementsFromServer();
            backgroundRefreshTimeoutRef.current = null;
          }, 500);
          return;
        }
      }

      // No cache or expired, load from server immediately
      isLoadingRef.current = true;
      await loadAnnouncementsFromServer();
      isLoadingRef.current = false;
    } catch (error) {
      console.error('Error loading initial announcements:', error);
      setLoading(false);
      setAnnouncementsPending(false);
      isLoadingRef.current = false;
    }
  };
  loadInitialAnnouncementsRef.current = loadInitialAnnouncements;

  const loadAnnouncementsFromServer = async () => {
    try {
      // Get user's admin_id - check cache first
      let adminId: string | null = sessionStorage.getItem(CACHE_KEYS.ADMIN_ID);

      if (!adminId) {
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('created_by')
          .eq('id', userId)
          .maybeSingle();

        if (userError) {
          console.error('Error fetching user admin:', userError);
        }

        adminId = userData?.created_by || null;
        if (adminId) {
          sessionStorage.setItem(CACHE_KEYS.ADMIN_ID, adminId);
          sessionStorage.setItem(CACHE_KEYS.CACHE_USER_ID, userId);
        }
      }

      // Build the filter - handle null adminId safely
      const orFilter = adminId
        ? `created_by.eq.${adminId},is_global.eq.true`
        : `is_global.eq.true`;

      // Load announcements without content (content is loaded on-demand)
      const { data, error } = await supabase
        .from('announcements')
        .select('id, title, is_pinned, is_global, is_hidden, pin_order, category, publish_at, created_by, created_at, updated_at')
        .lte('publish_at', new Date().toISOString())
        .eq('is_hidden', false)
        .or(orFilter)
        .order('is_pinned', { ascending: false })
        .order('publish_at', { ascending: false });

      if (error) throw error;

      const newData = data || [];

      // Cache the results with userId validation
      try {
        sessionStorage.setItem(CACHE_KEYS.ANNOUNCEMENTS, JSON.stringify(newData));
        sessionStorage.setItem(CACHE_KEYS.CACHE_TIME, Date.now().toString());
        sessionStorage.setItem(CACHE_KEYS.CACHE_USER_ID, userId);
      } catch {
        // Ignore cache errors (quota exceeded, etc.)
      }

      // Only update state if data actually changed to prevent flicker
      setAnnouncements(prev => {
        if (prev.length === newData.length && JSON.stringify(prev.map(a => a.id + a.updated_at)) === JSON.stringify(newData.map(a => a.id + a.updated_at))) {
          return prev;
        }
        return newData;
      });
      setLoading(false);
    } catch (error) {
      console.error('Error loading announcements from server:', error);
      setLoading(false);
    } finally {
      setAnnouncementsPending(false);
    }
  };

  const loadAnnouncements = async (skipLoadingState = false) => {
    // Never show loading overlay if we already have data — prevents visible flicker
    const hasExistingData = announcements.length > 0;
    if (!skipLoadingState && !hasExistingData) {
      setLoading(true);
    }
    try {
      // Build the filter - handle null adminId safely
      const orFilter = userAdminId
        ? `created_by.eq.${userAdminId},is_global.eq.true`
        : `is_global.eq.true`;

      const { data, error } = await supabase
        .from('announcements')
        .select('id, title, is_pinned, is_global, is_hidden, pin_order, category, publish_at, created_by, created_at, updated_at')
        .lte('publish_at', new Date().toISOString())
        .eq('is_hidden', false)
        .or(orFilter)
        .order('is_pinned', { ascending: false })
        .order('publish_at', { ascending: false });

      if (error) throw error;

      const newData = data || [];

      // Update cache with userId validation
      try {
        sessionStorage.setItem(CACHE_KEYS.ANNOUNCEMENTS, JSON.stringify(newData));
        sessionStorage.setItem(CACHE_KEYS.CACHE_TIME, Date.now().toString());
        sessionStorage.setItem(CACHE_KEYS.CACHE_USER_ID, userId);
      } catch {
      // Ignore cache errors
    }

      // Invalidate content cache on realtime update
      contentCacheRef.current.clear();

      // Only update state if data actually changed
      setAnnouncements(prev => {
        if (prev.length === newData.length && JSON.stringify(prev.map(a => a.id + a.updated_at)) === JSON.stringify(newData.map(a => a.id + a.updated_at))) {
          return prev;
        }
        return newData;
      });
    } catch (error) {
      console.error('Error loading announcements:', error);
    } finally {
      if (!skipLoadingState && !hasExistingData) {
        setLoading(false);
      }
    }
  };
  loadAnnouncementsRef.current = loadAnnouncements;

  return (
    <>
      {selectedAnnouncement && (
        <AnnouncementDetailModal
          title={selectedAnnouncement.title}
          content={selectedAnnouncement.content}
          publishAt={selectedAnnouncement.publish_at}
          isPinned={selectedAnnouncement.is_pinned}
          onClose={() => setSelectedAnnouncement(null)}
          CategoryIcon={getCategoryIcon(selectedAnnouncement)}
          dateLocale={dateLocale}
          pinnedLabel={t.announcements.pinned}
          closeLabel={t.common.close}
          contentLoading={contentLoading}
          isMobileDevice={isMobileDevice}
          isIOS={isIOS}
        />
      )}

      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }

        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-10px) rotate(5deg); }
        }

        @keyframes glow-pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.05); }
        }

        @keyframes scan-line {
          0% { transform: translateY(-100%); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: translateY(100%); opacity: 0; }
        }

        @keyframes border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }

        @keyframes particle-float {
          0% { transform: translate(0, 0) scale(1); opacity: 0; }
          50% { opacity: 0.8; }
          100% { transform: translate(100px, -100px) scale(0); opacity: 0; }
        }

        @keyframes aurora {
          0% { transform: translateX(-100%) translateY(-50%) rotate(0deg); opacity: 0.3; }
          50% { opacity: 0.6; }
          100% { transform: translateX(100%) translateY(-50%) rotate(360deg); opacity: 0.3; }
        }

        @keyframes shimmer-slide {
          0% { transform: translateX(-100%) skewX(-15deg); }
          100% { transform: translateX(200%) skewX(-15deg); }
        }

        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 1; }
          100% { transform: scale(1.8); opacity: 0; }
        }

        @keyframes rotate-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes wave {
          0%, 100% { transform: translateX(0) translateY(0); }
          25% { transform: translateX(5px) translateY(-5px); }
          50% { transform: translateX(0) translateY(-10px); }
          75% { transform: translateX(-5px) translateY(-5px); }
        }

        @keyframes gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        @keyframes morph {
          0%, 100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
          50% { border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; }
        }

        @keyframes float-diagonal {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translate(150px, -150px) rotate(180deg); opacity: 0; }
        }
      `}</style>
      <div className={`relative rounded-2xl border-0 shadow-none min-[1025px]:shadow-xl min-[1025px]:shadow-blue-200/50 overflow-hidden max-sm:fixed max-sm:bottom-[56px] max-sm:left-0 max-sm:right-0 max-sm:z-[45] max-sm:flex max-sm:flex-col max-sm:rounded-none sm:fixed sm:bottom-[64px] sm:left-0 sm:right-0 sm:z-[45] sm:flex sm:flex-col sm:rounded-none md:fixed md:bottom-[64px] md:left-0 md:right-0 md:z-[45] md:flex md:flex-col md:rounded-none min-[1025px]:relative min-[1025px]:top-auto min-[1025px]:bottom-auto min-[1025px]:left-auto min-[1025px]:right-auto min-[1025px]:z-auto min-[1025px]:flex min-[1025px]:flex-col min-[1025px]:rounded-2xl min-[1025px]:pb-0`}
        style={{
          willChange: 'auto',
          top: window.innerWidth >= 1025 ? 'auto' : 'calc(var(--employee-header-height, 64px) - 1px)',
          height: window.innerWidth >= 1025 ? 'calc(100vh - var(--employee-header-height, 128px) - 64px)' : undefined,
          background: isMobileDevice
            ? 'linear-gradient(160deg, #ffffff 0%, #f0f7ff 40%, #e8f4fd 100%)'
            : 'linear-gradient(145deg, #ffffff 0%, #f0f7ff 25%, #e6f2fe 50%, #f5faff 75%, #ffffff 100%)',
        }}>

        {/* Loading Overlay - Simplified for mobile */}
        {loading && (
          <div className="absolute inset-0 bg-white/95 z-50 flex items-center justify-center max-sm:rounded-none md:rounded-none min-[1025px]:rounded-2xl">
            <PageLoader variant="panel" />
          </div>
        )}

        {/* Mobile Background - Trade/Supply chain pattern */}
        {!selectedAnnouncement && !showDesktopEffects && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div
            className="absolute top-0 left-0 right-0 h-40 opacity-50"
            style={{ background: 'linear-gradient(180deg, rgba(37,99,235,0.04) 0%, transparent 100%)' }}
          ></div>
          <div
            className="absolute bottom-0 right-0 w-56 h-56 opacity-25"
            style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.06) 0%, transparent 70%)' }}
          ></div>
          {/* Supply chain dotted route lines */}
          <svg className="absolute inset-0 w-full h-full opacity-[0.035]" xmlns="http://www.w3.org/2000/svg">
            <pattern id="trade-dots-mobile" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle cx="20" cy="20" r="1" fill="#2563eb" />
            </pattern>
            <rect width="100%" height="100%" fill="url(#trade-dots-mobile)" />
          </svg>
        </div>
        )}

        {/* Desktop background - Supply chain / Trade themed decorative pattern */}
        {!selectedAnnouncement && showDesktopEffects && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {/* Soft gradient orbs */}
          <div className="absolute -top-20 -right-20 w-[450px] h-[450px] opacity-40" style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.06) 0%, transparent 55%)' }}></div>
          <div className="absolute -bottom-16 -left-16 w-[380px] h-[380px] opacity-35" style={{ background: 'radial-gradient(circle, rgba(14,165,233,0.05) 0%, transparent 55%)' }}></div>
          <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] opacity-25" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.04) 0%, transparent 50%)' }}></div>

          {/* Grid dot pattern - resembling logistics network nodes */}
          <svg className="absolute inset-0 w-full h-full opacity-[0.03]" xmlns="http://www.w3.org/2000/svg">
            <pattern id="trade-grid" x="0" y="0" width="48" height="48" patternUnits="userSpaceOnUse">
              <circle cx="24" cy="24" r="1.2" fill="#1e40af" />
            </pattern>
            <rect width="100%" height="100%" fill="url(#trade-grid)" />
          </svg>

          {/* Trade route path - curved supply chain line */}
          <svg className="absolute top-0 left-0 w-full h-full opacity-[0.06]" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" viewBox="0 0 800 600">
            <path d="M-50 300 C100 200, 250 400, 400 280 S650 150, 850 320" stroke="#3b82f6" strokeWidth="1.5" fill="none" strokeDasharray="8 6" />
            <path d="M-30 450 C150 350, 300 500, 500 380 S700 250, 850 420" stroke="#0ea5e9" strokeWidth="1" fill="none" strokeDasharray="6 8" />
          </svg>

          {/* Logistics nodes / waypoints */}
          <svg className="absolute top-0 left-0 w-full h-full opacity-[0.07]" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" viewBox="0 0 800 600">
            {/* Ship/cargo icon simplified */}
            <rect x="680" y="80" width="28" height="18" rx="3" stroke="#2563eb" strokeWidth="1" fill="none" />
            <path d="M680 98 L694 108 L708 98" stroke="#2563eb" strokeWidth="1" fill="none" />
            {/* Container box */}
            <rect x="90" y="140" width="22" height="16" rx="2" stroke="#0369a1" strokeWidth="0.8" fill="none" />
            <line x1="101" y1="140" x2="101" y2="156" stroke="#0369a1" strokeWidth="0.5" />
            {/* Globe / world trade */}
            <circle cx="400" cy="520" r="18" stroke="#3b82f6" strokeWidth="0.8" fill="none" />
            <ellipse cx="400" cy="520" rx="8" ry="18" stroke="#3b82f6" strokeWidth="0.5" fill="none" />
            <line x1="382" y1="520" x2="418" y2="520" stroke="#3b82f6" strokeWidth="0.5" />
            {/* Warehouse */}
            <path d="M60 430 L80 418 L100 430 L100 450 L60 450 Z" stroke="#1d4ed8" strokeWidth="0.8" fill="none" />
            {/* Arrow / shipping direction */}
            <path d="M720 480 L740 470 L740 475 L760 475 L760 485 L740 485 L740 490 Z" stroke="#2563eb" strokeWidth="0.7" fill="none" />
            {/* Connection dots along routes */}
            <circle cx="200" cy="350" r="4" stroke="#3b82f6" strokeWidth="0.8" fill="rgba(59,130,246,0.08)" />
            <circle cx="500" cy="300" r="4" stroke="#3b82f6" strokeWidth="0.8" fill="rgba(59,130,246,0.08)" />
            <circle cx="650" cy="220" r="3.5" stroke="#0ea5e9" strokeWidth="0.7" fill="rgba(14,165,233,0.06)" />
            <circle cx="320" cy="180" r="3" stroke="#1d4ed8" strokeWidth="0.7" fill="rgba(29,78,216,0.06)" />
          </svg>

          {/* Subtle horizontal accent lines - like shipping lanes */}
          <div className="absolute top-[15%] left-0 right-0 h-px opacity-[0.04]" style={{ background: 'linear-gradient(90deg, transparent 0%, #3b82f6 20%, #3b82f6 80%, transparent 100%)' }}></div>
          <div className="absolute top-[75%] left-0 right-0 h-px opacity-[0.03]" style={{ background: 'linear-gradient(90deg, transparent 0%, #0ea5e9 30%, #0ea5e9 70%, transparent 100%)' }}></div>
        </div>
        )}

        <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Premium Blue Header Card */}
          <div className="mb-4 flex flex-shrink-0 px-3 pt-3 min-[1025px]:mb-6 min-[1025px]:px-0 min-[1025px]:pt-0">
            <div className="relative flex w-full items-center gap-3 overflow-hidden rounded-2xl bg-[linear-gradient(120deg,#2563eb_0%,#3b82f6_55%,#60a5fa_100%)] px-3.5 py-3.5 shadow-[0_12px_26px_-10px_rgba(37,99,235,0.35)] min-[1025px]:gap-4 min-[1025px]:rounded-none min-[1025px]:bg-gradient-to-r min-[1025px]:from-blue-600 min-[1025px]:via-blue-500 min-[1025px]:to-blue-600 min-[1025px]:px-5 min-[1025px]:py-4 min-[1025px]:shadow-none">
              {/* Shimmer effect */}
              {showDesktopEffects && (
              <div className="absolute inset-0 overflow-hidden">
                <div className="absolute inset-0 opacity-20" style={{
                  backgroundImage: 'linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.3) 50%, transparent 60%)',
                  backgroundSize: '200% 200%',
                  animationName: 'shimmer-slide',
                  animationDuration: '3s',
                  animationTimingFunction: 'ease-in-out',
                  animationIterationCount: 'infinite'
                }}></div>
              </div>
              )}
              {/* Subtle pattern overlay */}
              <div className="pointer-events-none absolute inset-0 opacity-70 min-[1025px]:opacity-10" style={{
                backgroundImage: 'radial-gradient(circle at 85% 0%, rgba(125,211,252,0.24), transparent 48%), radial-gradient(circle at 10% 100%, rgba(255,255,255,0.14), transparent 55%)'
              }}></div>

              <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/15 text-cyan-50 shadow-inner shadow-white/10 min-[1025px]:h-auto min-[1025px]:w-auto min-[1025px]:rounded-lg min-[1025px]:border-white/30 min-[1025px]:bg-white/20 min-[1025px]:p-2.5 min-[1025px]:text-white min-[1025px]:shadow-none min-[1025px]:backdrop-blur-sm">
                <Bell className="h-5 w-5" />
              </div>
              <div className="relative flex-1 min-w-0">
                <h2 className="truncate text-lg font-bold tracking-tight text-white max-[360px]:text-base min-[1025px]:text-xl">
                  {t.announcements.title}
                </h2>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(110,231,183,0.55)] animate-pulse"></div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-100/85 min-[1025px]:text-xs min-[1025px]:font-medium min-[1025px]:text-blue-100">{t.announcements.liveUpdates}</span>
                </div>
              </div>
              <div className="relative flex shrink-0 items-center gap-1.5 rounded-xl border border-white/20 bg-white/15 px-2.5 py-2 min-[1025px]:rounded-lg min-[1025px]:border-white/30 min-[1025px]:bg-white/20 min-[1025px]:px-3 min-[1025px]:py-1.5 min-[1025px]:backdrop-blur-sm">
                <Sparkles className="h-3.5 w-3.5 text-cyan-200 min-[1025px]:text-blue-100" />
                <span className="text-sm font-bold text-white">{announcements.length}</span>
                <span className="text-[11px] font-medium text-blue-100 max-[360px]:hidden min-[1025px]:inline min-[1025px]:text-blue-200">{t.announcements.total}</span>
              </div>
            </div>
          </div>

          {announcements.length === 0 && announcementsPending ? (
            <PageLoader variant="panel" />
          ) : announcements.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 py-16 min-[1025px]:px-8">
              <div className="relative inline-flex flex-col items-center gap-4 p-12 rounded-2xl bg-blue-50/50 border border-blue-100">
                <div className="relative">
                  <div className="absolute inset-0 bg-blue-200/50 rounded-full blur-xl animate-pulse"></div>
                  <Radio className="relative w-16 h-16 text-blue-300" />
                </div>
                <div className="text-slate-600 font-medium">{t.announcements.noAnnouncements}</div>
                <div className="text-xs text-blue-400">{t.announcements.checkBackLater}</div>
              </div>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0 flex flex-col">
              <div
                ref={scrollContainerRef}
                onMouseEnter={() => {
                  if (supportsHover) isCarouselPausedRef.current = true;
                }}
                onMouseLeave={() => {
                  if (supportsHover) isCarouselPausedRef.current = false;
                }}
                onTouchStart={() => {
                  isCarouselPausedRef.current = true;
                  if (touchTimeoutRef.current) {
                    clearTimeout(touchTimeoutRef.current);
                    touchTimeoutRef.current = null;
                  }
                }}
                onTouchEnd={() => {
                  if (touchTimeoutRef.current) clearTimeout(touchTimeoutRef.current);
                  touchTimeoutRef.current = setTimeout(() => {
                    isCarouselPausedRef.current = false;
                  }, 500);
                }}
                onTouchCancel={() => {
                  if (touchTimeoutRef.current) clearTimeout(touchTimeoutRef.current);
                  isCarouselPausedRef.current = false;
                }}
                className={`relative overflow-y-auto hide-scrollbar flex-1 min-h-0
                  max-sm:px-6 max-sm:pb-2
                  sm:px-6 sm:pb-2
                  md:px-6 md:pb-2
                  min-[1025px]:px-8 min-[1025px]:pb-8`}
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                  scrollBehavior: 'auto',
                  WebkitOverflowScrolling: 'touch',
                  willChange: carouselEnabled && announcements.length > 1 ? 'scroll-position' : 'auto',
                }}
              >
              <div
                ref={carouselTrackRef}
                className={isTabletDevice ? 'space-y-3' : 'space-y-3 sm:space-y-4'}
                style={{ willChange: carouselEnabled && announcements.length > 1 ? 'transform' : 'auto' }}
              >
              {/* Render announcements - duplicate for carousel when enabled */}
              {(carouselEnabled && announcements.length > 1 ? [...announcements, ...announcements] : announcements).map((announcement, index) => {
                const cardColorVariants = [
                  { gradient: 'from-blue-50 via-white to-sky-50', ring: 'ring-blue-200/80', accent: 'from-blue-500 via-sky-400 to-cyan-400', iconBg: 'bg-gradient-to-br from-blue-500 to-sky-500', patternColor: 'border-blue-200', hoverShadow: 'hover:shadow-blue-100/60' },
                  { gradient: 'from-sky-50 via-white to-cyan-50', ring: 'ring-sky-200/80', accent: 'from-sky-500 via-cyan-400 to-teal-400', iconBg: 'bg-gradient-to-br from-sky-500 to-cyan-500', patternColor: 'border-sky-200', hoverShadow: 'hover:shadow-sky-100/60' },
                  { gradient: 'from-cyan-50 via-white to-blue-50', ring: 'ring-cyan-200/80', accent: 'from-cyan-500 via-blue-400 to-sky-400', iconBg: 'bg-gradient-to-br from-cyan-500 to-blue-500', patternColor: 'border-cyan-200', hoverShadow: 'hover:shadow-cyan-100/60' },
                ];
                const pinnedStyle = { gradient: 'from-amber-50 via-white to-orange-50', ring: 'ring-amber-200/80', accent: 'from-amber-500 via-orange-400 to-yellow-400', iconBg: 'bg-gradient-to-br from-amber-500 to-orange-500', patternColor: 'border-amber-200', hoverShadow: 'hover:shadow-amber-100/60' };
                const cardVariantIndex = (index % announcements.length) % cardColorVariants.length;
                const cardStyle = announcement.is_pinned ? pinnedStyle : cardColorVariants[cardVariantIndex];
                const CategoryIcon = getCategoryIcon(announcement);
                const categoryColor = getCategoryColor(announcement);

                return (
                <div
                  key={`${announcement.id}-${index}`}
                  ref={index === announcements.length ? carouselLoopMarkerRef : undefined}
                  onClick={() => handleAnnouncementClick(announcement)}
                  className={`group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-300 active:scale-[0.98] hover:-translate-y-0.5 hover:shadow-xl bg-gradient-to-br ${cardStyle.gradient} ring-1 ${cardStyle.ring} shadow-sm ${cardStyle.hoverShadow}`}
                  style={{
                    ...(isTabletDevice ? {
                      animation: showDesktopEffects && !cardsEntered && index < announcements.length ? `fadeInUp 0.4s ease-out ${(index % announcements.length) * 0.05}s both` : 'none',
                    } :
                    isMobileDevice ? {
                      willChange: 'auto',
                    } : {
                      animation: showDesktopEffects && !cardsEntered && index < announcements.length ? `fadeInUp 0.5s ease-out ${(index % announcements.length) * 0.08}s both` : 'none',
                    })
                  }}
                >
                  {/* Left accent bar */}
                  <div className={`absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b ${cardStyle.accent} rounded-l-2xl`}></div>

                  {/* Decorative pattern blocks */}
                  <div className="absolute top-0 right-0 w-32 h-full overflow-hidden pointer-events-none opacity-[0.06]">
                    <div className={`absolute top-3 right-3 w-14 h-14 border-2 ${cardStyle.patternColor} rounded-2xl rotate-12`} />
                    <div className={`absolute bottom-2 right-8 w-9 h-9 border-2 ${cardStyle.patternColor} rounded-lg -rotate-6`} />
                    <div className={`absolute top-1/2 right-2 w-5 h-5 border-2 ${cardStyle.patternColor} rounded-full`} />
                  </div>

                  {/* Color accent corner */}
                  <div className="absolute top-0 right-0 w-20 h-20 overflow-hidden pointer-events-none">
                    <div className={`absolute -top-10 -right-10 w-20 h-20 bg-gradient-to-bl ${cardStyle.accent} opacity-[0.08] rounded-full`} />
                  </div>

                  <div className={`relative p-4 sm:p-5 pl-5 sm:pl-6`}>
                    <div className="flex items-start gap-3.5">
                      {/* Category icon block */}
                      <div className={`flex-shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center shadow-sm ${cardStyle.iconBg}`}>
                        <CategoryIcon className="w-4.5 h-4.5 sm:w-5 sm:h-5 text-white" />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        {/* Title row */}
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {announcement.is_pinned && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500 rounded-md shadow-sm shadow-amber-200/50 flex-shrink-0">
                                <Pin className="w-2.5 h-2.5 text-white fill-white" />
                                <span className="text-[11px] font-bold text-white uppercase tracking-wider">{t.announcements.pinned}</span>
                              </span>
                            )}
                            <h3 className={`min-w-0 font-semibold text-slate-800 group-hover:text-blue-700 transition-colors leading-snug break-words ${
                              isTabletDevice ? 'text-[15px] line-clamp-2' : 'text-sm sm:text-[15px] line-clamp-1'
                            }`}>
                              {announcement.title}
                            </h3>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0 text-blue-500 group-hover:text-blue-600">
                            <span className="text-[11px] font-bold hidden sm:inline">{t.announcements.view}</span>
                            <ChevronRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                          </div>
                        </div>

                        {/* Preview text */}
                        {/* Bottom meta row */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-md font-medium bg-white/80 ring-1 ring-blue-100 text-blue-600">
                              <Calendar className="w-3 h-3" />
                              {new Date(announcement.publish_at).toLocaleDateString(dateLocale, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric'
                              })}
                            </span>
                            {announcement.category && announcement.category.toLowerCase() !== 'general' && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider ring-1"
                                style={{
                                  backgroundColor: `${categoryColor}20`,
                                  color: categoryColor,
                                  borderColor: `${categoryColor}50`,
                                  boxShadow: `0 0 0 1px ${categoryColor}25`
                                }}
                              >
                                {translateCategory(announcement.category)}
                              </span>
                            )}
                          </div>
                          {announcement.is_pinned && (
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 bg-amber-500 rounded-full" />
                              <div className="w-2 h-2 bg-amber-500 rounded-full animate-ping opacity-75 absolute" style={{ right: announcement.category && announcement.category.toLowerCase() !== 'general' ? '8px' : '16px' }} />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                );
              })}
              </div>
              </div>
            </div>
          )}
        </div>
      </div>


      <style>{`
        @keyframes shimmer {
          0% { background-position: -250% 0; }
          100% { background-position: 250% 0; }
        }
        @keyframes content-fade-in {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes content-spinner {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes content-pulse-ring {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.1); opacity: 1; }
        }
        @keyframes content-progress-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(0%); }
          100% { transform: translateX(100%); }
        }
        @keyframes content-bounce-dot {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes scaleIn {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-scaleIn {
          animation: scaleIn 0.3s ease-out;
        }

        /* Safe area support for mobile devices */
        .max-sm\\:pt-safe {
          padding-top: max(1rem, env(safe-area-inset-top));
        }
        .max-sm\\:pb-safe {
          padding-bottom: max(1rem, env(safe-area-inset-bottom));
        }
        .line-clamp-2 {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: rgba(15, 23, 42, 0.3);
          border-radius: 3px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgba(59, 130, 246, 0.3);
          border-radius: 3px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgba(59, 130, 246, 0.5);
        }
        .modal-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .modal-scrollbar::-webkit-scrollbar-track {
          background: rgba(15, 23, 42, 0.4);
          border-radius: 4px;
        }
        .modal-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(59, 130, 246, 0.4);
          border-radius: 4px;
        }
        .modal-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(59, 130, 246, 0.6);
        }

        /* Mobile content styles - Clean, structured typography on white */
        @media (max-width: 640px) {
          .mobile-content {
            font-size: 15px !important;
            line-height: 1.75 !important;
            word-wrap: break-word;
            overflow-wrap: break-word;
            padding-left: 4px !important;
            padding-right: 4px !important;
            color: #374151 !important;
            letter-spacing: 0.01em;
          }

          .mobile-content > *:first-child {
            margin-top: 0 !important;
          }

          .mobile-content h1 {
            font-size: 1.375rem !important;
            line-height: 1.3 !important;
            margin-top: 1.75rem !important;
            margin-bottom: 0.75rem !important;
            font-weight: 700 !important;
            color: #111827 !important;
            letter-spacing: -0.02em;
            padding-bottom: 0.5rem !important;
            border-bottom: 1px solid #e5e7eb !important;
          }

          .mobile-content h2 {
            font-size: 1.2rem !important;
            line-height: 1.35 !important;
            margin-top: 1.5rem !important;
            margin-bottom: 0.625rem !important;
            font-weight: 700 !important;
            color: #1f2937 !important;
            letter-spacing: -0.01em;
          }

          .mobile-content h3 {
            font-size: 1.075rem !important;
            line-height: 1.4 !important;
            margin-top: 1.25rem !important;
            margin-bottom: 0.5rem !important;
            font-weight: 600 !important;
            color: #1f2937 !important;
          }

          .mobile-content h4 {
            font-size: 1rem !important;
            line-height: 1.4 !important;
            margin-top: 1rem !important;
            margin-bottom: 0.5rem !important;
            font-weight: 600 !important;
            color: #374151 !important;
          }

          .mobile-content p {
            margin-top: 0 !important;
            margin-bottom: 1rem !important;
            line-height: 1.75 !important;
            font-size: 15px !important;
            color: #374151 !important;
          }

          .mobile-content h1 + p,
          .mobile-content h2 + p,
          .mobile-content h3 + p,
          .mobile-content h4 + p {
            margin-top: 0 !important;
          }

          .mobile-content p + p {
            margin-top: 0 !important;
          }

          .mobile-content ul,
          .mobile-content ol {
            margin-top: 0.5rem !important;
            margin-bottom: 1rem !important;
            padding-left: 1.5rem !important;
            font-size: 15px !important;
          }

          .mobile-content li {
            margin-top: 0.375rem !important;
            margin-bottom: 0.375rem !important;
            line-height: 1.7 !important;
            color: #374151 !important;
            padding-left: 0.25rem !important;
          }

          .mobile-content li ul,
          .mobile-content li ol {
            margin-top: 0.375rem !important;
            margin-bottom: 0.375rem !important;
          }

          .mobile-content ul li::marker {
            color: #6b7280;
          }

          .mobile-content ol li::marker {
            color: #6b7280;
            font-weight: 600;
          }

          .mobile-content strong,
          .mobile-content b {
            font-weight: 700 !important;
            color: #111827 !important;
          }

          .mobile-content em,
          .mobile-content i {
            font-style: italic;
            color: #4b5563 !important;
          }

          .mobile-content a {
            color: #2563eb !important;
            text-decoration: none !important;
            font-weight: 500 !important;
            border-bottom: 1px solid rgba(37, 99, 235, 0.3) !important;
            padding-bottom: 1px !important;
            transition: all 0.2s ease;
          }

          .mobile-content a:active {
            color: #1d4ed8 !important;
            border-bottom-color: rgba(29, 78, 216, 0.6) !important;
          }

          .mobile-content blockquote {
            margin: 1rem 0 !important;
            padding: 0.75rem 1rem !important;
            border-left: 3px solid #3b82f6;
            background: #f8fafc;
            border-radius: 0 0.5rem 0.5rem 0;
            font-size: 14px !important;
            line-height: 1.7 !important;
            color: #4b5563 !important;
          }

          .mobile-content blockquote p {
            margin-bottom: 0.5rem !important;
            color: #4b5563 !important;
          }

          .mobile-content blockquote p:last-child {
            margin-bottom: 0 !important;
          }

          .mobile-content code {
            font-size: 13px !important;
            padding: 0.2rem 0.4rem !important;
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            border-radius: 4px;
            color: #1e40af !important;
            font-family: ui-monospace, 'SF Mono', Monaco, Menlo, Consolas, monospace;
          }

          .mobile-content pre {
            font-size: 13px !important;
            padding: 1rem !important;
            margin: 1rem 0 !important;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 0.625rem;
            line-height: 1.6 !important;
          }

          .mobile-content pre code {
            padding: 0 !important;
            background: transparent;
            border: none;
            font-size: 13px !important;
            color: #e2e8f0 !important;
          }

          .mobile-content table {
            font-size: 13px !important;
            display: block;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            margin: 1rem 0 !important;
            border-collapse: collapse;
            width: 100%;
            background: white;
            border-radius: 0.5rem;
            border: 1px solid #e5e7eb;
          }

          .mobile-content th,
          .mobile-content td {
            padding: 0.625rem 0.75rem !important;
            border-bottom: 1px solid #f3f4f6;
            text-align: left;
          }

          .mobile-content th {
            background: #f9fafb;
            color: #374151 !important;
            font-weight: 600 !important;
            font-size: 12px !important;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          .mobile-content td {
            color: #4b5563 !important;
          }

          .mobile-content hr {
            margin: 1.5rem 0 !important;
            border: none;
            height: 1px;
            background: #e5e7eb;
          }

          .mobile-content img {
            margin: 1rem 0 !important;
            border-radius: 0.5rem !important;
          }
        }

        /* Base announcement content typography */
        .announcement-content h1,
        .announcement-content h2,
        .announcement-content h3,
        .announcement-content h4 {
          color: #111827;
          font-weight: 700;
          margin-top: 1.5em;
          margin-bottom: 0.5em;
        }
        .announcement-content h1 { font-size: 1.5rem; line-height: 1.3; }
        .announcement-content h2 { font-size: 1.25rem; line-height: 1.35; }
        .announcement-content h3 { font-size: 1.125rem; line-height: 1.4; font-weight: 600; }
        .announcement-content h4 { font-size: 1rem; line-height: 1.4; font-weight: 600; }
        .announcement-content h1:first-child,
        .announcement-content h2:first-child,
        .announcement-content h3:first-child,
        .announcement-content h4:first-child {
          margin-top: 0;
        }
        .announcement-content p {
          margin-top: 0;
          margin-bottom: 1em;
          color: #374151;
        }
        .announcement-content ul,
        .announcement-content ol {
          margin-top: 0.5em;
          margin-bottom: 1em;
          padding-left: 1.5em;
        }
        .announcement-content li {
          margin-bottom: 0.375em;
          color: #374151;
        }
        .announcement-content strong,
        .announcement-content b {
          font-weight: 700;
          color: #111827;
        }
        .announcement-content a {
          color: #2563eb;
          text-decoration: none;
          border-bottom: 1px solid rgba(37, 99, 235, 0.3);
        }
        .announcement-content blockquote {
          margin: 1em 0;
          padding: 0.75em 1em;
          border-left: 3px solid #3b82f6;
          background: #f8fafc;
          border-radius: 0 0.375rem 0.375rem 0;
          color: #4b5563;
        }
        .announcement-content blockquote p {
          margin-bottom: 0.5em;
          color: #4b5563;
        }
        .announcement-content blockquote p:last-child {
          margin-bottom: 0;
        }
        .announcement-content hr {
          margin: 1.5em 0;
          border: none;
          height: 1px;
          background: #e5e7eb;
        }

        /* Announcement content image styles */
        .announcement-content img {
          margin: 1rem auto;
          border-radius: 0.75rem;
          border: 1px solid #e2e8f0;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -1px rgba(0, 0, 0, 0.04);
          max-width: 100%;
          height: auto;
          display: block;
          background: #f8fafc;
          transition: all 0.3s ease;
        }

        @media (min-width: 640px) {
          .announcement-content img {
            margin: 1.5rem auto;
          }
          .announcement-content img:hover {
            border-color: #bfdbfe;
            box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.1), 0 4px 6px -2px rgba(37, 99, 235, 0.05);
            transform: scale(1.01);
          }
        }

        /* Video wrapper - minimal container, no border (reduce whitespace) */
        .announcement-content .video-wrapper {
          margin: 1rem auto !important;
          position: relative !important;
          max-width: 100% !important;
          width: fit-content !important;
          width: -moz-fit-content !important;
          width: -webkit-fit-content !important;
          display: block !important;
        }

        @media (min-width: 640px) {
          .announcement-content .video-wrapper {
            margin: 1.5rem auto !important;
          }
        }

        /* Video element - with border (inner border) */
        .announcement-content video {
          width: 100%;
          max-width: min(800px, 100%);
          height: auto;
          display: block;
          border: 1px solid #e2e8f0;
          border-radius: 0.75rem;
          background: #0f172a;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
          position: relative;
          object-fit: contain;
          vertical-align: middle;
        }

        @media (min-width: 640px) {
          .announcement-content video {
            border-radius: 1rem;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
          }
        }

        /* Mobile optimization - full width */
        @media (max-width: 639px) {
          .announcement-content .video-wrapper {
            width: 100% !important;
            display: block !important;
            margin: 1.5rem 0 !important;
          }
        }

        /* Play button styling */
        .video-play-btn {
          filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.5));
        }

        .video-play-btn:hover {
          filter: drop-shadow(0 4px 16px rgba(96, 165, 250, 0.6));
        }

        /* Hide loading state immediately */
        .video-wrapper video::-webkit-media-controls {
          display: none !important;
        }

        .video-wrapper video::-webkit-media-controls-enclosure {
          display: none !important;
        }

        /* Video loading animations - Matches modal style */
        @keyframes pulse-radial {
          0%, 100% {
            opacity: 0.5;
            transform: scale(1);
          }
          50% {
            opacity: 0.8;
            transform: scale(1.03);
          }
        }

        @keyframes corner-fade {
          0%, 100% {
            opacity: 0.3;
          }
          50% {
            opacity: 0.7;
          }
        }

        @keyframes pulse-play {
          0%, 100% {
            opacity: 0.9;
            filter: drop-shadow(0 0 8px rgba(96, 165, 250, 0.6));
          }
          50% {
            opacity: 1;
            filter: drop-shadow(0 0 12px rgba(96, 165, 250, 0.8));
          }
        }

        @keyframes pulse-text {
          0%, 100% {
            opacity: 0.85;
          }
          50% {
            opacity: 1;
          }
        }

        @keyframes progress-slide {
          0% {
            transform: translateX(-100%);
          }
          50% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(100%);
          }
        }

        .announcement-content p {
          margin: 0.75rem 0;
        }

        @media (min-width: 640px) {
          .announcement-content p {
            margin: 1rem 0;
          }
        }

        .announcement-content p:has(img) {
          margin: 0;
        }

        .announcement-content > *:first-child {
          margin-top: 0;
        }

        .announcement-content > *:last-child {
          margin-bottom: 0;
        }
      `}</style>
    </>
  );
}
