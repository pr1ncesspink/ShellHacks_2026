import Link from "next/link";
import Image from "next/image";
import { LayoutDashboard, ChartNoAxesCombined, LogOut } from "lucide-react";
import { Brand } from "./brand";
export function SiteHeader({
  active,
}: {
  active: "dashboard" | "budget" | "profile";
}) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="Main navigation" className="main-nav">
          <Link
            href="/dashboard"
            aria-current={active === "dashboard" ? "page" : undefined}
          >
            <LayoutDashboard size={16} aria-hidden="true" />
            Dashboard
          </Link>
          <Link
            href="/budget"
            aria-current={active === "budget" ? "page" : undefined}
          >
            <ChartNoAxesCombined size={17} aria-hidden="true" />
            Budget summary
          </Link>
        </nav>
        <div className="profile-area">
          <span className="profile-copy">
            Your workspace<small>Project planner</small>
          </span>
          <Link
            href="/profile"
            className="profile-link"
            aria-label="View your account and profile"
            aria-current={active === "profile" ? "page" : undefined}
            title="Account and profile"
          >
            <Image
              src="/profile.svg"
              alt="Placeholder user profile"
              width={38}
              height={38}
              className="avatar"
            />
          </Link>
          <Link
            href="/"
            className="exit-link"
            aria-label="View login preview"
            title="View login preview"
          >
            <LogOut size={17} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  );
}
