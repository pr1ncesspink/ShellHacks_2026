import type { Metadata, Viewport } from "next";
import { SessionSync } from "@/components/auth/session-sync";
import { isLocalPreview } from "@/lib/server/local-preview";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CollideAverse — Project Clarity", template: "%s | CollideAverse" },
  description:
    "A clearer view of construction project overlap and coordination.",
  icons: { icon: "/collideaverse-icon.png", apple: "/collideaverse-logo.jpg" },
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
          <div className="border-b border-border bg-background px-4 py-2 text-center text-xs text-muted-foreground">
            Local design preview · Production sign-in remains enabled
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
