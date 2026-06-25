import logo from "../assets/logo.png";

export function Header() {
  return (
    <div
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      className="fixed left-3 z-40 flex items-center gap-1.5 rounded-full border border-slate-300 bg-white/90 px-2 py-1 shadow-sm backdrop-blur"
    >
      <img src={logo} alt="" className="h-6 w-6 shrink-0" />
      <span className="font-display text-sm font-semibold text-[var(--color-accent-dark)]">
        Moments
      </span>
    </div>
  );
}
