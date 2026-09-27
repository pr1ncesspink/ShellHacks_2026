import { Fingerprint, UserRound } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/server/session";

export const metadata = { title: "Account and profile" };
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
            <p className="breadcrumb">
              Workspace <span aria-hidden="true">/</span> Account and profile
            </p>
            <h1>Your account</h1>
            <p>Your identity, your team, and your account preferences.</p>
          </div>
          <Badge variant="outline" className="muted-badge">
            Profile preview
          </Badge>
        </div>
        <div className="profile-grid">
          <div className="profile-summary-stack">
            <Card className="profile-summary panel">
              <div className="profile-cover" aria-hidden="true" />
              <div className="profile-summary-content">
                <span
                  className="profile-portrait flex size-[88px] items-center justify-center bg-muted text-muted-foreground"
                  aria-hidden="true"
                >
                  <UserRound size={20} aria-hidden="true" />
                </span>
                <span className="eyebrow">Your GridLens account</span>
                <h2>{displayName}</h2>
                <p>{email}</p>
                <Badge variant="success">Verified account</Badge>
                <div className="profile-team">
                  <span>
                    Organization preview
                    <small>Team details are not connected yet</small>
                  </span>
                </div>
              </div>
            </Card>
          </div>
          <section className="profile-details" aria-label="Account information">
            <Card className="profile-info panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">About you</span>
                  <h2>Profile information</h2>
                </div>
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
                organization and role are still previews.
              </p>
            </Card>
            <Card className="profile-info panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Account access</span>
                  <h2>Sign-in and verification</h2>
                </div>
              </div>
              <div className="security-row">
                <UserRound size={20} aria-hidden="true" />
                <div>
                  <h3>Email and password</h3>
                  <p>{email} is verified for workspace access.</p>
                </div>
                <Badge variant="success">Verified</Badge>
              </div>
              <div className="security-row">
                <Fingerprint size={20} aria-hidden="true" />
                <div>
                  <h3>Additional sign-in factors</h3>
                  <p>Multi-factor authentication is coming later.</p>
                </div>
                <Badge variant="outline" className="muted-badge">
                  Preview
                </Badge>
              </div>
            </Card>
          </section>
        </div>
        <p className="budget-disclaimer">
          Organization, role, profile editing, and multi-factor settings are
          previews. Your Firebase name and verified email are live.
        </p>
      </main>
    </>
  );
}
