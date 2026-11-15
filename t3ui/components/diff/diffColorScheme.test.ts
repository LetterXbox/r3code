import { expect, test } from "nsh/test";
import { updateSetting } from "../../store";
import {
  diffAdditionClass, diffDeletionClass, diffColorSchemeIsBlueOrange,
  diffAdditionBgClass, diffDeletionBgClass, diffAdditionWordBgClass, diffDeletionWordBgClass,
  diffAdditionIndicatorClass, diffDeletionIndicatorClass, diffModifiedClass, diffViewColorClasses,
} from "./diffColorScheme";

test("diff colors default to red-green and pass the caller's class through unchanged", () => {
  updateSetting("diffColorScheme", "red-green");
  expect(diffColorSchemeIsBlueOrange()).toBe(false);
  expect(diffAdditionClass("text-emerald-700 dark:text-emerald-400")).toBe("text-emerald-700 dark:text-emerald-400");
  expect(diffDeletionClass("text-red-700 dark:text-red-400")).toBe("text-red-700 dark:text-red-400");
  expect(diffAdditionBgClass(undefined)).toBe(undefined);
  expect(diffModifiedClass("text-info-foreground")).toBe("text-info-foreground");
  expect(diffViewColorClasses()).toBe(undefined);
});

test("switching diffColorScheme to blue-orange recolors additions blue and deletions orange, live", () => {
  updateSetting("diffColorScheme", "blue-orange");
  expect(diffColorSchemeIsBlueOrange()).toBe(true);
  expect(diffAdditionClass("text-emerald-700 dark:text-emerald-400")).toBe("text-blue-600 dark:text-blue-400");
  expect(diffDeletionClass("text-red-700 dark:text-red-400")).toBe("text-orange-600 dark:text-orange-400");
  // Any default class is overridden the same way, since every consumer shares this helper.
  expect(diffAdditionClass("text-success")).toBe("text-blue-600 dark:text-blue-400");
  expect(diffDeletionClass("text-destructive")).toBe("text-orange-600 dark:text-orange-400");
  // The row tint, the stronger word tint, and the gutter indicator all move together, and the
  // word tint is a step stronger than the line tint (the reference's 80% mix vs. its 50/70%).
  expect(diffAdditionBgClass(undefined)).toBe("bg-blue-50 dark:bg-blue-950");
  expect(diffAdditionWordBgClass(undefined)).toBe("bg-blue-100 dark:bg-blue-900");
  expect(diffDeletionBgClass(undefined)).toBe("bg-orange-50 dark:bg-orange-950");
  expect(diffDeletionWordBgClass(undefined)).toBe("bg-orange-100 dark:bg-orange-900");
  expect(diffAdditionIndicatorClass(undefined)).toBe("bg-blue-600 dark:bg-blue-400 text-blue-600 dark:text-blue-400");
  expect(diffDeletionIndicatorClass(undefined)).toBe("bg-orange-600 dark:bg-orange-400 text-orange-600 dark:text-orange-400");
  // Blue is now spent on additions, so the "modified"/"renamed" mark mutes instead of colliding.
  expect(diffModifiedClass("text-info-foreground")).toBe("text-muted-foreground");
  expect(diffViewColorClasses()).toEqual({
    lineAdded: "bg-blue-50 dark:bg-blue-950", lineDeleted: "bg-orange-50 dark:bg-orange-950",
    wordAdded: "bg-blue-100 dark:bg-blue-900", wordDeleted: "bg-orange-100 dark:bg-orange-900",
    lineNumberAdded: "text-blue-600 dark:text-blue-400", lineNumberDeleted: "text-orange-600 dark:text-orange-400",
    indicatorAdded: "bg-blue-600 dark:bg-blue-400 text-blue-600 dark:text-blue-400",
    indicatorDeleted: "bg-orange-600 dark:bg-orange-400 text-orange-600 dark:text-orange-400",
  });
  updateSetting("diffColorScheme", "red-green");
});
