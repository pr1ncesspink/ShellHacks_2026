import { redirect } from "next/navigation";
import { Layers3 } from "lucide-react";
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
            <span>02 / VERIFY</span>
            <span>03 / COORDINATE</span>
          </div>
        </section>
        <SignInForm nextPath={nextPath} />
      </main>
      <footer className="login-footer">
        <span>GridLens / Built for better coordination.</span>
        <span>One connected view.</span>
      </footer>
    </div>
  );
}
