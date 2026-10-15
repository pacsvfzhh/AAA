/**
 * TabSessionManager - Ensures only one browser tab per user account can be logged in
 *
 * Uses BroadcastChannel API for modern browsers (real-time communication)
 * Falls back to polling for older browsers (checks every 30 seconds)
 */

import { validateEmployeeSession } from './auth';

interface TabSessionMessage {
  type: 'NEW_LOGIN' | 'LOGOUT' | 'HEARTBEAT';
  userId: string;
  tabId: string;
  timestamp: number;
  sessionMarker?: string;
}

type SessionExpiredCallback = () => void;

interface SessionOptions {
  sessionMarker?: string;
  expiresAt?: number;
  onHandover?: () => void;
}

interface SessionOwner {
  marker: string;
  tabId: string;
}

const SESSION_OWNER_KEY = 'work_platform_session_owner';

const SESSION_TIMEOUT = {
  ADMIN: 7 * 24 * 60 * 60 * 1000,
  EMPLOYEE: 24 * 60 * 60 * 1000,
};

const WARNING_TIME = 5 * 60 * 1000;

class TabSessionManager {
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private userId: string | null = null;
  private userRole: 'admin' | 'employee' | null = null;
  private loginTime: number = 0;
  private pollingInterval: NodeJS.Timeout | null = null;
  private expirationCheckInterval: NodeJS.Timeout | null = null;
  private onSessionExpired: SessionExpiredCallback | null = null;
  private onSessionWarning: ((remainingSeconds: number) => void) | null = null;
  private onHandover: (() => void) | null = null;
  private sessionMarker: string | null = null;
  private sessionStartedAt = 0;
  private expiresAt: number | null = null;
  private isActive = false;

