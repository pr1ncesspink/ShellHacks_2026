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

export const metadata = { title: "Account & Profile" };
export default function ProfilePage() {
  return (
    <>
      <SiteHeader active="profile" />
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
                alt="Placeholder user profile"
                width={88}
                height={88}
                className="profile-portrait"
              />
              <span className="eyebrow">YOUR GRIDLENS ACCOUNT</span>
              <h2>Your name</h2>
              <p>Project planner</p>
              <Badge variant="outline" className="muted-badge">
                EXAMPLE PROFILE
              </Badge>
              <div className="profile-team">
                <span>
                  Your organization<small>Team details will appear here</small>
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
                  <dd>Your name</dd>
                </div>
                <div>
                  <dt>Work email</dt>
                  <dd>you@company.com</dd>
                </div>
                <div>
                  <dt>Organization</dt>
                  <dd>Your organization</dd>
                </div>
                <div>
                  <dt>Role</dt>
                  <dd>Project planner</dd>
                </div>
              </dl>
              <p className="profile-note">
                These are example details. Profile editing and saving will be
                available when accounts are connected.
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
                  <p>Account sign-in is not connected yet.</p>
                </div>
                <Badge variant="outline" className="muted-badge">
                  NOT CONNECTED
                </Badge>
              </div>
              <div className="security-row">
                <Fingerprint size={21} aria-hidden="true" />
                <div>
                  <h3>Two-step verification</h3>
                  <p>Authenticator setup is a visual placeholder.</p>
                </div>
                <Badge variant="outline" className="muted-badge">
                  NOT SET UP
                </Badge>
              </div>
              <Link href="/" className="subtle-link">
                View sign-in preview <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </Card>
          </section>
        </div>
        <p className="budget-disclaimer">
          Profile preview only. No account, saved personal details, or
          authentication is active.
        </p>
        <WorkspaceFooter />
      </main>
    </>
  );
}
