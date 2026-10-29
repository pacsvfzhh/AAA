import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { sanitizeAnnouncementContent } from '../lib/sanitizeHTML';
import { adminVideoLabels, enhanceRichVideos, type VideoLabels } from '../lib/richVideo';

interface RichMediaContentProps {
  html: string;
  className?: string;
  style?: CSSProperties;
  videoLabels?: VideoLabels;
}

export default function RichMediaContent({ html, className, style, videoLabels = adminVideoLabels }: RichMediaContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const sanitizedHtml = useMemo(() => sanitizeAnnouncementContent(html), [html]);

  useEffect(() => {
    if (contentRef.current) return enhanceRichVideos(contentRef.current, videoLabels);
  }, [sanitizedHtml, videoLabels]);

  return <div ref={contentRef} className={className} style={style} dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />;
}
