const block = "rounded-lg bg-muted motion-safe:animate-pulse";

export default function Loading() {
  return (
    <main id="main-content" className="workspace" aria-busy="true">
      <div role="status" className="grid gap-6">
        <span className="sr-only">Loading upload summary…</span>
        <div className="grid gap-3" aria-hidden="true">
          <div className={`${block} h-4 w-40`} />
          <div className={`${block} h-9 w-full max-w-md`} />
          <div className={`${block} h-4 w-full max-w-lg`} />
        </div>
        <div className="grid gap-4" aria-hidden="true">
          <div className={`${block} h-6 w-2/3`} />
          <div className={`${block} h-20 w-full`} />
          <div className={`${block} h-32 w-full`} />
        </div>
        <div className={`${block} h-[420px] w-full`} aria-hidden="true" />
      </div>
    </main>
  );
}
