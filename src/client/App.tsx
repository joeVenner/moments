import { lazy, Suspense } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { I18nProvider } from "./lib/i18n";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { ClickSpark } from "./components/ClickSpark";

const Home = lazy(() => import("./pages/Home"));
const Admin = lazy(() => import("./pages/Admin"));
const EventPage = lazy(() => import("./pages/EventPage"));
const Slideshow = lazy(() => import("./pages/Slideshow"));

function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-[var(--color-bg)]">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]" />
    </div>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const isSlideshow = pathname.endsWith("/slideshow");

  return (
    <I18nProvider>
      <ClickSpark />
      {!isSlideshow && <Header />}
      {!isSlideshow && <LanguageSwitcher />}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/e/:slug" element={<EventPage />} />
          <Route path="/e/:slug/slideshow" element={<Slideshow />} />
        </Routes>
      </Suspense>
      {!isSlideshow && <Footer />}
    </I18nProvider>
  );
}
