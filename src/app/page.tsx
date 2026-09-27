import Link from "next/link";
import {
  ArrowRight,
  Fingerprint,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Layers3,
} from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function LoginPage() {
  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
        <span className="login-header-label">
          CONSTRUCTION OVERLAP SIMULATOR
        </span>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <div className="eyebrow">
            <span className="tiny-dot" />
            CONNECTED PROJECTS. CLEARER DECISIONS.
          </div>
          <h1>
            Great projects <br />
            start with a <br />
            <span>shared perspective.</span>
          </h1>
          <p>
            Bring your plans together. Discover the overlap.
            <br className="desktop-break" /> Build a more coordinated tomorrow.
          </p>
          <div className="architecture-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="plan-layer layer-back">
              <div className="plan-lines" />
            </div>
            <div className="plan-layer layer-middle">
              <div className="plan-lines" />
            </div>
            <div className="plan-layer layer-front">
              <div className="plan-lines" />
              <span className="art-node" />
            </div>
            <span className="art-caption">
              <Layers3 size={14} />
              Clarity, layer by layer.
            </span>
          </div>
          <div className="story-bottom">
            <span>01 / CONNECT</span>
            <span>02 / UNDERSTAND</span>
            <span>03 / COORDINATE</span>
          </div>
        </section>
        <Card className="login-card panel">
          <div className="login-card-top">
            <span className="icon-tile blue">
              <Fingerprint size={25} aria-hidden="true" />
            </span>
            <Badge variant="outline" className="muted-badge">
              AUTHENTICATION PREVIEW
            </Badge>
          </div>
          <h2>Your workspace awaits.</h2>
          <p>A two-step entry to your project workspace.</p>
          <div className="auth-step">
            <span className="step-number">01</span>
            <div>
              <h3>Sign in to GridLens</h3>
              <p>Your work email and password.</p>
            </div>
            <LockKeyhole size={16} aria-hidden="true" />
          </div>
          <div className="auth-fields">
            <label htmlFor="email">Work email</label>
            <div className="input-icon">
              <Mail size={16} aria-hidden="true" />
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com…"
                disabled
              />
            </div>
            <label htmlFor="password">Password</label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password…"
              disabled
            />
          </div>
          <div className="auth-step second-step">
            <span className="step-number">02</span>
            <div>
              <h3>Verify it’s you</h3>
              <p>A six-digit code from your authenticator.</p>
            </div>
            <ShieldCheck size={17} aria-hidden="true" />
          </div>
          <div
            className="otp-preview"
            role="img"
            aria-label="Placeholder for six-digit verification code"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i}>–</span>
            ))}
          </div>
          <div className="auth-notice">
            <LockKeyhole size={14} aria-hidden="true" />
            <span>
              Design preview only. Sign-in and verification aren’t connected.
            </span>
          </div>
          <Button asChild className="preview-button">
            <Link href="/dashboard">
              Preview the workspace
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </Button>
          <p className="preview-caption">
            Explore the dashboard without signing in.
          </p>
          <p className="account-switch">
            New to GridLens?{" "}
            <Link href="/signup">
              Create an account <ArrowRight size={13} aria-hidden="true" />
            </Link>
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
