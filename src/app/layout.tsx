import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "GridLens — Project Clarity", template: "%s | GridLens" },
  description:
    "A clearer view of construction project overlap and coordination.",
  icons: { icon: "/gridlens-mark.svg" },
};
export const viewport: Viewport = { themeColor: "#101d30" };
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
