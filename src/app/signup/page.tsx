import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Layers3, ShieldCheck } from "lucide-react";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { Brand } from "@/components/brand";
import { getUser } from "@/lib/server/session";

export const metadata = { title: "Create account" };

export default async function SignupPage() {
  if (await getUser()) redirect("/dashboard");
  return (
    <div className="login-page">
      <header className="login-header">
        <Brand />
        <Link href="/" className="subtle-link">
          Back to sign in <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <p className="eyebrow">Get started</p>
          <h1>
            A place for <br />
            your plans. <br />
            <span>A view of what’s next.</span>
          </h1>
          <p>
            Create an account with your email.
            <br />
            You’ll verify it before opening your private workspace.
          </p>
          <div className="signup-benefits">
            <div>
              <Layers3
                size={16}
                aria-hidden="true"
                className="text-muted-foreground"
              />
              <span>
                One connected workspace
                <small>Project context, overlap insights, and room to plan.</small>
              </span>
            </div>
            <div>
              <ShieldCheck
                size={16}
                aria-hidden="true"
                className="text-muted-foreground"
              />
              <span>
                Verified access
                <small>
                  Your workspace opens once Firebase verifies your email.
                </small>
              </span>
            </div>
          </div>
        </section>
        <SignUpForm />
      </main>
    </div>
  );
}
