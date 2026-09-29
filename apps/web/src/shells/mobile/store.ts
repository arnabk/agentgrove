import { createSignal } from "solid-js";

/**
 * Mobile-shell-local navigation state. Deliberately not in
 * core/stores/app: the desktop shell has no bottom tab bar or drawer,
 * and persisting this into the shared layout blob would leak mobile
 * concepts into every desktop client's state.
 */
export type MobileTab = "chats" | "team" | "notes" | "settings";

export const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: "chats", label: "Chats" },
  { id: "team", label: "Team" },
  { id: "notes", label: "Notes" },
  { id: "settings", label: "Settings" },
];

const TAB_KEY = "ag-mobile-tab";

function isTab(v: unknown): v is MobileTab {
  return v === "chats" || v === "team" || v === "notes" || v === "settings";
}

function loadTab(): MobileTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return isTab(v) ? v : "chats";
  } catch {
    return "chats";
  }
}

const [tab, setTab] = createSignal<MobileTab>(loadTab());

export const mobileTab = tab;

export function setMobileTab(next: MobileTab) {
  setTab(next);
  try {
    localStorage.setItem(TAB_KEY, next);
  } catch {
    // private mode — the tab just won't be remembered
  }
}

/** Navigation drawer (projects + worktrees). */
export const [drawerOpen, setDrawerOpen] = createSignal(false);

/**
 * The conversation the Chats tab has drilled into, or null for the
 * list. Lives here rather than inside ChatView because the shell header
 * swaps its hamburger for a back arrow based on it.
 */
export const [openChatId, setOpenChatId] = createSignal<string | null>(null);
