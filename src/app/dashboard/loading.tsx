const block = "rounded-lg bg-muted motion-safe:animate-pulse";

export default function Loading() {
  return (
    <main id="main-content" className="workspace" aria-busy="true">
      <div role="status" className="grid gap-6">
        <span className="sr-only">Loading your dashboard…</span>
        <div className="grid gap-3" aria-hidden="true">
          <div className={`${block} h-4 w-40`} />
          <div className={`${block} h-9 w-full max-w-md`} />
          <div className={`${block} h-4 w-full max-w-lg`} />
        </div>
        <div className={`${block} h-40 w-full`} aria-hidden="true" />
        <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
          <div className="grid gap-4">
            <div className={`${block} h-24 w-full`} />
            <div className="grid grid-cols-2 gap-4">
              <div className={`${block} h-32`} />
              <div className={`${block} h-32`} />
            </div>
            <div className={`${block} h-48 w-full`} />
          </div>
          <div className={`${block} h-[480px] w-full`} />
        </div>
      </div>
    </main>
  );
}
