import { Component, ErrorInfo, ReactNode, useContext } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { LanguageContext, useLanguage } from '../lib/i18n/context';
import { isModuleLoadError, recoverFromModuleLoadError } from '../lib/moduleLoadRecovery';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

function ModuleLoadFailure({ onReload }: { onReload: () => void }) {
  const languageContext = useContext(LanguageContext);
  const { t } = useLanguage();
  const text = languageContext ? t.moduleLoadError : {
    title: '頁面載入未完成',
    description: '網站可能已更新，或連線暫時中斷。請重新整理以載入最新頁面。',
    reload: '重新整理頁面',
    notice: '重新整理會清除尚未儲存的輸入；已儲存的資料不會因此變更。',
    support: '若持續出現，請檢查網路連線或聯絡技術支援。',
  };

  return (
    <div role="alert" className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
      <div className="w-full max-w-lg rounded-2xl border border-cyan-800/60 bg-slate-900 p-6 shadow-2xl sm:p-8">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10">
          <RefreshCw aria-hidden="true" className="h-6 w-6 text-cyan-300" />
        </div>
        <h1 className="text-xl font-semibold">{text.title}</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">{text.description}</p>
        <p className="mt-4 rounded-lg border border-amber-400/15 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100/90">{text.notice}</p>
        <button
          type="button"
          onClick={onReload}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" />
          {text.reload}
        </button>
        <p className="mt-4 text-xs leading-5 text-slate-400">{text.support}</p>
      </div>
    </div>
  );
}

/**
 * Error Boundary Component
 *
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    recoverFromModuleLoadError(error);
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    this.setState({
      error,
      errorInfo
    });

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      if (isModuleLoadError(this.state.error)) {
        return <ModuleLoadFailure onReload={this.handleReload} />;
      }

      return (
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">出现错误</h1>
                <p className="text-gray-600 mt-1">页面遇到了一个问题，但不用担心，您的数据是安全的</p>
              </div>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-sm font-semibold text-red-800 mb-2">错误信息：</p>
              <p className="text-sm text-red-700 font-mono break-words">
                {this.state.error?.message || '未知错误'}
              </p>
            </div>

            {process.env.NODE_ENV === 'development' && this.state.errorInfo && (
              <div className="bg-gray-100 border border-gray-300 rounded-lg p-4 mb-6 max-h-64 overflow-auto">
                <p className="text-xs font-semibold text-gray-700 mb-2">调试信息（仅开发环境显示）：</p>
                <pre className="text-xs text-gray-600 whitespace-pre-wrap">
                  {this.state.errorInfo.componentStack}
                </pre>
              </div>
            )}

            <div className="flex gap-4">
              <button
                onClick={this.handleReset}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <RefreshCw className="w-5 h-5" />
                重试
              </button>
              <button
                onClick={this.handleReload}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
              >
                刷新页面
              </button>
            </div>

            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                <strong>建议操作：</strong>
              </p>
              <ul className="text-sm text-blue-700 mt-2 space-y-1 list-disc list-inside">
                <li>尝试刷新页面</li>
                <li>如果问题持续出现，请联系技术支持</li>
                <li>提供上述错误信息可以帮助我们更快解决问题</li>
              </ul>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
