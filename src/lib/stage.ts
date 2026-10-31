import { Store } from "./store";

/**
 * perch:     the logo stands on the wordmark / card edge
 * fly:       it lifts off and flies while a transfer runs
 * celebrate: a quick hop when something arrives, then back to perch
 */
export type StageMode = "perch" | "fly" | "celebrate";

export interface StageState {
  mode: StageMode;
  /** 0..1, how hard the bird is working (e.g. transfer speed). */
  effort: number;
}

/** Controls the perched logo from anywhere in the app. */
export const stage = new Store<StageState>({ mode: "perch", effort: 0 });
