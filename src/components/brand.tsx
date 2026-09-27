import Image from "next/image";
import Link from "next/link";
export function Brand() {
  return (
    <Link href="/dashboard" className="brand" aria-label="CollideAverse dashboard">
      <Image src="/collideaverse-logo.jpg" alt="" width={36} height={36} />
      <span translate="no">
        CollideAverse<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
