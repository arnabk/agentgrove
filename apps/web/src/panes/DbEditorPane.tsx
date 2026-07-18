import { For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { sql } from "@codemirror/lang-sql";
import { editorTheme } from "../lib/codemirrorTheme";
import {
  activeConn,
  applyDbFilter,
  clearDbFilter,
  dbColumnCache,
  dbColumns,
  dbConnSubtitle,
  dbFilterCol,
  dbFilterOp,
  dbFilterVal,
  dbLoading,
  dbOffset,
  dbRows,
  dbSelectedTable,
  dbSql,
  dbTables,
  disconnectDb,
  initDb,
  nextDbPage,
  prevDbPage,
  runDbSql,
  setDbFilterCol,
  setDbFilterOp,
  setDbFilterVal,
  setDbSql,
} from "../stores/db";

/** DB editor tab: SQL editor + results grid for the connection selected
 *  in the left rail's Database view. Connection management and the
 *  tables tree live there (VSCode SQLTools-style); this pane is just
 *  the work surface. All state is shared via `stores/db`. */

const sqlComp = new Compartment();

/** Completion namespace: every table, with columns once the background
 *  prefetch has described it. */
function buildSchema(): Record<string, string[]> {
  const cache = dbColumnCache();
  const out: Record<string, string[]> = {};
  for (const t of dbTables()) out[t] = cache[t] ?? [];
  return out;
}

export default function DbEditorPane() {
  let host!: HTMLDivElement;
  let view: EditorView | null = null;

  onMount(() => {
    void initDb();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: dbSql(),
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                void runDbSql();
                return true;
              },
            },
            {
              key: "Ctrl-Enter",
              preventDefault: true,
              run: () => {
                void runDbSql();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...closeBracketsKeymap,
          ]),
          closeBrackets(),
          autocompletion(),
          sqlComp.of(sql({ schema: buildSchema(), upperCaseKeywords: true })),
          placeholder("SELECT * FROM …  (Ctrl/Cmd+Enter to run)"),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDbSql(u.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "96px", fontSize: "var(--ag-font-size, 15px)" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-content, .cm-scroller": {
              fontFamily: "var(--ag-font-mono)",
            },
          }),
        ],
      }),
    });
  });

  // Keep the SQL extension's completion namespace in sync with the
  // table list + column cache for the active connection.
  createEffect(() => {
    const ext = sql({ schema: buildSchema(), upperCaseKeywords: true });
    view?.dispatch({ effects: sqlComp.reconfigure(ext) });
  });

  onCleanup(() => {
    view?.destroy();
    view = null;
  });

  function renderCell(v: unknown): string {
    if (v === null) return "NULL";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  return (
    <div class="flex h-full w-full text-[13px]">
      <div class="flex-1 flex flex-col min-w-0">
        <Show
          when={activeConn()}
          fallback={
            <div class="flex-1 flex items-center justify-center text-fg-subtle px-6 text-center">
              Select a connection in the Database view of the left rail.
            </div>
          }
        >
          {(conn) => (
            <>
              <div class="px-3 py-2 border-b border-border flex items-center gap-2 bg-bg-1">
                <span class="font-medium">{conn().name}</span>
                <span class="text-fg-subtle text-[11.5px] truncate">
                  {dbConnSubtitle(conn().url)}
                </span>
                <div class="flex-1" />
                <button
                  type="button"
                  class="ag-btn ag-btn-ghost ag-btn-sm"
                  onClick={disconnectDb}
                >
                  Disconnect
                </button>
              </div>

              <div class="p-3 border-b border-border flex flex-col gap-2">
                <div
                  ref={(el) => (host = el)}
                  class="w-full border border-border rounded bg-bg-2 overflow-hidden"
                  data-testid="db-sql-editor"
                />
                <div class="flex justify-end">
                  <button
                    type="button"
                    class="ag-btn ag-btn-primary"
                    onClick={() => void runDbSql()}
                    disabled={dbLoading() || !dbSql().trim()}
                  >
                    Run SQL
                  </button>
                </div>
              </div>

              <Show when={dbSelectedTable()}>
                <div class="px-3 py-2 border-b border-border flex items-center gap-2 bg-bg-1 flex-wrap">
                  <span class="text-fg-subtle">Filter:</span>
                  <select
                    class="bg-bg-2 border border-border rounded px-1 py-0.5"
                    value={dbFilterCol()}
                    onChange={(e) => setDbFilterCol(e.currentTarget.value)}
                  >
                    <option value="">column</option>
                    <For each={dbColumns()}>
                      {(c) => <option value={c.name}>{c.name}</option>}
                    </For>
                  </select>
                  <select
                    class="bg-bg-2 border border-border rounded px-1 py-0.5"
                    value={dbFilterOp()}
                    onChange={(e) => setDbFilterOp(e.currentTarget.value)}
                  >
                    <option value="=">=</option>
                    <option value="!=">!=</option>
                    <option value="<">&lt;</option>
                    <option value=">">&gt;</option>
                    <option value="<=">&lt;=</option>
                    <option value=">=">&gt;=</option>
                    <option value="like">LIKE</option>
                    <option value="ilike">ILIKE</option>
                  </select>
                  <input
                    class="bg-bg-2 border border-border rounded px-2 py-0.5"
                    placeholder="value"
                    value={dbFilterVal()}
                    onInput={(e) => setDbFilterVal(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost text-[11px]"
                    onClick={applyDbFilter}
                    disabled={dbLoading()}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost text-[11px]"
                    onClick={clearDbFilter}
                    disabled={dbLoading()}
                  >
                    Clear
                  </button>
                  <div class="flex-1" />
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost text-[11px]"
                    onClick={prevDbPage}
                    disabled={dbOffset() === 0 || dbLoading()}
                  >
                    Prev
                  </button>
                  <span class="text-fg-subtle text-[11px]">
                    offset {dbOffset()}
                  </span>
                  <button
                    type="button"
                    class="ag-btn ag-btn-ghost text-[11px]"
                    onClick={nextDbPage}
                    disabled={dbLoading()}
                  >
                    Next
                  </button>
                </div>
              </Show>

              <div class="flex-1 overflow-auto p-3">
                <Show
                  when={dbRows()}
                  keyed
                  fallback={
                    <div class="text-fg-subtle">
                      Run a query or pick a table in the Database view to
                      see results.
                    </div>
                  }
                >
                  {(r) => {
                    const data = r;
                    if (typeof data.affected_rows === "number") {
                      return (
                        <div class="text-fg-subtle">
                          {data.affected_rows} rows affected
                        </div>
                      );
                    }
                    return (
                      <div class="overflow-auto border border-border rounded">
                        <table class="w-full text-left border-collapse">
                          <thead class="bg-bg-2 sticky top-0">
                            <tr>
                              <For each={data.columns}>
                                {(col) => (
                                  <th class="px-2 py-1 border-b border-border font-medium text-fg-subtle whitespace-nowrap">
                                    {col}
                                  </th>
                                )}
                              </For>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={data.rows}>
                              {(row) => (
                                <tr class="even:bg-bg-1">
                                  <For each={row}>
                                    {(cell) => (
                                      <td class="px-2 py-1 border-b border-border font-mono whitespace-nowrap">
                                        {renderCell(cell)}
                                      </td>
                                    )}
                                  </For>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    );
                  }}
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
