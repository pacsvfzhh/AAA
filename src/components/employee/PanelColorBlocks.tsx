export default function PanelColorBlocks() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-blue-200/35"></div>
      <div className="absolute -bottom-20 -left-16 h-64 w-64 rounded-full bg-sky-200/35"></div>
      <div className="absolute left-7 top-[26%] h-14 w-14 rotate-12 rounded-2xl bg-indigo-200/30"></div>
      <div className="absolute bottom-[24%] right-9 h-10 w-10 -rotate-6 rounded-xl bg-blue-300/25"></div>
    </div>
  );
}
