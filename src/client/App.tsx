import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Admin from "./pages/Admin";
import EventPage from "./pages/EventPage";
import { I18nProvider } from "./lib/i18n";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";

export default function App() {
  return (
    <I18nProvider>
      <Header />
      <LanguageSwitcher />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/e/:slug" element={<EventPage />} />
      </Routes>
      <Footer />
    </I18nProvider>
  );
}
