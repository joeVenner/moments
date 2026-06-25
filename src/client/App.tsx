import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Admin from "./pages/Admin";
import EventPage from "./pages/EventPage";
import { I18nProvider } from "./lib/i18n";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

export default function App() {
  return (
    <I18nProvider>
      <LanguageSwitcher />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/e/:slug" element={<EventPage />} />
      </Routes>
    </I18nProvider>
  );
}
