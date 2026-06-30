/**
 * Helpers for the todo-style Notes editor.
 *
 * The Notes pane is a workspace-global checklist. To keep the editor
 * "todo-first" without risking the user's existing notes, we convert
 * plain bullet / numbered lists into Tiptap task lists on load. The
 * transform is:
 *
 *   - NON-destructive in intent: it only rewrites list markup into the
 *     equivalent task-list markup. Text, headings, paragraphs, links,
 *     and existing task lists are left untouched.
 *   - Idempotent: running it twice yields the same result (an already
 *     converted task list is recognised and skipped).
 *
 * Implemented as a string/DOM transform on the stored HTML rather than
 * a ProseMirror transaction so it can run BEFORE `setContent` and be
 * unit-tested without a live editor.
 */

/** A Tiptap-shaped task list `<ul data-type="taskList">` opening tag. */
const TASK_LIST_OPEN = '<ul data-type="taskList">';

/**
 * Convert every plain `<ul>` / `<ol>` in `html` into an unchecked
 * Tiptap task list. Lists that are already task lists (they carry
 * `data-type="taskList"`) are left as-is. Headings, paragraphs, and
 * other content pass through unchanged.
 *
 * Returns the transformed HTML. Safe to call on empty / undefined-ish
 * input (returns an empty string).
 */
export function listsToTaskLists(html: string): string {
  if (!html) return "";
  if (typeof document === "undefined") return html;

  const root = document.createElement("div");
  root.innerHTML = html;

  // Convert each plain list. Walk a snapshot of the node list because
  // we mutate the tree as we go.
  const lists = Array.from(root.querySelectorAll("ul, ol"));
  for (const list of lists) {
    // Already a task list? Leave it.
    if (list.getAttribute("data-type") === "taskList") continue;
    // A task list nested inside a converted parent we already handled
    // would have been retagged; skip anything now carrying the marker.
    convertListElement(list);
  }

  return root.innerHTML;
}

/** Retag a single `<ul>`/`<ol>` element in place into a task list,
 *  wrapping each `<li>`'s content the way Tiptap's TaskItem expects:
 *  `<li data-type="taskItem" data-checked="false">…</li>`. */
function convertListElement(list: Element): void {
  const taskList = document.createElement("ul");
  taskList.setAttribute("data-type", "taskList");

  for (const li of Array.from(list.children)) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const item = document.createElement("li");
    item.setAttribute("data-type", "taskItem");
    item.setAttribute("data-checked", "false");
    // Preserve the original inner markup (paragraphs, nested lists,
    // links, …). Tiptap re-wraps this on parse; keeping it verbatim
    // means no text is lost.
    item.innerHTML = li.innerHTML;
    taskList.appendChild(item);
  }

  list.replaceWith(taskList);
}

/** Count of checked vs. unchecked task items in the given HTML. Used
 *  to render the "Done (N)" toggle label without reaching into the
 *  live editor. */
export function countTasks(html: string): { total: number; done: number } {
  if (!html || typeof document === "undefined") return { total: 0, done: 0 };
  const root = document.createElement("div");
  root.innerHTML = html;
  const items = root.querySelectorAll('li[data-type="taskItem"]');
  let done = 0;
  items.forEach((i) => {
    if (i.getAttribute("data-checked") === "true") done += 1;
  });
  return { total: items.length, done };
}

/** Seed HTML for a brand-new, empty notes doc: a single empty,
 *  unchecked task item so the very first thing the user types is a
 *  todo. */
export function emptyTodoDoc(): string {
  return `${TASK_LIST_OPEN}<li data-type="taskItem" data-checked="false"><p></p></li></ul>`;
}
