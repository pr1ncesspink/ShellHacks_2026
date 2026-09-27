import type { Metadata, Viewport } from "next";
import { SessionSync } from "@/components/auth/session-sync";
import { isLocalPreview } from "@/lib/server/local-preview";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "GridLens — Project Clarity", template: "%s | GridLens" },
  description:
    "A clearer view of construction project overlap and coordination.",
  icons: { icon: "/gridlens-mark.svg" },
};
export const viewport: Viewport = { themeColor: "#101d30" };
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const preview = await isLocalPreview();
  return (
    <html lang="en" className="dark">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {!preview && <SessionSync />}
        {preview && (
          <div className="bg-[#101d30] px-4 py-2 text-center text-xs text-[#8a9597]">
            Local design preview · Production sign-in remains enabled
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
