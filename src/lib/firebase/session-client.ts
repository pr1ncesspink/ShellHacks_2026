"use client";

export async function postSession(
  idToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
    signal,
  });
  if (!response.ok) throw new Error("Session could not be established");
}

export async function deleteSession(signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/session", { method: "DELETE", signal });
  if (!response.ok && response.status !== 401) {
    throw new Error("Session could not be cleared");
  }
}
