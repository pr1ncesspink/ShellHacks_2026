import { redirect } from "next/navigation";
import { MailCheck, ShieldCheck } from "lucide-react";
import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { Brand } from "@/components/brand";
import { safeNext } from "@/lib/session";
import { getUser } from "@/lib/server/session";

export const metadata = { title: "Verify email" };

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
        <span className="login-header-label">Verified workspace access</span>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <p className="eyebrow">One quick confirmation</p>
          <h1>
            Your inbox <br />
            holds the key. <br />
            <span>Then you’re ready.</span>
          </h1>
          <p>
            Firebase sends a verification link, not a six-digit code.
            <br />
            Open it, come back here, and continue.
          </p>
          <div className="signup-benefits">
            <div>
              <MailCheck
                size={16}
                aria-hidden="true"
                className="text-muted-foreground"
              />
              <span>
                Follow the email link
                <small>
                  Check your spam folder, or resend the message after the
                  cooldown.
                </small>
              </span>
            </div>
            <div>
              <ShieldCheck
                size={16}
                aria-hidden="true"
                className="text-muted-foreground"
              />
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
    </div>
  );
}
