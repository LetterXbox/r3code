import { signal } from "nsh";

const visible = signal(false);
export const addProjectOpen = () => visible();
export function showAddProject() { visible.set(true); }
export function closeAddProject() { visible.set(false); }
