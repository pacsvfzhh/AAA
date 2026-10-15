import { useState, useEffect, useRef } from 'react';
import { Play, Square, Clock, Zap, Timer, Radio } from 'lucide-react';
import { getStoredAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { useLanguage } from '../../lib/i18n/context';

interface WorkSessionTrackerProps {
  userId: string;
}

interface ActiveSession {
  session_id: string;
  start_time: string;
  current_duration_minutes: number;
}

export default function WorkSessionTracker({ userId }: WorkSessionTrackerProps) {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentDuration, setCurrentDuration] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { t } = useLanguage();
  const checkActiveSessionRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    void checkActiveSessionRef.current?.();

    const channel = supabase
      .channel('work_sessions_updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'work_sessions',
          filter: `user_id=eq.${userId}`
        },
        () => {
          void checkActiveSessionRef.current?.();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  useEffect(() => {
    if (!activeSession) {
      setCurrentDuration(0);
      return;
    }

    const interval = setInterval(() => {
      const startTime = new Date(activeSession.start_time).getTime();
      const now = Date.now();
      const minutes = Math.floor((now - startTime) / 60000);
      setCurrentDuration(minutes);
    }, 1000);

    return () => clearInterval(interval);
  }, [activeSession]);

  useEffect(() => {
    const sessionId = activeSession?.session_id;
    if (!sessionId) return;

    let heartbeatInFlight = false;
    const sendHeartbeat = async () => {
      if (heartbeatInFlight || document.hidden) return;
      const auth = getStoredAuth();
      if (auth?.userType !== 'employee' || auth.user.id !== userId) {
        setActiveSession(null);
        return;
      }

      heartbeatInFlight = true;
      try {
        const { data, error } = await supabase.rpc('update_session_heartbeat_secure', {
          p_user_id: userId,
          p_session_token: auth.financialSessionToken,
          p_tab_id: auth.tabId,
          p_session_id: sessionId,
        });
        if (error) throw error;
        if (!data?.success) {
          console.error('Work session heartbeat rejected:', data?.reason || 'unknown reason');
          setActiveSession(null);
          setCurrentDuration(0);
        }
      } catch (error) {
        console.error('Failed to update work session heartbeat:', error);
      } finally {
        heartbeatInFlight = false;
      }
    };

    const interval = setInterval(() => void sendHeartbeat(), 60000);
    void sendHeartbeat();
    return () => clearInterval(interval);
  }, [activeSession?.session_id, userId]);

  const checkActiveSession = async () => {
    try {
      const { data, error } = await supabase.rpc('get_active_work_session', {
        p_user_id: userId
      });

      if (error) throw error;

      const newSession = data && data.length > 0 ? data[0] : null;
      setActiveSession(prevSession => {
        if (!prevSession && !newSession) return prevSession;
        if (prevSession?.session_id === newSession?.session_id) return prevSession;
        return newSession;
      });
    } catch (error) {
      console.error('Failed to check active session:', error);
    }
  };
  checkActiveSessionRef.current = checkActiveSession;

  const startWorkSession = async () => {
    if (isLoading) return;

    setIsLoading(true);

    try {
      const minLoadingTime = new Promise(resolve => setTimeout(resolve, 800));

      const auth = getStoredAuth();
      if (auth?.userType !== 'employee' || auth.user.id !== userId) {
        throw new Error('Employee session has expired. Please sign in again.');
      }

      const dbPromise = supabase.rpc('start_employee_dispatch_session_secure', {
        p_user_id: userId,
        p_session_token: auth.financialSessionToken,
        p_tab_id: auth.tabId,
      });

      const [{ data, error }] = await Promise.all([dbPromise, minLoadingTime]);

      if (error) {
        console.error('Database error starting work session:', error);
        throw error;
      }

      if (!data?.success || !data.session_id || !data.started_at) {
        console.error('Invalid response from secure work session start:', data);
        throw new Error('Failed to create work session. Please try again.');
      }

      console.log('Work session started successfully, session_id:', data.session_id);
      setActiveSession({
        session_id: data.session_id,
        start_time: data.started_at,
        current_duration_minutes: 0,
      });
    } catch (error: unknown) {
      console.error('Failed to start work session:', error);

      let errMsg = 'Failed to start work session. ';
      if (error instanceof Error) {
        errMsg += error.message;
      } else {
        errMsg += 'Please try again.';
      }

      setErrorMessage(errMsg);
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const endWorkSession = async () => {
    if (isLoading) return;

    setIsLoading(true);

    try {
      const minLoadingTime = new Promise(resolve => setTimeout(resolve, 800));

      const auth = getStoredAuth();
      if (auth?.userType !== 'employee' || auth.user.id !== userId) {
        throw new Error('Employee session has expired. Please sign in again.');
      }

      const dbPromise = supabase.rpc('stop_employee_dispatch_session_secure', {
        p_user_id: userId,
        p_session_token: auth.financialSessionToken,
        p_tab_id: auth.tabId,
        p_session_id: activeSession?.session_id || null,
      });

      const [{ data, error }] = await Promise.all([dbPromise, minLoadingTime]);

      if (error) throw error;
      if (!data?.success) throw new Error('The work session could not be stopped.');

      setActiveSession(null);
      setCurrentDuration(0);
    } catch (error: unknown) {
      console.error('Failed to end work session:', error);
      setErrorMessage('Failed to end work session: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDuration = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="relative bg-white border border-blue-100 rounded-2xl md:rounded-3xl shadow-lg shadow-blue-50/80 overflow-hidden">
      {/* Error Toast */}
      {errorMessage && (
        <div className="fixed top-4 right-4 z-50 max-w-md animate-slide-in-right">
          <div className="bg-white border border-red-200 rounded-xl p-4 shadow-xl shadow-red-100/50">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h4 className="text-red-800 font-semibold text-sm mb-0.5">Error</h4>
                <p className="text-red-600 text-xs leading-relaxed">{errorMessage}</p>
              </div>
              <button
                onClick={() => setErrorMessage(null)}
                className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtle gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-50/50 via-white to-slate-50/30 pointer-events-none"></div>
      {activeSession && (
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50/80 via-white to-blue-50/40 pointer-events-none"></div>
      )}

      {/* Content */}
      <div className="relative z-10 p-4 md:p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5 md:mb-8">
          <div className="flex items-center gap-3 md:gap-4">
            <div className={`relative w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center transition-all duration-500 ${
              activeSession
                ? 'bg-gradient-to-br from-blue-500 to-blue-600 shadow-lg shadow-blue-500/25'
                : 'bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-200'
            }`}>
              <Timer className={`w-5 h-5 transition-colors duration-500 ${
                activeSession ? 'text-white' : 'text-slate-500'
              }`} />
              {activeSession && (
                <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-white animate-pulse"></div>
              )}
            </div>
            <div>
              <h3 className="text-lg md:text-xl font-bold text-gray-900 tracking-tight">
                Work Session Control
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                  activeSession ? 'bg-green-500' : 'bg-slate-300'
                }`}></div>
                <span className={`text-xs font-medium transition-colors duration-300 ${
                  activeSession ? 'text-blue-600' : 'text-slate-400'
                }`}>
                  {activeSession ? t.workSession.active : 'Ready to Start'}
                </span>
              </div>
            </div>
          </div>

          {/* Work time badge */}
          {activeSession && (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-100 rounded-full">
              <Clock className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-xs font-semibold text-blue-700 tabular-nums">
                {t.workSession.workTime}: {formatDuration(currentDuration)}
              </span>
            </div>
          )}
        </div>

        {/* Main Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
          {/* Duration Display */}
          <div className={`relative rounded-xl p-5 md:p-7 transition-all duration-500 ${
            activeSession
              ? 'bg-gradient-to-br from-blue-600 via-blue-700 to-blue-800 shadow-xl shadow-blue-600/20'
              : 'bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200'
          }`}>
            {/* Decorative light effect when active */}
            {activeSession && (
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/4 pointer-events-none"></div>
            )}

            <div className="relative">
              <div className="flex items-center justify-between mb-3">
                <span className={`text-xs font-semibold uppercase tracking-wider ${
                  activeSession ? 'text-blue-200' : 'text-slate-400'
                }`}>
                  Session Duration
                </span>
                {activeSession && (
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-white/10 rounded text-[11px] font-bold text-green-300 uppercase tracking-wider">
                    <div className="w-1 h-1 bg-green-400 rounded-full animate-pulse"></div>
                    {t.workSession.active}
                  </span>
                )}
              </div>

              <div className={`text-4xl md:text-5xl font-extrabold tabular-nums tracking-tight transition-all duration-500 ${
                activeSession ? 'text-white' : 'text-slate-300'
              }`}>
                {activeSession ? formatDuration(currentDuration) : '0h 0m'}
              </div>

              {activeSession && (
                <div className="mt-4 pt-4 border-t border-white/10">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[11px] md:text-xs font-medium text-blue-300/80 uppercase tracking-wide block mb-0.5">Started</span>
                      <span className="text-sm font-semibold text-white">
                        {new Date(activeSession.start_time).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: true
                        })}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] md:text-xs font-medium text-blue-300/80 uppercase tracking-wide block mb-0.5">Status</span>
                      <span className="text-sm font-semibold text-green-300 flex items-center gap-1.5">
                        <span>{t.workSession.active}</span>
                        <Zap className="w-3 h-3" />
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Action Button */}
          <div className="flex items-center justify-center">
            {activeSession ? (
              <button
                onClick={endWorkSession}
                disabled={isLoading}
                className="group/btn relative w-full h-full min-h-[160px] md:min-h-[200px] rounded-xl border-2 border-dashed border-red-200 hover:border-red-300 bg-red-50/50 hover:bg-red-50 transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
              >
                {isLoading && (
                  <div className="absolute inset-0 bg-red-50 rounded-xl"></div>
                )}

                <div className="relative z-10 flex flex-col items-center justify-center h-full space-y-3 md:space-y-4">
                  {isLoading ? (
                    <>
                      <div className="relative">
                        <div className="w-14 h-14 md:w-16 md:h-16 border-4 border-red-100 border-t-red-500 rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Square className="w-5 h-5 md:w-6 md:h-6 text-red-500" fill="currentColor" />
                        </div>
                      </div>
                      <div className="text-center">
                        <span className="block text-base md:text-lg font-bold text-red-700">Ending Session</span>
                        <span className="block text-xs text-red-400 mt-0.5">Please wait...</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="p-4 md:p-5 bg-white rounded-2xl border border-red-100 shadow-sm group-hover/btn:shadow-md group-hover/btn:border-red-200 transition-all duration-300 group-hover/btn:scale-105 group-active/btn:scale-95">
                        <Square className="w-7 h-7 md:w-8 md:h-8 text-red-500 group-hover/btn:text-red-600 transition-colors" fill="currentColor" />
                      </div>
                      <div className="text-center">
                        <span className="block text-base md:text-lg font-bold text-red-700 group-hover/btn:text-red-800 transition-colors">
                          {t.workSession.endSession}
                        </span>
                        <span className="block text-xs text-red-400 mt-0.5">Stop tracking work time</span>
                      </div>
                    </>
                  )}
                </div>
              </button>
            ) : (
              <button
                onClick={startWorkSession}
                disabled={isLoading}
                className="group/btn relative w-full h-full min-h-[160px] md:min-h-[200px] rounded-xl overflow-hidden transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {/* Button background */}
                <div className={`absolute inset-0 transition-all duration-300 ${
                  isLoading
                    ? 'bg-gradient-to-br from-blue-500 to-blue-600'
                    : 'bg-gradient-to-br from-blue-500 to-blue-700 group-hover/btn:from-blue-600 group-hover/btn:to-blue-800'
                } rounded-xl shadow-lg shadow-blue-500/25 group-hover/btn:shadow-xl group-hover/btn:shadow-blue-500/30`}></div>

                {/* Subtle shine */}
                {!isLoading && (
                  <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-transparent rounded-xl pointer-events-none"></div>
                )}

                <div className="relative z-10 flex flex-col items-center justify-center h-full space-y-3 md:space-y-4">
                  {isLoading ? (
                    <>
                      <div className="relative">
                        <div className="w-14 h-14 md:w-16 md:h-16 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Play className="w-5 h-5 md:w-6 md:h-6 text-white" fill="currentColor" />
                        </div>
                      </div>
                      <div className="text-center">
                        <span className="block text-base md:text-lg font-bold text-white">Starting Session</span>
                        <span className="block text-xs text-blue-200 mt-0.5">Initializing...</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="p-4 md:p-5 bg-white/15 backdrop-blur-sm rounded-2xl border border-white/20 group-hover/btn:bg-white/20 group-hover/btn:scale-105 group-active/btn:scale-95 transition-all duration-300">
                        <Play className="w-7 h-7 md:w-8 md:h-8 text-white" fill="currentColor" />
                      </div>
                      <div className="text-center">
                        <span className="block text-base md:text-lg font-bold text-white">
                          {t.workSession.startSession}
                        </span>
                        <span className="block text-xs text-blue-200 mt-0.5">Begin tracking work time</span>
                      </div>
                    </>
                  )}
                </div>
              </button>
            )}
          </div>
        </div>

        {/* Session Info Bar */}
        {activeSession && (
          <div className="mt-4 md:mt-6 bg-slate-50 border border-slate-100 rounded-xl p-3.5 md:p-5">
            <div className="grid grid-cols-3 gap-3 md:gap-6">
              <div className="text-center">
                <p className="text-[11px] md:text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Session ID</p>
                <p className="text-xs md:text-sm font-mono font-semibold text-slate-700 truncate">
                  {activeSession.session_id.slice(0, 8)}
                </p>
              </div>
              <div className="text-center border-x border-slate-200">
                <p className="text-[11px] md:text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Status</p>
                <p className="text-xs md:text-sm font-semibold text-green-600 flex items-center justify-center gap-1">
                  <Radio className="w-3 h-3 animate-pulse" />
                  <span>{t.workSession.active}</span>
                </p>
              </div>
              <div className="text-center">
                <p className="text-[11px] md:text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Duration</p>
                <p className="text-xs md:text-sm font-bold text-blue-700 tabular-nums">
                  {formatDuration(currentDuration)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
