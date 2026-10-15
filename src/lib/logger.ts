/**
 * Production-Safe Logger
 *
 * 在生产环境中自动禁用所有敏感日志输出
 * 防止员工通过 F12 开发者工具查看内部逻辑
 */

// 检测是否为生产环境
const isProduction = import.meta.env.PROD;

// 检测是否强制启用生产模式日志保护（用于开发环境测试）
const forceProductionLogs = import.meta.env.VITE_FORCE_PRODUCTION_LOGS === 'true';

// 检测是否为开发模式（通过特殊标记）
const isDebugMode = () => {
  try {
    return localStorage.getItem('__debug_mode__') === 'true';
  } catch {
    return false;
  }
};

/**
 * 安全的日志函数 - 只在开发环境或调试模式下输出
 */
export const logger = {
  /**
   * 调试日志 - 生产环境完全禁用
   */
  debug: (...args: unknown[]) => {
    if ((!isProduction && !forceProductionLogs) || isDebugMode()) {
      console.log('[DEBUG]', ...args);
    }
  },

  /**
   * 信息日志 - 生产环境完全禁用
   */
  info: (...args: unknown[]) => {
    if ((!isProduction && !forceProductionLogs) || isDebugMode()) {
      console.log('[INFO]', ...args);
    }
  },

  /**
   * 警告日志 - 只在开发环境显示
   */
  warn: (...args: unknown[]) => {
    if ((!isProduction && !forceProductionLogs) || isDebugMode()) {
      console.warn('[WARN]', ...args);
    }
  },

  /**
   * 错误日志 - 生产环境只显示用户友好的错误
   * 不显示技术细节
   */
  error: (message: string, error?: unknown) => {
    if (!isProduction || isDebugMode()) {
      console.error('[ERROR]', message, error);
    } else {
      // 生产环境只显示简单的错误消息，不暴露细节
      console.error('操作失败，请稍后重试');
    }
  },

  /**
   * 性能日志 - 只在开发环境显示
   */
  perf: (label: string, startTime: number) => {
    if (!isProduction || isDebugMode()) {
      const endTime = performance.now();
      console.log(`[PERF] ${label}: ${(endTime - startTime).toFixed(2)}ms`);
    }
  },

  /**
   * 敏感数据日志 - 生产环境绝对禁用
   * 用于派单时间、配置、算法等敏感信息
   */
  sensitive: (...args: unknown[]) => {
    if (!isProduction && isDebugMode()) {
      console.log('[SENSITIVE]', ...args);
    }
    // 生产环境完全不输出
  },

  /**
   * 组日志 - 用于分组显示相关日志
   */
  group: (label: string, callback: () => void) => {
    if (!isProduction || isDebugMode()) {
      console.group(label);
      callback();
      console.groupEnd();
    }
  },

  /**
   * 表格日志 - 用于显示结构化数据
   */
  table: (data: unknown) => {
    if (!isProduction || isDebugMode()) {
      console.table(data);
    }
  }
};

/**
 * 清理全局 console 对象
 * 只在生产环境且非调试模式下禁用敏感日志
 *
 * 保留 console.error 确保错误信息不会丢失
 */
export const disableAllConsole = () => {
  // 在生产环境或强制启用日志保护时生效
  if ((isProduction || forceProductionLogs) && !isDebugMode()) {
    // 静默函数 - 什么都不做，不会抛出错误
    const noop = () => {};

    // 禁用可能泄露敏感信息的方法
    // 这些方法被调用时不会报错，只是不输出任何内容
    console.log = noop;
    console.debug = noop;
    console.info = noop;
    console.warn = noop;
    console.table = noop;
    console.group = noop;
    console.groupEnd = noop;
    console.groupCollapsed = noop;
    console.trace = noop;
    console.dir = noop;
    console.dirxml = noop;

    // 完全保留 console.error，确保错误信息不会丢失
    // 这对于生产环境的错误监控很重要
  }
};

/**
 * 启用调试模式（用于管理员）
 * 在浏览器控制台执行: localStorage.setItem('__debug_mode__', 'true')
 * 然后刷新页面
 */
export const enableDebugMode = () => {
  localStorage.setItem('__debug_mode__', 'true');
  console.log('Debug mode enabled. Please refresh the page.');
};

/**
 * 禁用调试模式
 */
export const disableDebugMode = () => {
  localStorage.removeItem('__debug_mode__');
  console.log('Debug mode disabled. Please refresh the page.');
};

// 导出用于测试
export const __testing = {
  isProduction,
  isDebugMode
};
