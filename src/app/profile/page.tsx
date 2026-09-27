import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  UserRound,
  ShieldCheck,
  Fingerprint,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { WorkspaceFooter } from "@/components/workspace";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/server/session";

export const metadata = { title: "Account & Profile" };
export default async function ProfilePage() {
  const user = await requireUser("/profile");
  const displayName = user.name?.trim() || "GridLens member";
  const email = user.email || "Email unavailable";
  return (
    <>
      <SiteHeader active="profile" user={user} />
      <main id="main-content" className="workspace">
        <div className="page-heading">
          <div>
            <div className="breadcrumb">
              WORKSPACE <span>/</span> ACCOUNT & PROFILE
            </div>
            <h1>Your perspective starts here.</h1>
            <p>
              A home for your identity, your team, and your account preferences.
            </p>
          </div>
          <Badge variant="outline" className="muted-badge">
            PROFILE PREVIEW
          </Badge>
        </div>
        <div className="profile-grid">
          <div className="profile-summary-stack">
          <Card className="profile-summary panel">
            <div className="profile-cover" aria-hidden="true" />
            <div className="profile-summary-content">
              <Image
                src="/profile.svg"
                alt=""
                width={88}
                height={88}
                className="profile-portrait"
              />
              <span className="eyebrow">YOUR GRIDLENS ACCOUNT</span>
              <h2>{displayName}</h2>
              <p>{email}</p>
              <Badge variant="outline" className="muted-badge">
                VERIFIED ACCOUNT
              </Badge>
              <div className="profile-team">
                <span>
                  Organization preview
                  <small>Team details are not connected yet</small>
                </span>
              </div>
              <Button asChild className="profile-dashboard-button">
                <Link href="/dashboard">
                  Go to dashboard <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </Card>
          </div>
          <section className="profile-details" aria-label="Account information">
            <Card className="profile-info panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">01 / ABOUT YOU</span>
                  <h2>Profile information</h2>
                </div>
                <span className="icon-tile blue">
                  <UserRound size={19} aria-hidden="true" />
                </span>
              </div>
              <dl className="profile-fields">
                <div>
                  <dt>Full name</dt>
                  <dd>{displayName}</dd>
                </div>
                <div>
                  <dt>Work email</dt>
                  <dd>{email}</dd>
                </div>
                <div>
                  <dt>Organization</dt>
                  <dd>Preview — not connected</dd>
                </div>
                <div>
                  <dt>Role</dt>
                  <dd>Preview — project planner</dd>
                </div>
              </dl>
              <p className="profile-note">
                Name and email come from your verified Firebase account. The
                organization and role remain previews.
              </p>
            </Card>
            <Card className="profile-info panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">02 / ACCOUNT ACCESS</span>
                  <h2>Sign-in & verification</h2>
                </div>
                <span className="icon-tile violet">
                  <ShieldCheck size={19} aria-hidden="true" />
                </span>
              </div>
              <div className="security-row">
                <UserRound size={20} aria-hidden="true" />
                <div>
                  <h3>Email & password</h3>
                  <p>{email} is verified for workspace access.</p>
                </div>
                <Badge variant="outline" className="muted-badge">
                  VERIFIED
                </Badge>
              </div>
              <div className="security-row">
                <Fingerprint size={21} aria-hidden="true" />
                <div>
                  <h3>Additional sign-in factors</h3>
                  <p>Multi-factor authentication is a future preview.</p>
                </div>
                <Badge variant="outline" className="muted-badge">
                  PREVIEW
                </Badge>
              </div>
              <Link href="/dashboard" className="subtle-link">
                Return to dashboard <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </Card>
          </section>
        </div>
        <p className="budget-disclaimer">
          Organization, role, profile editing, and multi-factor settings remain
          previews. Your Firebase name and verified email are live.
        </p>
        <WorkspaceFooter />
      </main>
    </>
  );
}
