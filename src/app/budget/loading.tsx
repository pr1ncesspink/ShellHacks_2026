const block = "rounded-lg bg-muted motion-safe:animate-pulse";

export default function Loading() {
  return (
    <main id="main-content" className="workspace" aria-busy="true">
      <div role="status" className="grid gap-6">
        <span className="sr-only">Loading budget workspace…</span>
        <div className="grid gap-3" aria-hidden="true">
          <div className={`${block} h-4 w-40`} />
          <div className={`${block} h-9 w-full max-w-md`} />
          <div className={`${block} h-4 w-full max-w-lg`} />
        </div>
        <div className="grid gap-6 min-[801px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" aria-hidden="true">
          <div className="grid content-start gap-6">
            <div className={`${block} h-56 w-full`} />
            <div className={`${block} h-32 w-full`} />
          </div>
          <div className={`${block} h-[540px] w-full`} />
        </div>
      </div>
    </main>
  );
}
