import { useState, useCallback, useEffect, ReactNode } from 'react';
import { LanguageContext } from './context';
import type { Translations } from './context';
import type { Language } from './types';
import en from './locales/en';
type TranslationModule = { default: unknown };

const loaders: Record<Language, () => Promise<TranslationModule>> = {
  en: () => Promise.resolve({ default: en }),
  es: () => import('./locales/es'),
  zh: () => import('./locales/zh'),
  fr: () => import('./locales/fr'),
  de: () => import('./locales/de'),
  pt: () => import('./locales/pt'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
  it: () => import('./locales/it'),
  hi: () => import('./locales/hi'),
};

const cache = new Map<Language, Translations>();
cache.set('en', en);

const dateLocaleMap: Record<Language, string> = {
  en: 'en-US', es: 'es-ES', zh: 'zh-CN', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', it: 'it-IT', hi: 'hi-IN',
};

const STORAGE_KEY = 'employee_language';

function getInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && stored in loaders) {
    return stored as Language;
  }
  return 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage);
  const [translations, setTranslations] = useState<Translations>(cache.get(language) || en);

  useEffect(() => {
    const cached = cache.get(language);
    if (cached) {
      setTranslations(cached);
      return;
    }
    loaders[language]().then((mod) => {
      const loadedTranslations = mod.default as Translations;
      cache.set(language, loadedTranslations);
      setTranslations(loadedTranslations);
    });
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem(STORAGE_KEY, lang);
  }, []);

  const dateLocale = dateLocaleMap[language];

  // Lets the browser apply language-correct hyphenation instead of breaking long words at arbitrary letters.
  useEffect(() => {
    document.documentElement.lang = dateLocale;
  }, [dateLocale]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t: translations, dateLocale }}>
      {children}
    </LanguageContext.Provider>
  );
}
