import { useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Check, X } from 'lucide-react';
import { useLanguage } from '../lib/i18n/context';
import { LANGUAGES } from '../lib/i18n/types';
import type { Language } from '../lib/i18n/types';

interface LanguageSwitcherProps {
  variant?: 'desktop' | 'mobile' | 'toolbar';
  onOpenModal?: () => void;
}

export default function LanguageSwitcher({ variant = 'desktop', onOpenModal }: LanguageSwitcherProps) {
  const { language, setLanguage, t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);

  const currentLang = LANGUAGES.find(l => l.code === language);

  const handleOpen = () => {
    if (onOpenModal) {
      onOpenModal();
    } else {
      setIsOpen(true);
    }
  };

  const handleConfirm = (selectedCode: Language) => {
    setLanguage(selectedCode);
    setIsOpen(false);
  };

  if (variant === 'mobile') {
    return (
      <>
        <button
          onClick={handleOpen}
          className="w-full px-4 py-3 flex items-center gap-3 rounded-xl hover:bg-emerald-50 transition-all duration-200 group"
        >
          <div className="w-8 h-8 bg-emerald-50 group-hover:bg-emerald-100 rounded-lg flex items-center justify-center transition-colors">
            <Globe className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="flex-1 text-left">
            <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900 transition-colors">
              {t.common.language}
            </span>
            <span className="text-xs text-slate-400 ml-2">{currentLang?.nativeName}</span>
          </div>
        </button>

        {isOpen && (
          <LanguageModal
            currentLanguage={language}
            onConfirm={handleConfirm}
            onClose={() => setIsOpen(false)}
            t={t}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className={variant === 'toolbar'
          ? 'flex h-7 items-center gap-1.5 rounded-lg px-3 text-blue-50/90 transition-all duration-200 group hover:bg-white hover:text-blue-700 hover:shadow-md hover:shadow-blue-950/20 active:bg-blue-50'
          : 'px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 active:bg-white/30 text-white transition-all border border-white/20 flex items-center gap-1.5'}
      >
        <Globe className="w-3.5 h-3.5" strokeWidth={variant === 'toolbar' ? 2 : 2.5} />
        <span className="grid text-xs"><span className="col-start-1 row-start-1 text-center font-medium group-hover:font-bold">{currentLang?.nativeName}</span><span className="invisible col-start-1 row-start-1 font-bold" aria-hidden="true">{currentLang?.nativeName}</span></span>
      </button>

      {isOpen && (
        <LanguageModal
          currentLanguage={language}
          onConfirm={handleConfirm}
          onClose={() => setIsOpen(false)}
          t={t}
        />
      )}
    </>
  );
}

interface LanguageModalProps {
  currentLanguage: Language;
  onConfirm: (code: Language) => void;
  onClose: () => void;
  t: {
    common: {
      language: string;
      confirm: string;
    };
  };
}

export function LanguageModal({ currentLanguage, onConfirm, onClose, t }: LanguageModalProps) {
  const [selected, setSelected] = useState<Language>(currentLanguage);

  useLayoutEffect(() => {
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
  }, []);

  const selectedLang = LANGUAGES.find(l => l.code === selected);

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="employee-modal-backdrop absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="employee-modal-surface relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        style={{ animation: 'fadeInUp 0.2s ease-out' }}
      >
        {/* Header */}
        <div className="relative bg-gradient-to-r from-blue-600 to-blue-700 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/20 rounded-xl">
                <Globe className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">{t.common.language}</h3>
                <p className="text-xs text-blue-100 mt-0.5">
                  {selectedLang?.nativeName} ({selectedLang?.name})
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="notification-panel-list-close emp-close-btn emp-close-btn--wrap group -mr-1.5 flex flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/20 transition-all group-hover:bg-white/30 group-active:scale-95">
                <X className="h-4 w-4 shrink-0" strokeWidth={2.5} />
              </span>
            </button>
          </div>
        </div>

        {/* Language List */}
        <div className="p-3 max-h-[50vh] overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="grid grid-cols-1 gap-1.5">
            {LANGUAGES.map((lang) => {
              const isSelected = selected === lang.code;
              return (
                <button
                  key={lang.code}
                  onClick={() => setSelected(lang.code as Language)}
                  className={`w-full px-4 py-3 flex items-center justify-between rounded-xl transition-all duration-150 active:scale-[0.98] ${
                    isSelected
                      ? 'bg-blue-50 border-2 border-blue-300 shadow-sm'
                      : 'bg-gray-50 border-2 border-transparent hover:bg-gray-100 hover:border-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                      isSelected ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'
                    }`}>
                      {lang.code.toUpperCase()}
                    </div>
                    <div className="text-left">
                      <div className={`text-sm font-semibold ${isSelected ? 'text-blue-700' : 'text-gray-700'}`}>
                        {lang.nativeName}
                      </div>
                      <div className="text-xs text-gray-400">{lang.name}</div>
                    </div>
                  </div>
                  {isSelected && (
                    <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center">
                      <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer with Confirm Button */}
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/80">
          <button
            onClick={() => onConfirm(selected)}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold text-sm rounded-xl transition-all active:scale-[0.98] shadow-md shadow-blue-200/50"
          >
            {t.common.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
