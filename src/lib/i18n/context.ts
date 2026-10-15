import { createContext, useContext } from 'react';
import en from './locales/en';
import type { Language } from './types';

export type Translations = typeof en;

export interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
  dateLocale: string;
}

export const LanguageContext = createContext<LanguageContextType | null>(null);

export function useLanguage(): LanguageContextType {
  const context = useContext(LanguageContext);
  if (!context) {
    return { language: 'en', setLanguage: () => {}, t: en, dateLocale: 'en-US' };
  }
  return context;
}
