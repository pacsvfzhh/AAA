interface AdminPageLoadingProps {
  label: string;
}

export default function AdminPageLoading({ label }: AdminPageLoadingProps) {
  return (
    <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 text-center text-slate-400">
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 shadow-[0_0_30px_rgba(34,211,238,0.12)]">
        <span className="absolute inset-1 animate-ping rounded-xl border border-cyan-300/25 [animation-duration:1.6s]" />
        <span className="relative h-8 w-8 animate-spin rounded-full border-[3px] border-cyan-300/25 border-t-cyan-300" />
      </div>
      <div>
        <p className="text-sm font-semibold text-cyan-100">正在載入{label}</p>
        <p className="mt-1 text-[11px] text-slate-500">正在準備頁面資料，請稍候……</p>
      </div>
    </div>
  );
}
