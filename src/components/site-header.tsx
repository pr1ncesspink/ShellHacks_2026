import Link from "next/link";
import {
  CalendarRange,
  FileText,
  LayoutDashboard,
  LogOut,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Brand } from "@/components/brand";

export type SiteUser = {
  email: string | null;
  name: string | null;
};

export type SiteSection = "dashboard" | "summary" | "budget" | "profile";

const NAV_ITEMS: { id: Exclude<SiteSection, "profile">; href: string; label: string; icon: LucideIcon }[] = [
  { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "summary", href: "/summary", label: "Summary", icon: FileText },
  { id: "budget", href: "/budget", label: "Budget", icon: CalendarRange },
];

export function SiteHeader({
  active,
  user,
}: {
  active: SiteSection;
  user: SiteUser;
}) {
  const displayName = user.name?.trim() || user.email || "CollideAverse member";
  const detail = user.email || "Verified account";
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="Main navigation" className="main-nav">
          {NAV_ITEMS.map(({ id, href, label, icon: Icon }) => (
            <Link
              key={id}
              href={href}
              aria-current={active === id ? "page" : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </Link>
          ))}
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
            <span
              className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              aria-hidden="true"
            >
              <UserRound size={20} aria-hidden="true" />
            </span>
          </Link>
          <SignOutButton
            variant="ghost"
            size="icon"
            className="exit-link"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={20} aria-hidden="true" />
            <span className="sr-only">Sign out</span>
          </SignOutButton>
        </div>
      </div>
    </header>
  );
}
