import type { LucideIcon } from 'lucide-react';

export default function PanelEmptyIcon({ icon: Icon, badge: Badge }: { icon: LucideIcon; badge?: LucideIcon }) {
  return (
    <div className="relative mx-auto mb-5 h-[96px] w-[120px]" aria-hidden="true">
      <span className="absolute left-1/2 top-1/2 h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 -rotate-6 rounded-[28px] border-2 border-sky-300/40"></span>
      <span className="absolute left-1/2 top-1/2 h-[74px] w-[74px] -translate-x-1/2 -translate-y-1/2 rotate-12 rounded-3xl border-2 border-blue-300/50"></span>
      <span className="absolute left-1/2 top-1/2 flex h-[64px] w-[64px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22px] bg-gradient-to-br from-blue-400 via-sky-400 to-cyan-300 shadow-lg shadow-blue-400/20">
        <Icon className="h-8 w-8 text-white" strokeWidth={2} />
      </span>
      {Badge && (
        <span className="absolute bottom-1 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-blue-500 shadow-md shadow-blue-300/40 ring-2 ring-blue-100">
          <Badge className="h-4 w-4" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
