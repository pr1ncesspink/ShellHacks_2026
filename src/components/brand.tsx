import Image from "next/image";
import Link from "next/link";
export function Brand() {
  return (
    <Link href="/dashboard" className="brand" aria-label="GridLens dashboard">
      <Image src="/gridlens-mark.svg" alt="" width={36} height={36} />
      <span translate="no">
        GridLens<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
