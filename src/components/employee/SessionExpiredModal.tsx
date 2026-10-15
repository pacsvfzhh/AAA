import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { useLanguage } from '../../lib/i18n/context';

interface SessionExpiredModalProps {
  isOpen: boolean;
  onClose: () => void;
  countdown?: number;
}

export default function SessionExpiredModal({
  isOpen,
  onClose,
  countdown = 5
}: SessionExpiredModalProps) {
  const [secondsLeft, setSecondsLeft] = useState(countdown);
  const { t } = useLanguage();

  useEffect(() => {
    if (!isOpen) {
      setSecondsLeft(countdown);
      return;
    }

    // Countdown timer
    const timer = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          // Defer onClose to avoid updating parent during render
          setTimeout(() => onClose(), 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen, countdown, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="employee-modal-backdrop absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="employee-modal-surface relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header with gradient */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-white/20 rounded-lg backdrop-blur-sm">
              <AlertTriangle className="w-6 h-6 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white">
              {t.session.expired}
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label={t.common.close}
            className="emp-close-btn w-9 h-9 flex items-center justify-center rounded-xl bg-white/15 hover:bg-white/25 backdrop-blur-sm transition-colors"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-8">
          <div className="space-y-4">
            <p className="text-gray-700 text-lg leading-relaxed">
              {t.session.noLongerActive}
            </p>
            <p className="text-gray-600">
              {t.session.signInAgain}
            </p>

            {/* Countdown badge */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 rounded-xl p-4 flex items-center justify-between">
              <span className="text-gray-600 font-medium">
                {t.session.redirecting}
              </span>
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
                  <span className="text-white font-bold text-lg">
                    {secondsLeft}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6">
          <button
            onClick={onClose}
            className="w-full min-h-[44px] py-3 px-4 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-[1.02] active:scale-[0.98]"
          >
            {t.session.returnToLogin}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
