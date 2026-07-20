import { For, Show, createSignal, onMount } from "solid-js";
import { api, type DbConnection } from "../api/client";
import { confirm } from "./dialog";
import { pushToast } from "./Toast";
import { openDbEditor } from "../stores/app";
import {
  activeConn,
  activeConnId,
  connectDb,
  dbActiveDb,
  dbConnSubtitle,
  dbConnections,
  dbDatabases,
  dbDefaultDbName,
  dbExpandedDbs,
  dbLoading,
  dbSelectedTable,
  dbTableFilter,
  dbTablesByDb,
  initDb,
  loadDbTableData,
  saveDbConnections,
  selectDb,
  setDbTableFilter,
  toggleDbExpanded,
} from "../stores/db";

/** Left-rail Database view: connection manager + DBeaver-style
 *  connection → databases → tables tree. Clicking a table opens (or
 *  focuses) the singleton DB editor tab and loads the table's data
 *  there; clicking a database makes it the active one for SQL. The
 *  editor tab holds the SQL editor and results grid; both sides share
 *  `stores/db`. */
export default function DbSidebar() {
  const [formOpen, setFormOpen] = createSignal(false);
  const [formEditId, setFormEditId] = createSignal<string | null>(null);
  const [formName, setFormName] = createSignal("");
  const [formUrl, setFormUrl] = createSignal("");
  const [formBusy, setFormBusy] = createSignal(false);
  const [formTest, setFormTest] = createSignal<{
    ok: boolean;
    msg: string;
  } | null>(null);

  onMount(() => void initDb());

  function openAddForm() {
    setFormEditId(null);
    setFormName("");
    setFormUrl("");
    setFormTest(null);
    setFormOpen(true);
  }

  function openEditForm(c: DbConnection) {
    setFormEditId(c.id);
    setFormName(c.name);
    setFormUrl(c.url);
    setFormTest(null);
    setFormOpen(true);
  }

  async function testForm() {
    const url = formUrl().trim();
    if (!url) return;
    setFormBusy(true);
    setFormTest(null);
    try {
      const r = await api.testDbConnection(url);
      setFormTest(
        r.ok
          ? { ok: true, msg: r.server_version ?? "Connection OK" }
          : { ok: false, msg: r.error ?? "Connection failed" },
      );
    } catch (e) {
      setFormTest({ ok: false, msg: String(e) });
    } finally {
      setFormBusy(false);
    }
  }

  async function saveForm() {
    const name = formName().trim();
    const url = formUrl().trim();
    if (!name || !url) return;
    setFormBusy(true);
    try {
      const editId = formEditId();
      const saved: DbConnection = {
        id: editId ?? crypto.randomUUID(),
        name,
        url,
      };
      const next = editId
        ? dbConnections().map((c) => (c.id === editId ? saved : c))
        : [...dbConnections(), saved];
      await saveDbConnections(next);
      setFormOpen(false);
      // Reconnect when the active connection was edited, or connect to
      // the first connection ever added.
      if (editId === activeConnId() || !activeConnId()) {
        await connectDb(saved);
      }
    } catch (e) {
      pushToast({
        title: "DB error",
        message: `could not save connection: ${e}`,
        level: "error",
      });
    } finally {
      setFormBusy(false);
    }
  }

  async function removeConnection(c: DbConnection) {
    const ok = await confirm({
      title: `Delete connection "${c.name}"?`,
      body: dbConnSubtitle(c.url),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await saveDbConnections(dbConnections().filter((x) => x.id !== c.id));
    } catch (e) {
      pushToast({
        title: "DB error",
        message: `could not delete connection: ${e}`,
        level: "error",
      });
    }
  }

  function openTable(db: string, t: string) {
    openDbEditor();
    const done = dbActiveDb() !== db ? selectDb(db) : Promise.resolve();
    void done.then(() => loadDbTableData(t));
  }

  /** The connection URL's own database, tagged "default" in the tree. */
  const defaultDb = () => {
    const conn = activeConn();
    return conn ? dbDefaultDbName(conn.url) : "";
  };

  /** Tables for a tree node, honouring the filter box. */
  function tablesFor(db: string): string[] {
    const all = dbTablesByDb()[db] ?? [];
    const f = dbTableFilter().trim().toLowerCase();
    if (!f) return all;
    return all.filter((t) => t.toLowerCase().includes(f));
  }

  /** Databases shown in the tree. With a filter active, a database
   *  stays when its own name matches OR any of its loaded tables do. */
  function visibleDbs(): string[] {
    const f = dbTableFilter().trim().toLowerCase();
    if (!f) return dbDatabases();
    return dbDatabases().filter(
      (db) =>
        db.toLowerCase().includes(f) ||
        (dbTablesByDb()[db] ?? []).some((t) => t.toLowerCase().includes(f)),
    );
  }

  return (
    <div class="flex-1 flex flex-col min-h-0" data-testid="db-sidebar">
      <div class="px-3 py-2 border-b border-border flex items-center justify-between">
        <span class="text-[0.8em] font-semibold uppercase tracking-wider text-fg-subtle">
          Connections
        </span>
        <button
          type="button"
          class="ag-btn ag-btn-ghost ag-btn-xs"
          onClick={openAddForm}
          title="Add connection"
          data-testid="db-add-connection"
        >
          +
        </button>
      </div>
      <div class="p-2 space-y-0.5 shrink-0 max-h-56 overflow-auto">
        <Show
          when={dbConnections().length > 0}
          fallback={<div class="text-fg-subtle text-[11px] px-2 py-1">No connections yet.</div>}
        >
          <For each={dbConnections()}>
            {(c) => (
              <div
                class="group flex items-center gap-1.5 rounded px-2 py-1 cursor-pointer hover:bg-bg-3"
                classList={{ "bg-accent-soft": activeConnId() === c.id }}
                onClick={() => void connectDb(c)}
                data-testid={`db-conn-${c.name}`}
              >
                <span
                  class="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                  classList={{
                    "bg-success": activeConnId() === c.id,
                    "bg-fg-subtle opacity-40": activeConnId() !== c.id,
                  }}
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-fg text-[12.5px]">{c.name}</div>
                  <div class="truncate text-[10.5px] text-fg-subtle">{dbConnSubtitle(c.url)}</div>
                </div>
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-fg px-0.5 shrink-0"
                  title={`Edit ${c.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditForm(c);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger px-0.5 shrink-0"
                  title={`Delete ${c.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeConnection(c);
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>

      <Show when={activeConnId()}>
        <div class="px-3 py-2 border-y border-border flex items-center justify-between">
          <span class="text-[0.8em] font-semibold uppercase tracking-wider text-fg-subtle">
            Databases
          </span>
        </div>
        <div class="p-2 border-b border-border">
          <input
            class="ag-input w-full"
            placeholder="Filter databases & tables…"
            value={dbTableFilter()}
            onInput={(e) => setDbTableFilter(e.currentTarget.value)}
          />
        </div>
        <div class="flex-1 overflow-auto p-2">
          <Show
            when={visibleDbs().length > 0}
            fallback={
              <div class="text-fg-subtle text-[11px] px-2 py-1">
                {dbLoading() ? "Loading…" : "No databases found."}
              </div>
            }
          >
            <For each={visibleDbs()}>
              {(db) => (
                <>
                  <div
                    class="group flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer hover:bg-bg-3"
                    onClick={() => void selectDb(db)}
                    data-testid={`db-tree-${db}`}
                  >
                    <button
                      type="button"
                      class="w-4 shrink-0 text-fg-subtle hover:text-fg text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDbExpanded(db);
                      }}
                      title={dbExpandedDbs().has(db) ? "Collapse" : "Expand"}
                    >
                      {dbExpandedDbs().has(db) ? "▾" : "▸"}
                    </button>
                    <span
                      class="truncate text-fg text-[12.5px] flex-1"
                      classList={{
                        "text-accent font-medium": dbActiveDb() === db,
                      }}
                    >
                      {db}
                    </span>
                    <Show when={db === defaultDb()}>
                      <span class="text-[9.5px] uppercase tracking-wide text-fg-subtle shrink-0">
                        default
                      </span>
                    </Show>
                  </div>
                  <Show when={dbExpandedDbs().has(db)}>
                    <div class="pl-6">
                      <Show
                        when={tablesFor(db).length > 0}
                        fallback={
                          <div class="text-fg-subtle text-[11px] px-2 py-1">
                            {dbTablesByDb()[db] ? "No tables." : "Loading…"}
                          </div>
                        }
                      >
                        <For each={tablesFor(db)}>
                          {(t) => (
                            <button
                              type="button"
                              class="w-full text-left px-2 py-1 rounded hover:bg-bg-3 text-fg truncate text-[12px]"
                              classList={{
                                "bg-accent-soft text-accent":
                                  dbActiveDb() === db && dbSelectedTable() === t,
                              }}
                              onClick={() => void openTable(db, t)}
                            >
                              {t}
                            </button>
                          )}
                        </For>
                      </Show>
                    </div>
                  </Show>
                </>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={formOpen()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            class="absolute inset-0 bg-black/60"
            onClick={() => !formBusy() && setFormOpen(false)}
          />
          <div
            class="relative w-full max-w-md rounded-xl border border-border bg-bg-1 p-5 shadow-2xl"
            data-testid="db-connection-form"
          >
            <h3 class="text-[14px] font-semibold mb-4">
              {formEditId() ? "Edit connection" : "New connection"}
            </h3>
            <label class="block text-[12px] font-medium text-fg-muted mb-1">Name</label>
            <input
              class="ag-input w-full mb-3"
              placeholder="Local Postgres"
              value={formName()}
              onInput={(e) => setFormName(e.currentTarget.value)}
              data-testid="db-conn-name"
            />
            <label class="block text-[12px] font-medium text-fg-muted mb-1">Connection URL</label>
            <input
              class="ag-input w-full mb-2 font-mono"
              placeholder="postgres://user:pass@host:5432/db"
              value={formUrl()}
              onInput={(e) => {
                setFormUrl(e.currentTarget.value);
                setFormTest(null);
              }}
              data-testid="db-conn-url"
            />
            <Show when={formTest()}>
              {(t) => (
                <p
                  class="text-[12px] mb-2 break-all"
                  classList={{
                    "text-success": t().ok,
                    "text-danger": !t().ok,
                  }}
                  data-testid="db-conn-test-result"
                >
                  {t().ok ? "✓ " : "✕ "}
                  {t().msg}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-2 mt-4">
              <button
                type="button"
                class="ag-btn ag-btn-ghost"
                onClick={() => setFormOpen(false)}
                disabled={formBusy()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="ag-btn"
                onClick={testForm}
                disabled={formBusy() || !formUrl().trim()}
                data-testid="db-conn-test"
              >
                Test
              </button>
              <button
                type="button"
                class="ag-btn ag-btn-primary"
                onClick={saveForm}
                disabled={formBusy() || !formName().trim() || !formUrl().trim()}
                data-testid="db-conn-save"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
