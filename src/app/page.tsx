import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Brand } from "@/components/brand";
import { safeNext } from "@/lib/session";
import { getUser } from "@/lib/server/session";

export default async function LoginPage({
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
        <span className="login-header-label">Construction overlap simulator</span>
      </header>
      <main id="main-content" className="login-main">
        <section className="login-story">
          <p className="eyebrow">Connected projects, clearer decisions</p>
          <h1>
            Great projects <br />
            start with a <br />
            <span>shared perspective.</span>
          </h1>
          <p>
            Bring your plans together and see where they overlap,
            <br className="desktop-break" /> so every crew can plan around the
            others.
          </p>
          <ol className="story-bottom" aria-label="How GridLens works">
            <li>1. Connect</li>
            <li>2. Verify</li>
            <li>3. Coordinate</li>
          </ol>
        </section>
        <SignInForm nextPath={nextPath} />
      </main>
    </div>
  );
}
