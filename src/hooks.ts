import { useCallback, useRef } from "react";

/** A ref that always holds this render's `value`, for listeners that are registered once. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * `handler` under one identity for the life of the component, always running this render's
 * version of it. For a callback handed to a memoised child, which would otherwise be told
 * it has new props every time the parent renders.
 */
export function useStableCallback<Arguments extends unknown[], Result>(handler: (...args: Arguments) => Result) {
  const latest = useLatest(handler);
  return useCallback((...args: Arguments) => latest.current(...args), [latest]);
}
