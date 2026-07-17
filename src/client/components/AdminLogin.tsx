import { useState } from "react";
import { verifyAdminCredentials } from "../lib/api";
import { setAdminAuth } from "../lib/adminAuth";
import { useI18n } from "../lib/i18n";

export function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const ok = await verifyAdminCredentials(username, password);
      if (!ok) {
        setError(t("incorrectCredentials"));
        return;
      }
      setAdminAuth(username, password);
      onSuccess();
    } catch {
      setError(t("serverUnreachable"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--color-bg)] px-6">
      <div className="text-center">
        <h1 className="font-mono text-2xl font-semibold text-[var(--color-accent-dark)]">
          Moments — Admin
        </h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t("adminSignInPrompt")}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xs flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-5"
      >
        <input
          name="username"
          autoComplete="username"
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("usernamePlaceholder")}
          className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
        />
        <input
          name="password"
          autoComplete="current-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("passwordPlaceholder")}
          className="rounded-lg border border-[var(--color-border)] px-3 py-3 text-base outline-none focus:border-[var(--color-accent)]"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!username || !password || loading}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-3 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? t("signingIn") : t("signIn")}
        </button>
      </form>
    </div>
  );
}
