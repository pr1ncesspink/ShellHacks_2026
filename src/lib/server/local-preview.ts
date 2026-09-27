import "server-only";
import { headers } from "next/headers";
import { allowLocalPreview } from "../local-preview";

export async function isLocalPreview() {
  const requestHeaders = await headers();
  return allowLocalPreview(process.env, requestHeaders.get("host"), requestHeaders.get("x-forwarded-host"));
}
