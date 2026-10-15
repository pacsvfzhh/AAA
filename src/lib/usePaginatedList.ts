import { useState, useMemo, useCallback } from 'react';

interface UsePaginatedListOptions<T> {
  items: T[];
  pageSize: number;
}

interface PaginatedListResult<T> {
  pageItems: T[];
  page: number;
  totalPages: number;
  totalItems: number;
  hasNext: boolean;
  hasPrev: boolean;
  goNext: () => void;
  goPrev: () => void;
  goToPage: (p: number) => void;
  reset: () => void;
}

export function usePaginatedList<T>({ items, pageSize }: UsePaginatedListOptions<T>): PaginatedListResult<T> {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

  const safePage = Math.min(page, totalPages - 1);
  if (safePage !== page) setPage(safePage);

  const pageItems = useMemo(
    () => items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [items, safePage, pageSize]
  );

  const goNext = useCallback(() => setPage((p) => Math.min(p + 1, totalPages - 1)), [totalPages]);
  const goPrev = useCallback(() => setPage((p) => Math.max(p - 1, 0)), []);
  const goToPage = useCallback((p: number) => setPage(Math.max(0, Math.min(p, totalPages - 1))), [totalPages]);
  const reset = useCallback(() => setPage(0), []);

  return {
    pageItems,
    page: safePage,
    totalPages,
    totalItems: items.length,
    hasNext: safePage < totalPages - 1,
    hasPrev: safePage > 0,
    goNext,
    goPrev,
    goToPage,
    reset,
  };
}
