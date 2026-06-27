import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { BrandMark } from "./BrandMark";
import { prefersReducedMotion } from "../lib/motion";

export function Header() {
  const { pathname } = useLocation();
  // Only the event feed has the sticky greeting/points bar. On mobile that bar
  // spans the full-width rail and the floating mark overlaps "Hi, …", so we hide
  // the mark once the user scrolls and the sticky bar takes over the top. On
  // desktop the mark sits in the page margin (never crowds the centered rail), so
  // it stays put — "no impact" there, per Yassir.
  const onEventPage = pathname.startsWith("/e/");
  const [hidden, setHidden] = useState(false);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!onEventPage) {
      setHidden(false);
      return;
    }
    const mobile = window.matchMedia("(max-width: 639px)");
    function onScroll() {
      setHidden(mobile.matches && window.scrollY > 80);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [onEventPage]);

  return (
    <Link
      to="/"
      aria-label="Moments — home"
      style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      className={`fixed left-3 z-40 flex items-center gap-1.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)] ${
        reduced ? "" : "transition-[opacity,transform] duration-300 ease-out"
      } ${hidden ? "pointer-events-none -translate-y-6 opacity-0" : "opacity-100"}`}
    >
      <BrandMark className="h-6 w-6 shrink-0" />
      <span className="font-display text-sm font-semibold text-[var(--color-text)]">
        Moments
      </span>
    </Link>
  );
}