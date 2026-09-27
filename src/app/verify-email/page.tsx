import { redirect } from "next/navigation";
import { MailCheck, ShieldCheck } from "lucide-react";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { Brand } from "@/components/brand";
import { safeNext } from "@/lib/session";
import { getUser } from "@/lib/server/session";

export const metadata = { title: "Verify Email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = safeNext(
    typeof params.next === "string" ? params.next : undefined,
  );
  if (await getUser()) redirect(nextPath);

  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
        <span className="login-header-label">VERIFIED WORKSPACE ACCESS</span>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <div className="eyebrow">
            <span className="tiny-dot" />
            ONE QUICK CONFIRMATION.
          </div>
          <h1>
            Your inbox <br />
            holds the key. <br />
            <span>Then you’re ready.</span>
          </h1>
          <p>
            Firebase sends a verification link, not a six-digit code.
            <br />
            Use it, return here, and continue securely.
          </p>
          <div className="signup-benefits">
            <div>
              <MailCheck size={20} aria-hidden="true" />
              <span>
                Follow the email link
                <small>
                  Check spam or resend the message after the cooldown.
                </small>
              </span>
            </div>
            <div>
              <ShieldCheck size={20} aria-hidden="true" />
              <span>
                Protected by default
                <small>
                  No workspace session exists until verification succeeds.
                </small>
              </span>
            </div>
          </div>
        </section>
        <VerifyEmailPanel nextPath={nextPath} />
      </main>
      <footer className="login-footer">
        <span>GridLens / Built for better coordination.</span>
        <span>One connected view.</span>
      </footer>
    </div>
  );
}
