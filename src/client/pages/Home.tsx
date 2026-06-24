import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] px-6 text-center">
      <h1 className="text-4xl font-semibold text-[var(--color-accent-dark)]">Moments</h1>
      <p className="max-w-sm text-sm text-slate-600">
        Scan a QR code at your event to share photos and videos instantly with everyone there.
      </p>
      <Link
        to="/admin"
        className="mt-2 rounded-full bg-[var(--color-accent)] px-5 py-2 font-mono text-sm font-medium text-white transition hover:bg-[var(--color-accent-dark)]"
      >
        Open Admin Panel
      </Link>
    </div>
  );
}
