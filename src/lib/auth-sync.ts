export type AuthSyncRequest = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

let revision = 0;
let activeController: AbortController | null = null;
let explicitAuthActions = 0;

export function beginAuthSyncRequest(): AuthSyncRequest {
  activeController?.abort();
  const controller = new AbortController();
  const requestRevision = ++revision;
  activeController = controller;
  return {
    signal: controller.signal,
    isCurrent: () =>
      requestRevision === revision && !controller.signal.aborted,
  };
}

export function cancelAuthSyncRequests(): void {
  revision += 1;
  activeController?.abort();
  activeController = null;
}

export function beginExplicitAuthAction(): () => void {
  explicitAuthActions += 1;
  cancelAuthSyncRequests();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    explicitAuthActions = Math.max(0, explicitAuthActions - 1);
  };
}

export function isExplicitAuthActionActive(): boolean {
  return explicitAuthActions > 0;
}
