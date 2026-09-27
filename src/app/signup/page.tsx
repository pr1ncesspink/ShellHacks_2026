import Link from "next/link";
import {
  ArrowRight,
  UserPlus,
  ShieldCheck,
  Layers3,
  LockKeyhole,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Create Account" };
export default function SignupPage() {
  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
        <Link href="/" className="subtle-link">
          Back to sign in <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <div className="eyebrow">
            <span className="tiny-dot" />
            YOUR NEXT CHAPTER, CONNECTED.
          </div>
          <h1>
            A place for <br />
            your plans. <br />
            <span>A view of what’s next.</span>
          </h1>
          <p>
            Bring your team’s perspective to every project.
            <br />
            Start with a workspace that brings it all together.
          </p>
          <div className="signup-benefits">
            <div>
              <Layers3 size={20} aria-hidden="true" />
              <span>
                One connected workspace
                <small>
                  Project context, overlap insights, and room to plan.
                </small>
              </span>
            </div>
            <div>
              <ShieldCheck size={20} aria-hidden="true" />
              <span>
                A thoughtful first step
                <small>
                  Account creation and verification are coming next.
                </small>
              </span>
            </div>
          </div>
        </section>
        <Card className="login-card panel">
          <div className="login-card-top">
            <span className="icon-tile violet">
              <UserPlus size={23} aria-hidden="true" />
            </span>
            <Badge variant="outline" className="muted-badge">
              SIGNUP PREVIEW
            </Badge>
          </div>
          <h2>Create your account.</h2>
          <p>Your future home for connected project planning.</p>
          <div className="auth-fields">
            <label htmlFor="signup-name">Full name</label>
            <Input
              id="signup-name"
              name="name"
              autoComplete="name"
              placeholder="Your full name…"
              disabled
            />
            <label htmlFor="signup-email">Work email</label>
            <Input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com…"
              disabled
            />
            <label htmlFor="signup-organization">Organization (optional)</label>
            <Input
              id="signup-organization"
              name="organization"
              autoComplete="organization"
              placeholder="Your company or team…"
              disabled
            />
            <label htmlFor="signup-password">Password</label>
            <Input
              id="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="Create a password…"
              disabled
            />
          </div>
          <div className="auth-step second-step">
            <div>
              <h3>Next: verify your identity</h3>
              <p>Email verification and authenticator setup.</p>
            </div>
            <ShieldCheck size={17} aria-hidden="true" />
          </div>
          <div className="auth-notice">
            <LockKeyhole size={14} aria-hidden="true" />
            <span>
              Design preview only. No account is created and no personal
              information is collected.
            </span>
          </div>
          <Button disabled className="signup-disabled">
            Create account <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <Button asChild variant="outline" className="profile-preview-button">
            <Link href="/profile">
              Preview your profile <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </Button>
          <p className="account-switch">
            Already have an account? <Link href="/">Sign in</Link>
          </p>
        </Card>
      </main>
      <footer className="login-footer">
        <span>GridLens / Built for better coordination.</span>
        <span>One connected view.</span>
      </footer>
    </div>
  );
}
