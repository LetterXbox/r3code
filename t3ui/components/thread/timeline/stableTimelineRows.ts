import { createStableRows } from "../../stableRows";
import type { FoldedRow } from "./turnFolds";

/** Keep unchanged transcript rows mounted while preserving updates and thread isolation. */
export const createStableTimelineRows = () => createStableRows<FoldedRow>((row) => row.id);
