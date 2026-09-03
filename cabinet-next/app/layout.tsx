import type { Metadata } from "next";
import "./globals.css";

// This whole app is one client-rendered page ("use client" in page.tsx) —
// every real number on it comes from a browser-side fetch to our own API,
// never from anything Next could statically bake in. Left to Next's own
// default, the page still gets fully static-generated + cached for a full
// year (s-maxage=31536000) since it has no server data dependency to see —
// and each deploy replaces the previous build's hashed JS chunk files, so
// anyone holding a cached copy of the OLD html (a phone browser that just
// doesn't reload tabs, most of all) gets 404s on those chunks forever:
// React never hydrates, every number stays stuck at its loading placeholder
// with no error visible anywhere. force-dynamic renders (and lets nginx/the
// browser cache) fresh on every request instead of once at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ГлавИнструмент — публичный прототип кабинета",
  description: "Интерактивный прототип личного кабинета ИИ-чата ГлавИнструмент.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
