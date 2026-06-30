import { describe, it, expect } from "vitest";
import { listsToTaskLists, countTasks, emptyTodoDoc } from "./notesTodo";

describe("listsToTaskLists", () => {
  it("converts a plain bullet list into a task list", () => {
    const out = listsToTaskLists("<ul><li><p>buy milk</p></li><li><p>walk dog</p></li></ul>");
    expect(out).toContain('data-type="taskList"');
    expect(out).toContain('data-type="taskItem"');
    expect(out).toContain('data-checked="false"');
    expect(out).toContain("buy milk");
    expect(out).toContain("walk dog");
    // two items
    expect(countTasks(out).total).toBe(2);
  });

  it("converts ordered lists too", () => {
    const out = listsToTaskLists("<ol><li><p>first</p></li></ol>");
    expect(out).toContain('data-type="taskList"');
    expect(countTasks(out).total).toBe(1);
  });

  it("leaves existing task lists untouched (idempotent)", () => {
    const existing =
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done item</p></li></ul>';
    const once = listsToTaskLists(existing);
    const twice = listsToTaskLists(once);
    expect(once).toBe(twice);
    // checked state preserved
    expect(countTasks(once)).toEqual({ total: 1, done: 1 });
  });

  it("preserves headings and paragraphs", () => {
    const html = "<h2>Groceries</h2><ul><li><p>eggs</p></li></ul><p>note text</p>";
    const out = listsToTaskLists(html);
    expect(out).toContain("<h2>Groceries</h2>");
    expect(out).toContain("note text");
    expect(out).toContain('data-type="taskList"');
  });

  it("does not lose text in nested content", () => {
    const html = "<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li></ul>";
    const out = listsToTaskLists(html);
    expect(out).toContain("parent");
    expect(out).toContain("child");
  });

  it("returns empty string for empty input", () => {
    expect(listsToTaskLists("")).toBe("");
  });
});

describe("countTasks", () => {
  it("counts total and done", () => {
    const html =
      '<ul data-type="taskList">' +
      '<li data-type="taskItem" data-checked="true"><p>a</p></li>' +
      '<li data-type="taskItem" data-checked="false"><p>b</p></li>' +
      "</ul>";
    expect(countTasks(html)).toEqual({ total: 2, done: 1 });
  });
});

describe("emptyTodoDoc", () => {
  it("is a single unchecked task item", () => {
    expect(countTasks(emptyTodoDoc())).toEqual({ total: 1, done: 0 });
  });
});
