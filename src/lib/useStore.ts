import { useSyncExternalStore } from "react";
import type { Store } from "./store";

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
