/**
 * The last error that nothing caught: a `window` "error" event or an
 * unhandled promise rejection (main.tsx listens for both). Error reports
 * include it, because the error a person sees can be a symptom of it.
 * It stays in this tab's memory and is never sent anywhere.
 */
import { failureOf, type Failure } from './errorReport.ts';

let last: Failure | null = null;
const listeners = new Set<() => void>();

export function recordUncaught(error: unknown, code = 'uncaught'): void {
  last = failureOf(error, code);
  for (const listener of listeners) listener();
}

export function lastUncaught(): Failure | null {
  return last;
}

export function subscribeUncaught(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Listen on a window for errors that nothing caught. Returns a function that stops listening. */
export function listenForUncaught(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const onError = (event: ErrorEvent) => recordUncaught(event.error ?? event.message, 'uncaught-error');
  const onRejection = (event: PromiseRejectionEvent) => recordUncaught(event.reason, 'unhandled-rejection');
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Forget the last error: a new document starts with a clean report. */
export function resetUncaught(): void {
  last = null;
  for (const listener of listeners) listener();
}
