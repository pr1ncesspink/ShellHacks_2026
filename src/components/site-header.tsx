import Link from "next/link";
import Image from "next/image";
import { LayoutDashboard, LogOut } from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Brand } from "@/components/brand";

export type SiteUser = {
  email: string | null;
  name: string | null;
};

export function SiteHeader({
  active,
  user,
}: {
  active: "dashboard" | "budget" | "profile";
  user: SiteUser;
}) {
  const displayName = user.name?.trim() || user.email || "GridLens member";
  const detail = user.email || "Verified account";
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
        </nav>
        <div className="profile-area">
          <span className="profile-copy">
            {displayName}
            <small>{detail}</small>
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
              alt=""
              width={38}
              height={38}
              className="avatar"
            />
          </Link>
          <SignOutButton
            variant="ghost"
            size="icon"
            className="exit-link"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={17} aria-hidden="true" />
            <span className="sr-only">Sign out</span>
          </SignOutButton>
        </div>
      </div>
    </header>
  );
}
