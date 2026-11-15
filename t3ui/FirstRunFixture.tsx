// One entry for every first-run scenario: each test picks its seed through the storage it opens with
// (`firstRunScenario`), so the ~9.8 MB app is bundled and compiled once per test run instead of once per scenario.
import { Storage } from "nsh";
import "./App";

const SEEDS: Record<string, () => Promise<unknown>> = {
  ready: () => import("./FirstRunSeedReady"),
  noAgent: () => import("./FirstRunSeedNoAgent"),
  used: () => import("./FirstRunSeedUsed"),
  import: () => import("./FirstRunSeedImport"),
};
void Storage.getItem("firstRunScenario").then((scenario) => SEEDS[scenario ?? "ready"]?.());
