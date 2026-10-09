import { useSyncExternalStore } from "react";

export type Store<T> = {
  get: () => T;
  /** Merges `update` (or what it returns for the current state) into the state. */
  set: (update: Partial<T> | ((state: T) => Partial<T>)) => void;
  subscribe: (listener: () => void) => () => void;
  /**
   * The selected slice, re-rendering only when it changes. The selector has to return the
   * same reference for the same state (pick a field, do not build an object), because
   * React compares what it returns with `Object.is`.
   */
  use: <S>(selector: (state: T) => S) => S;
};

/** State that lives outside React, so any component can follow one part of it without the rest. */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const set: Store<T>["set"] = (update) => {
    const patch = typeof update === "function" ? update(state) : update;
    const keys = Object.keys(patch) as Array<keyof T>;
    if (keys.every((key) => Object.is(patch[key], state[key]))) return;
    state = { ...state, ...patch };
    // A listener may unsubscribe while it is being told, hence the copy.
    [...listeners].forEach((listener) => listener());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const use = <S>(selector: (state: T) => S) => useSyncExternalStore(subscribe, () => selector(state));
  return { get, set, subscribe, use };
}