  constructor() {
    // Generate unique tab ID using crypto API
    this.tabId = this.generateTabId();

    // Store tab ID in sessionStorage (not shared across tabs)
    sessionStorage.setItem('tabId', this.tabId);

    // Initialize BroadcastChannel if supported
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('tab_session_channel');
        this.setupChannelListener();
      } catch (error) {
        console.warn('BroadcastChannel not available, falling back to polling:', error);
        this.channel = null;
      }
    }

    // Owner record survives missed broadcasts (e.g. a frozen mobile tab) and is rechecked on return.
    window.addEventListener('storage', (event) => {
      if (event.key === SESSION_OWNER_KEY || event.key === null) this.handOverIfSuperseded();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.handOverIfSuperseded();
    });
  }

  /**
   * Generate a unique tab ID
   */
  private generateTabId(): string {
    // Use crypto.randomUUID if available, otherwise fallback
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    // Fallback for older browsers
    return 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
  }

  /**
   * Setup BroadcastChannel message listener
   */
  private setupChannelListener(): void {
    if (!this.channel) return;

    this.channel.onmessage = (event: MessageEvent<TabSessionMessage>) => {
      const { type, userId, tabId, timestamp, sessionMarker } = event.data;

      // Ignore messages from this tab
      if (tabId === this.tabId) return;

      // Ignore messages from different users
      if (userId !== this.userId) return;

      // Handle different message types
      if (type === 'NEW_LOGIN') {
        if (this.sessionMarker && sessionMarker === this.sessionMarker) {
          const owner = this.readOwner();
          const superseded = owner?.marker === this.sessionMarker
            ? owner.tabId !== this.tabId
            : timestamp >= this.sessionStartedAt;
          if (superseded) {
            console.log('[TabSessionManager] Same login opened in another tab, handing over');
            this.handleHandover();
          }
          return;
        }
        // Another tab logged in with the same user - this tab must logout
        console.log('[TabSessionManager] Another tab logged in, expiring this session');
        this.handleSessionExpired();
      } else if (type === 'LOGOUT') {
        // User logged out in another tab - this tab should also logout
        console.log('[TabSessionManager] User logged out in another tab');
        this.handleSessionExpired();
      }
    };
  }

  /**
   * Start tracking session for a user
   */
  public startSession(
    userId: string,
    userRole: 'admin' | 'employee',
    onExpired: SessionExpiredCallback,
    onWarning?: (remainingSeconds: number) => void,
    options: SessionOptions = {}
  ): void {
    this.userId = userId;
    this.userRole = userRole;
    this.loginTime = Date.now();
    this.sessionStartedAt = this.loginTime;
    this.onSessionExpired = onExpired;
    this.onSessionWarning = onWarning || null;
    this.onHandover = options.onHandover || null;
    this.sessionMarker = options.sessionMarker || null;
    this.expiresAt = options.expiresAt ?? null;
    this.isActive = true;

    this.claimOwnership();
    // Broadcast that this tab has logged in
    this.broadcastMessage('NEW_LOGIN');

    // Start polling fallback if BroadcastChannel not available
    if (!this.channel) {
      this.startPolling();
    }

    // Start session expiration check for all users
    this.startExpirationCheck();
  }

  /**
   * Stop tracking session
   * @param broadcastLogout - Whether to broadcast logout to other tabs (default: false)
   */
  public stopSession(broadcastLogout: boolean = false): void {
    this.isActive = false;

    // Only broadcast logout if explicitly requested (user initiated logout)
    // Don't broadcast if this tab was kicked out by another login
    if (broadcastLogout && this.userId) {
      this.broadcastMessage('LOGOUT');
    }

    this.releaseOwnership();
    this.userId = null;
    this.userRole = null;
    this.loginTime = 0;
    this.onSessionExpired = null;
    this.onSessionWarning = null;
    this.onHandover = null;
    this.sessionMarker = null;
    this.expiresAt = null;

    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Stop expiration check
    if (this.expirationCheckInterval) {
      clearInterval(this.expirationCheckInterval);
      this.expirationCheckInterval = null;
    }
  }

  /**
   * Broadcast message to other tabs
   */
  private broadcastMessage(type: TabSessionMessage['type']): void {
    if (!this.channel || !this.userId) return;

    const message: TabSessionMessage = {
      type,
      userId: this.userId,
      tabId: this.tabId,
      timestamp: Date.now(),
      sessionMarker: this.sessionMarker || undefined,
    };

    try {
      this.channel.postMessage(message);
    } catch (error) {
      console.error('[TabSessionManager] Failed to broadcast message:', error);
    }
  }

  /**
   * Start polling to check if session is still valid (fallback for older browsers)
   */
  private startPolling(): void {
    // Check every 30 seconds
    this.pollingInterval = setInterval(() => {
      this.checkSessionValidity();
    }, 30000);
  }

  /**
   * Check if session is still valid by comparing tabId
   */
  private async checkSessionValidity(): Promise<void> {
    if (!this.userId || !this.isActive) return;

    try {
      const storedAuth = sessionStorage.getItem('work_platform_auth');

      if (!storedAuth) {
        this.handleSessionExpired();
        return;
      }

      const auth = JSON.parse(storedAuth);
      const userId = auth.user?.id;
      const financialSessionToken = auth.financialSessionToken;
      // The server binds the session to the tab ID issued at login, not this page load's ID.
      const sessionTabId = auth.tabId;

      if (!userId || !financialSessionToken || !sessionTabId) {
        this.handleSessionExpired();
        return;
      }

      const isValid = await validateEmployeeSession(userId, financialSessionToken, sessionTabId);

      if (!isValid) {
        console.log('[TabSessionManager] Session validation failed');
        this.handleSessionExpired();
      }
    } catch (error) {
      console.error('[TabSessionManager] Error checking session validity:', error);
    }
  }

  /**
   * Handle session expiration (kicked out by another login)
   */
  private handleSessionExpired(): void {
    if (!this.isActive) return;

    this.isActive = false;

    // Save callback before clearing
    const callback = this.onSessionExpired;

    // Don't broadcast LOGOUT when being kicked out
    // This prevents the new tab from also logging out
    this.userId = null;
    this.onSessionExpired = null;

    // Call the callback to show modal and logout
    if (callback) {
      callback();
    }
  }

  private handleHandover(): void {
    if (!this.isActive) return;

    const callback = this.onHandover || this.onSessionExpired;
    this.isActive = false;
    this.userId = null;
    this.onSessionExpired = null;
    this.onHandover = null;
    callback?.();
  }

  private handOverIfSuperseded(): void {
    if (!this.isActive || !this.sessionMarker) return;
    const owner = this.readOwner();
    if (owner?.marker !== this.sessionMarker || owner.tabId === this.tabId) return;
    console.log('[TabSessionManager] Same login is now owned by another tab, handing over');
    this.handleHandover();
  }

  private readOwner(): SessionOwner | null {
    try {
      const stored = localStorage.getItem(SESSION_OWNER_KEY);
      if (!stored) return null;
      const owner = JSON.parse(stored) as Partial<SessionOwner>;
      return typeof owner.marker === 'string' && typeof owner.tabId === 'string'
        ? { marker: owner.marker, tabId: owner.tabId }
        : null;
    } catch {
      return null;
    }
  }

  private claimOwnership(): void {
    if (!this.sessionMarker) return;
    try {
      localStorage.setItem(SESSION_OWNER_KEY, JSON.stringify({ marker: this.sessionMarker, tabId: this.tabId }));
    } catch { /* storage unavailable; broadcast timestamps still decide */ }
  }

  private releaseOwnership(): void {
    if (this.readOwner()?.tabId !== this.tabId) return;
    try {
      localStorage.removeItem(SESSION_OWNER_KEY);
    } catch { /* ignore */ }
  }

  /**
   * Get current tab ID
   */
  public getTabId(): string {
    return this.tabId;
  }

  /**
   * Start checking for session expiration
   */
  private startExpirationCheck(): void {
    if (!this.userRole) {
      return;
    }

    const checkInterval = 60 * 1000;

    this.expirationCheckInterval = setInterval(() => {
      if (!this.isActive || !this.loginTime) {
        return;
      }

      const remaining = this.getRemainingMs();

      if (remaining <= 0) {
        console.log('[TabSessionManager] Session expired');
        this.handleSessionExpired();
      } else if (remaining <= WARNING_TIME && this.onSessionWarning) {
        const remainingSeconds = Math.floor(remaining / 1000);
        this.onSessionWarning(remainingSeconds);
      }
    }, checkInterval);
  }

  /**
   * Get remaining session time in seconds
   */
  public getRemainingTime(): number {
    if (!this.loginTime || !this.userRole) {
      return 0;
    }

    return Math.max(0, Math.floor(this.getRemainingMs() / 1000));
  }

  private getRemainingMs(): number {
    if (this.expiresAt) return this.expiresAt - Date.now();
    const timeout = this.userRole === 'admin' ? SESSION_TIMEOUT.ADMIN : SESSION_TIMEOUT.EMPLOYEE;
    return timeout - (Date.now() - this.loginTime);
  }

  /**
   * Refresh/extend the session (update login time)
   */
  public refreshSession(): void {
    if (!this.isActive) {
      return;
    }

    this.loginTime = Date.now();
    console.log('[TabSessionManager] Session refreshed');
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.stopSession();

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

// Export singleton instance
export const tabSessionManager = new TabSessionManager();
