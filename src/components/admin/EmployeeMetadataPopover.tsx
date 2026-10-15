import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Tag } from 'lucide-react';

type MetadataKind = 'tag' | 'note';
type MetadataTheme = 'orange' | 'emerald';

interface EmployeeMetadataPopoverProps {
  kind: MetadataKind;
  theme: MetadataTheme;
  values?: string[];
  value?: string;
  selected?: boolean;
  className?: string;
}

const POPOVER_MIN_WIDTH = 180;
const POPOVER_MAX_WIDTH = 420;
const VIEWPORT_GUTTER = 12;
const METADATA_POPOVER_EVENT = 'employee-metadata-popover-open';

export default function EmployeeMetadataPopover({
  kind,
  theme,
  values = [],
  value = '',
  selected = false,
  className = '',
}: EmployeeMetadataPopoverProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverIdRef = useRef<object>({});
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, height: 64 });

  const preview = values.length > 0
    ? `${values[0]}${values.length > 1 ? ` +${values.length - 1}` : ''}`
    : value.trim() || (kind === 'tag' ? '無標籤' : '無備註');
  const details = values.length > 0
    ? values.join(' · ')
    : value.trim() || (kind === 'tag' ? '尚未設定標籤' : '尚未新增備註');
  const isTag = kind === 'tag';

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const anchor = trigger.closest('button') || trigger;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(
        rect.right + 6,
        window.innerWidth - POPOVER_MAX_WIDTH - VIEWPORT_GUTTER
      )
    );
    const height = Math.max(rect.height, 1);
    const top = Math.max(
      VIEWPORT_GUTTER,
      Math.min(
        rect.top,
        window.innerHeight - height - VIEWPORT_GUTTER
      )
    );

    setPosition({ left, top, height });
  }, []);

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const showPopover = () => {
    cancelClose();
    if (open) return;
    window.dispatchEvent(new CustomEvent(METADATA_POPOVER_EVENT, {
      detail: popoverIdRef.current,
    }));
    updatePosition();
    setOpen(true);
  };

  const hidePopover = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 25);
  };

  useEffect(() => {
    const closeFromAnotherPopover = (event: Event) => {
      if ((event as CustomEvent<object>).detail === popoverIdRef.current) return;
      cancelClose();
      setOpen(false);
    };

    window.addEventListener(METADATA_POPOVER_EVENT, closeFromAnotherPopover);
    return () => window.removeEventListener(METADATA_POPOVER_EVENT, closeFromAnotherPopover);
  }, []);

  useEffect(() => {
    if (!open) return;

    const syncPosition = () => updatePosition();
    window.addEventListener('resize', syncPosition);
    window.addEventListener('scroll', syncPosition, true);

    return () => {
      window.removeEventListener('resize', syncPosition);
      window.removeEventListener('scroll', syncPosition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span
        className={`group block min-w-0 max-w-full overflow-hidden ${className}`}
        onMouseEnter={showPopover}
        onMouseMove={showPopover}
        onMouseLeave={hidePopover}
      >
        <span
          ref={triggerRef}
          tabIndex={0}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopover}
          onFocus={showPopover}
          onBlur={hidePopover}
          className={`flex w-full min-w-0 max-w-full items-center gap-1 overflow-hidden truncate text-[9px] font-medium outline-none ${
            selected
              ? 'text-white/85'
              : isTag
                ? 'text-slate-300/65'
                : theme === 'orange' ? 'text-orange-200/70' : 'text-emerald-200/70'
          }`}
        >
          {isTag ? (
            <Tag className="h-2.5 w-2.5 shrink-0 opacity-75" />
          ) : (
            <FileText className="h-2.5 w-2.5 shrink-0 opacity-70" />
          )}
          <span className="min-w-0 truncate">{isTag ? '標籤' : '備註'}：{preview}</span>
        </span>
      </span>
      {open && createPortal(
        <div
          role="tooltip"
          className={`fixed z-[10000] overflow-y-auto rounded-xl border-2 bg-[#020617] p-2.5 text-white shadow-2xl shadow-black/80 ring-2 ${
            isTag
              ? 'border-slate-300 ring-slate-500/50'
              : theme === 'orange'
                ? 'border-orange-300 ring-orange-500/40'
                : 'border-emerald-300 ring-emerald-500/40'
          }`}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopover}
          style={{
            left: position.left,
            top: position.top,
            minWidth: POPOVER_MIN_WIDTH,
            width: 'max-content',
            height: position.height,
            maxWidth: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_GUTTER * 2}px))`,
            backgroundColor: '#020617',
            opacity: 1,
            isolation: 'isolate',
            mixBlendMode: 'normal',
          }}
        >
          <div className={`mb-0.5 text-[8px] font-bold uppercase leading-3 tracking-[0.12em] ${
            isTag
              ? 'text-slate-300'
              : theme === 'orange' ? 'text-orange-300' : 'text-emerald-300'
          }`}>
            {isTag ? '標籤' : '備註'}
          </div>
          <div className="break-words text-[11px] font-semibold leading-4 text-white">{details}</div>
        </div>,
        document.body
      )}
    </>
  );
}
