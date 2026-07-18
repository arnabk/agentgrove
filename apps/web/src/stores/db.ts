import { createSignal } from "solid-js";
import {
  api,
  type DbColumn,
  type DbConnection,
  type DbQueryResponse,
} from "../api/client";
import { pushToast } from "../components/Toast";

/** Shared state for the Database feature. The left rail's Database view
 *  (connections + tables tree) and the DB editor tab (SQL + results)
 *  both read/write this store, so navigating between them is seamless. */

export const DB_PAGE_LIMIT = 50;
const ACTIVE_CONN_KEY = "agentgrove.db.active";

// ---- connections ---------------------------------------------------------
export const [dbConnections, setDbConnections] = createSignal<DbConnection[]>(
  [],
);
export const [activeConnId, setActiveConnId] = createSignal<string | null>(
  null,
);
export const activeConn = () =>
  dbConnections().find((c) => c.id === activeConnId()) ?? null;

// ---- browser state (bound to the active connection) ----------------------
export const [dbTables, setDbTables] = createSignal<string[]>([]);
/** Table name → column names, prefetched in the background for SQL
 *  autocomplete. Emptied on disconnect / connection switch. */
export const [dbColumnCache, setDbColumnCache] = createSignal<
  Record<string, string[]>
>({});
export const [dbTableFilter, setDbTableFilter] = createSignal("");
export const [dbSelectedTable, setDbSelectedTable] = createSignal<
  string | null
>(null);
export const [dbColumns, setDbColumns] = createSignal<DbColumn[]>([]);
export const [dbRows, setDbRows] = createSignal<DbQueryResponse | null>(null);
export const [dbSql, setDbSql] = createSignal("");
export const [dbLoading, setDbLoading] = createSignal(false);

export const [dbFilterCol, setDbFilterCol] = createSignal("");
export const [dbFilterOp, setDbFilterOp] = createSignal("=");
export const [dbFilterVal, setDbFilterVal] = createSignal("");
export const [dbOffset, setDbOffset] = createSignal(0);

export const dbFilteredTables = () => {
  const f = dbTableFilter().trim().toLowerCase();
  if (!f) return dbTables();
  return dbTables().filter((t) => t.toLowerCase().includes(f));
};

/** "user@host:port/db" from a postgres URL, for list subtitles.
 *  Falls back to the raw string when the URL doesn't parse. */
export function dbConnSubtitle(url: string): string {
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "");
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return `${u.username}@${host}/${db}`;
  } catch {
    return url;
  }
}

let initialized = false;

/** One-time load: read saved connections (seeding a first-run default
 *  when empty) and reconnect to the last-used one. Safe to call from
 *  both the rail view and the editor tab. */
export async function initDb() {
  if (initialized) return;
  initialized = true;
  try {
    const s = await api.getSettings();
    let conns = s.db_connections ?? [];
    if (conns.length === 0) {
      const info = await api.getDbInfo();
      conns = [
        {
          id: crypto.randomUUID(),
          name: "Local Postgres",
          url: info.default_connection,
        },
      ];
      await api.saveSettings({ ...s, db_connections: conns });
    }
    setDbConnections(conns);
    const remembered = localStorage.getItem(ACTIVE_CONN_KEY);
    const target = conns.find((c) => c.id === remembered) ?? conns[0];
    if (target) await connectDb(target);
  } catch (e) {
    pushToast({ title: "DB error", message: String(e), level: "error" });
  }
}

/** Persist the connection list. Re-reads settings first so concurrent
 *  edits elsewhere (SettingsModal) aren't clobbered. */
export async function saveDbConnections(next: DbConnection[]) {
  const s = await api.getSettings();
  await api.saveSettings({ ...s, db_connections: next });
  setDbConnections(next);
}

export async function connectDb(conn: DbConnection) {
  if (activeConnId() !== conn.id) {
    setActiveConnId(conn.id);
    localStorage.setItem(ACTIVE_CONN_KEY, conn.id);
    setDbSelectedTable(null);
    setDbRows(null);
    setDbColumns([]);
    setDbOffset(0);
    setDbTableFilter("");
  }
  await loadDbTables();
}

export function disconnectDb() {
  setActiveConnId(null);
  localStorage.removeItem(ACTIVE_CONN_KEY);
  setDbTables([]);
  setDbColumnCache({});
  setDbSelectedTable(null);
  setDbRows(null);
  setDbColumns([]);
}

let prefetchToken = 0;

/** Background-fill the column cache used for SQL autocomplete. Chunked
 *  so we don't fire 60+ concurrent requests at a dev box. Bails out
 *  mid-flight when a newer prefetch started (connection switched). */
async function prefetchColumns(url: string, tables: string[]) {
  const token = ++prefetchToken;
  const acc: Record<string, string[]> = {};
  const CHUNK = 8;
  for (let i = 0; i < tables.length; i += CHUNK) {
    await Promise.all(
      tables.slice(i, i + CHUNK).map(async (t) => {
        try {
          const r = await api.listDbColumns(t, url);
          acc[t] = r.columns.map((c) => c.name);
        } catch {
          // skip tables we can't describe
        }
      }),
    );
    if (token !== prefetchToken) return;
    setDbColumnCache({ ...acc });
  }
}

export async function loadDbTables() {
  const conn = activeConn();
  if (!conn) return;
  setDbLoading(true);
  try {
    const list = await api.listDbTables(conn.url);
    setDbTables(list);
    setDbColumnCache({});
    void prefetchColumns(conn.url, list);
  } catch (e) {
    setDbTables([]);
    pushToast({
      title: `Cannot connect to ${conn.name}`,
      message: String(e),
      level: "error",
    });
  } finally {
    setDbLoading(false);
  }
}

export async function loadDbTableData(table: string, resetOffset = true) {
  const conn = activeConn();
  if (!conn) return;
  if (resetOffset) setDbOffset(0);
  setDbLoading(true);
  try {
    const [cols, data] = await Promise.all([
      api.listDbColumns(table, conn.url).then((r) => r.columns),
      api.listDbRows(table, {
        connection: conn.url,
        limit: DB_PAGE_LIMIT,
        offset: dbOffset(),
        filter_col: dbFilterCol(),
        filter_op: dbFilterOp(),
        filter_val: dbFilterVal(),
      }),
    ]);
    setDbColumns(cols);
    setDbRows(data);
    setDbSelectedTable(table);
  } catch (e) {
    pushToast({ title: "DB error", message: String(e), level: "error" });
  } finally {
    setDbLoading(false);
  }
}

export async function runDbSql() {
  const conn = activeConn();
  const q = dbSql().trim();
  if (!conn || !q) return;
  setDbLoading(true);
  setDbSelectedTable(null);
  try {
    const data = await api.runDbQuery(q, conn.url);
    setDbRows(data);
  } catch (e) {
    pushToast({ title: "DB error", message: String(e), level: "error" });
  } finally {
    setDbLoading(false);
  }
}

export function applyDbFilter() {
  const t = dbSelectedTable();
  if (t) void loadDbTableData(t);
}

export function clearDbFilter() {
  setDbFilterCol("");
  setDbFilterOp("=");
  setDbFilterVal("");
  const t = dbSelectedTable();
  if (t) void loadDbTableData(t);
}

export function nextDbPage() {
  const t = dbSelectedTable();
  if (!t) return;
  setDbOffset((o) => o + DB_PAGE_LIMIT);
  void loadDbTableData(t, false);
}

export function prevDbPage() {
  const t = dbSelectedTable();
  if (!t) return;
  setDbOffset((o) => Math.max(0, o - DB_PAGE_LIMIT));
  void loadDbTableData(t, false);
}
