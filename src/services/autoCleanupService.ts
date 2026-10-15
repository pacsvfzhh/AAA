/**
 * Auto Cleanup Service
 *
 * 后台自动清理服务，在管理员登录后自动运行
 * 每天自动执行数据清理任务
 */

import { formatSupabaseError, isSupabaseAbortError, supabase } from '../lib/supabase';
import { getAdminFinancialSessionToken } from '../lib/auth';

export interface CleanupSchedule {
  table_name: string;
  days_to_keep: number;
  schedule_time: string; // Format: "HH:MM"
  enabled: boolean;
  last_run_at?: string;
}

export interface CleanupResult {
  table_name: string;
  success: boolean;
  records_deleted: number;
  space_freed: string;
  execution_time_ms: number;
  message: string;
  timestamp: string;
}

class AutoCleanupService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastCheckDate: string | null = null;
  private adminId: string | null = null;

  /**
   * 启动自动清理服务
   */
  async start(adminId: string) {
    if (this.isRunning) {
      console.log('[AutoCleanup] Service already running');
      return;
    }

    this.adminId = adminId;
    this.isRunning = true;
    this.lastCheckDate = this.getTodayDate();

    console.log('[AutoCleanup] Service started');

    try {
      // 启动时先检查并执行昨天错过的清理任务
      await this.checkAndRunMissedCleanups();
    } catch (error) {
      console.error('[AutoCleanup] Failed to check missed cleanups on startup:', formatSupabaseError(error));
      // 不抛出错误，让服务继续运行
    }

    // 每小时检查一次是否需要执行清理
    this.intervalId = setInterval(() => {
      this.checkAndRunCleanup().catch(error => {
        console.error('[AutoCleanup] Error in periodic cleanup check:', formatSupabaseError(error));
      });
    }, 60 * 60 * 1000); // 1小时

    // 立即执行一次检查（今天的任务）
    this.checkAndRunCleanup().catch(error => {
      console.error('[AutoCleanup] Error in initial cleanup check:', formatSupabaseError(error));
    });
  }

  /**
   * 停止自动清理服务
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[AutoCleanup] Service stopped');
  }

  /**
   * 检查并执行错过的清理任务（补偿机制）
   */
  private async checkAndRunMissedCleanups() {
    console.log('[AutoCleanup] Checking for missed cleanups...');

    try {
      // 获取清理配置
      const schedule = await this.getCleanupSchedule();

      // 获取今天的日期
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      let missedCount = 0;
      let executedCount = 0;

      // 检查每个启用的表
      for (const config of schedule) {
        if (!config.enabled) continue;

        // 检查昨天是否应该执行但没有执行
        const shouldHaveRun = this.shouldHaveRunYesterday(config, yesterdayStr);

        if (shouldHaveRun) {
          missedCount++;
          console.log(`[AutoCleanup] Missed cleanup detected for ${config.table_name}, executing now...`);

          // 立即执行补偿清理
          await this.executeCleanup(config, true);
          executedCount++;
        }
      }

      if (missedCount > 0) {
        console.log(`[AutoCleanup] Compensation complete: ${executedCount}/${missedCount} missed cleanups executed`);
      } else {
        console.log('[AutoCleanup] No missed cleanups detected');
      }
    } catch (error) {
      console.error('[AutoCleanup] Error checking missed cleanups:', formatSupabaseError(error));
    }
  }

  /**
   * 判断昨天是否应该执行但没有执行
   */
  private shouldHaveRunYesterday(config: CleanupSchedule, yesterdayDate: string): boolean {
    // 如果没有最后运行时间，说明从未运行过，应该执行
    if (!config.last_run_at) {
      return true;
    }

    // 获取最后运行日期
    const lastRunDate = new Date(config.last_run_at).toISOString().split('T')[0];

    // 如果最后运行日期早于昨天，说明昨天错过了
    if (lastRunDate < yesterdayDate) {
      return true;
    }

    return false;
  }

  /**
   * 检查并执行清理任务
   */
  private async checkAndRunCleanup() {
    const currentTime = this.getCurrentTime();

    console.log('[AutoCleanup] Checking cleanup schedule...');

    try {
      const schedule = await this.getCleanupSchedule();

      for (const config of schedule) {
        if (!config.enabled) continue;

        const shouldRun = this.shouldRunCleanup(config, currentTime);

        if (shouldRun) {
          console.log(`[AutoCleanup] Running cleanup for ${config.table_name}`);
          await this.executeCleanup(config);
        }
      }

      this.lastCheckDate = this.getTodayDate();
    } catch (error) {
      console.error('[AutoCleanup] Error checking cleanup schedule:', formatSupabaseError(error));
    }
  }

  /**
   * 获取清理计划配置
   */
  private async getCleanupSchedule(): Promise<CleanupSchedule[]> {
    // 从 system_configs 获取自动清理配置
    const { data, error } = await supabase
      .from('system_configs')
      .select('value')
      .eq('key', 'auto_cleanup_schedule')
      .maybeSingle();

    if (error || !data) {
      // 返回默认配置
      return this.getDefaultSchedule();
    }

    return data.value as CleanupSchedule[];
  }

  /**
   * 获取默认清理计划
   */
  private getDefaultSchedule(): CleanupSchedule[] {
    return [
      // 高频数据 - 每天凌晨2点
      {
        table_name: 'dispatch_assignments',
        days_to_keep: 90,
        schedule_time: '02:00',
        enabled: true
      },
      {
        table_name: 'dispatch_sessions',
        days_to_keep: 60,
        schedule_time: '02:00',
        enabled: true
      },
      {
        table_name: 'work_sessions',
        days_to_keep: 90,
        schedule_time: '02:00',
        enabled: true
      },
      {
        table_name: 'dispatch_system_logs',
        days_to_keep: 60,
        schedule_time: '02:00',
        enabled: true
      },
      {
        table_name: 'dispatch_performance_metrics',
        days_to_keep: 30,
        schedule_time: '02:00',
        enabled: true
      },
      {
        table_name: 'used_order_data',
        days_to_keep: 180,
        schedule_time: '02:30',
        enabled: true
      },
      {
        table_name: 'valid_order_data',
        days_to_keep: 90,
        schedule_time: '02:45',
        enabled: false
      },

      // 审计日志 - 每天凌晨3点
      {
        table_name: 'valid_data_audit_log',
        days_to_keep: 90,
        schedule_time: '03:00',
        enabled: true
      },
      {
        table_name: 'valid_data_error_log',
        days_to_keep: 90,
        schedule_time: '03:00',
        enabled: true
      },
      {
        table_name: 'valid_data_query_performance',
        days_to_keep: 30,
        schedule_time: '03:00',
        enabled: true
      },

      // 客服会话 - 每天凌晨4点
      {
        table_name: 'customer_service_sessions',
        days_to_keep: 180,
        schedule_time: '04:00',
        enabled: false // 默认关闭，需要手动开启
      },

      // 财务相关 - 默认关闭，需要手动清理
      {
        table_name: 'commission_audit_log',
        days_to_keep: 365,
        schedule_time: '05:00',
        enabled: false
      },
      {
        table_name: 'money_data_protection_audit',
        days_to_keep: 365,
        schedule_time: '05:00',
        enabled: false
      },

      // 归档数据 - 默认关闭
      {
        table_name: 'orders_history',
        days_to_keep: 730,
        schedule_time: '06:00',
        enabled: false
      },
      {
        table_name: 'valid_order_data_archive',
        days_to_keep: 730,
        schedule_time: '06:00',
        enabled: false
      },
      {
        table_name: 'bulk_import_log',
        days_to_keep: 365,
        schedule_time: '06:00',
        enabled: false
      }
    ];
  }

  /**
   * 判断是否应该执行清理
   */
  private shouldRunCleanup(config: CleanupSchedule, currentTime: string): boolean {
    // 检查是否到了执行时间（前后30分钟内）
    const [scheduleHour, scheduleMinute] = config.schedule_time.split(':').map(Number);
    const [currentHour, currentMinute] = currentTime.split(':').map(Number);

    const scheduleMinutes = scheduleHour * 60 + scheduleMinute;
    const currentMinutes = currentHour * 60 + currentMinute;

    // 如果在执行时间前后30分钟内
    const diff = Math.abs(scheduleMinutes - currentMinutes);
    if (diff > 30) return false;

    // 检查最后执行时间
    if (config.last_run_at) {
      const lastRun = new Date(config.last_run_at);
      const now = new Date();
      const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);

      // 如果距离上次执行不到20小时，不执行
      if (hoursSinceLastRun < 20) return false;
    }

    return true;
  }

  /**
   * 执行清理任务
   * @param config 清理配置
   * @param isCompensation 是否为补偿执行（错过的清理）
   */
  private async executeCleanup(config: CleanupSchedule, isCompensation: boolean = false) {
    if (!this.adminId) {
      console.error('[AutoCleanup] No admin ID set');
      return;
    }

    try {
      const startTime = Date.now();

      const { data, error } = await supabase.rpc('execute_cleanup', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: config.table_name,
        p_days_to_keep: config.days_to_keep
      });

      const executionTime = Date.now() - startTime;

      if (error) {
        if (isSupabaseAbortError(error)) return;

        console.error(`[AutoCleanup] Failed to cleanup ${config.table_name}:`, formatSupabaseError(error));
        await this.logCleanupResult({
          table_name: config.table_name,
          success: false,
          records_deleted: 0,
          space_freed: '0 bytes',
          execution_time_ms: executionTime,
          message: isCompensation ? `[Compensation] ${formatSupabaseError(error)}` : formatSupabaseError(error),
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (data && data.length > 0) {
        const result = data[0];
        const logPrefix = isCompensation ? '[Compensation]' : '';
        console.log(`[AutoCleanup] ${logPrefix} ${config.table_name}: Deleted ${result.records_deleted} records, freed ${result.space_freed}`);

        await this.logCleanupResult({
          table_name: config.table_name,
          success: result.success,
          records_deleted: result.records_deleted,
          space_freed: result.space_freed,
          execution_time_ms: result.execution_time_ms,
          message: isCompensation ? `[Compensation] ${result.message}` : result.message,
          timestamp: new Date().toISOString()
        });

        // 更新最后执行时间
        await this.updateLastRunTime(config.table_name);
      }
    } catch (error) {
      if (!isSupabaseAbortError(error)) {
        console.error(`[AutoCleanup] Error executing cleanup for ${config.table_name}:`, formatSupabaseError(error));
      }
    }
  }

  /**
   * 记录清理结果
   */
  private async logCleanupResult(result: CleanupResult) {
    try {
      // 获取现有的清理历史
      const { data: configData } = await supabase
        .from('system_configs')
        .select('value')
        .eq('key', 'auto_cleanup_history')
        .maybeSingle();

      const history = configData?.value as CleanupResult[] || [];

      // 添加新结果（保留最近100条）
      history.unshift(result);
      if (history.length > 100) {
        history.splice(100);
      }

      // 保存历史
      await supabase
        .from('system_configs')
        .upsert(
          {
            key: 'auto_cleanup_history',
            value: history,
            description: 'Auto cleanup execution history',
            updated_at: new Date().toISOString()
          },
          {
            onConflict: 'key'
          }
        );
    } catch (error) {
      console.error('[AutoCleanup] Failed to log cleanup result:', formatSupabaseError(error));
    }
  }

  /**
   * 更新最后执行时间
   */
  private async updateLastRunTime(tableName: string) {
    try {
      const { data } = await supabase
        .from('system_configs')
        .select('value')
        .eq('key', 'auto_cleanup_schedule')
        .maybeSingle();

      if (data) {
        const schedule = data.value as CleanupSchedule[];
        const updated = schedule.map(config => {
          if (config.table_name === tableName) {
            return { ...config, last_run_at: new Date().toISOString() };
          }
          return config;
        });

        await supabase
          .from('system_configs')
          .upsert(
            {
              key: 'auto_cleanup_schedule',
              value: updated,
              description: 'Auto cleanup schedule configuration',
              updated_at: new Date().toISOString()
            },
            {
              onConflict: 'key'
            }
          );
      }
    } catch (error) {
      console.error('[AutoCleanup] Failed to update last run time:', formatSupabaseError(error));
    }
  }

  /**
   * 获取今天的日期（YYYY-MM-DD）
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 获取当前时间（HH:MM）
   */
  private getCurrentTime(): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /**
   * 手动触发清理（用于测试）
   */
  async manualCleanup(tableName: string, daysToKeep: number): Promise<CleanupResult | null> {
    if (!this.adminId) {
      console.error('[AutoCleanup] No admin ID set');
      return null;
    }

    try {
      const startTime = Date.now();

      const { data, error } = await supabase.rpc('execute_cleanup', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: tableName,
        p_days_to_keep: daysToKeep
      });

      const executionTime = Date.now() - startTime;

      if (error) {
        return {
          table_name: tableName,
          success: false,
          records_deleted: 0,
          space_freed: '0 bytes',
          execution_time_ms: executionTime,
          message: error.message,
          timestamp: new Date().toISOString()
        };
      }

      if (data && data.length > 0) {
        const result = data[0];
        return {
          table_name: tableName,
          success: result.success,
          records_deleted: result.records_deleted,
          space_freed: result.space_freed,
          execution_time_ms: result.execution_time_ms,
          message: result.message,
          timestamp: new Date().toISOString()
        };
      }

      return null;
    } catch (error) {
      console.error('[AutoCleanup] Manual cleanup error:', formatSupabaseError(error));
      return null;
    }
  }

  /**
   * 获取清理历史
   */
  async getCleanupHistory(): Promise<CleanupResult[]> {
    try {
      const { data } = await supabase
        .from('system_configs')
        .select('value')
        .eq('key', 'auto_cleanup_history')
        .maybeSingle();

      return (data?.value as CleanupResult[]) || [];
    } catch (error) {
      console.error('[AutoCleanup] Failed to get cleanup history:', formatSupabaseError(error));
      return [];
    }
  }

  /**
   * 更新清理计划配置
   */
  async updateSchedule(schedule: CleanupSchedule[]): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('system_configs')
        .upsert(
          {
            key: 'auto_cleanup_schedule',
            value: schedule,
            description: 'Auto cleanup schedule configuration',
            updated_at: new Date().toISOString()
          },
          {
            onConflict: 'key'
          }
        );

      if (error) {
        console.error('[AutoCleanup] Failed to update schedule:', formatSupabaseError(error));
        return false;
      }

      console.log('[AutoCleanup] Schedule updated successfully');
      return true;
    } catch (error) {
      console.error('[AutoCleanup] Failed to update schedule:', formatSupabaseError(error));
      return false;
    }
  }

  /**
   * 获取当前清理计划配置
   */
  async getCurrentSchedule(): Promise<CleanupSchedule[]> {
    return await this.getCleanupSchedule();
  }

  /**
   * 重置为默认配置
   */
  async resetToDefaultSchedule(): Promise<boolean> {
    try {
      const defaultSchedule = this.getDefaultSchedule();
      const { error } = await supabase
        .from('system_configs')
        .upsert(
          {
            key: 'auto_cleanup_schedule',
            value: defaultSchedule,
            description: 'Auto cleanup schedule configuration',
            updated_at: new Date().toISOString()
          },
          {
            onConflict: 'key'
          }
        );

      if (error) {
        console.error('[AutoCleanup] Failed to reset to default schedule:', formatSupabaseError(error));
        return false;
      }

      console.log('[AutoCleanup] Reset to default schedule successfully');
      return true;
    } catch (error) {
      console.error('[AutoCleanup] Failed to reset to default schedule:', formatSupabaseError(error));
      return false;
    }
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastCheckDate: this.lastCheckDate,
      adminId: this.adminId
    };
  }
}

// 导出单例
export const autoCleanupService = new AutoCleanupService();
