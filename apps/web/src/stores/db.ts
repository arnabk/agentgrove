import { createSignal } from "solid-js";
import { api, type DbColumn, type DbConnection, type DbQueryResponse } from "../api/client";
import { pushToast } from "../components/Toast";

/** Shared state for the Database feature. The left rail's Database view
 *  (connections + tables tree) and the DB editor tab (SQL + results)
 *  both read/write this store, so navigating between them is seamless. */

export const DB_PAGE_LIMIT = 50;
const ACTIVE_CONN_KEY = "agentgrove.db.active";

// ---- connections ---------------------------------------------------------
export const [dbConnections, setDbConnections] = createSignal<DbConnection[]>([]);
export const [activeConnId, setActiveConnId] = createSignal<string | null>(null);
export const activeConn = () => dbConnections().find((c) => c.id === activeConnId()) ?? null;

// ---- browser state (bound to the active connection) ----------------------
export const [dbTables, setDbTables] = createSignal<string[]>([]);
/** Table name → column names, prefetched in the background for SQL
 *  autocomplete. Emptied on disconnect / connection switch. */
export const [dbColumnCache, setDbColumnCache] = createSignal<Record<string, string[]>>({});
/** All databases on the connected server (DBeaver-style tree). */
export const [dbDatabases, setDbDatabases] = createSignal<string[]>([]);
/** The database the editor tab + SQL run against. Defaults to the
 *  connection URL's database. */
export const [dbActiveDb, setDbActiveDb] = createSignal("");
/** Expanded databases in the rail tree. */
export const [dbExpandedDbs, setDbExpandedDbs] = createSignal<Set<string>>(new Set());
/** Tables per database, lazy-loaded on expand. */
export const [dbTablesByDb, setDbTablesByDb] = createSignal<Record<string, string[]>>({});
export const [dbTableFilter, setDbTableFilter] = createSignal("");
export const [dbSelectedTable, setDbSelectedTable] = createSignal<string | null>(null);
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

/** The database name embedded in a postgres URL ("" when unparseable). */
export function dbDefaultDbName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

/** The connection URL with its database swapped for `db`. Falls back
 *  to the original URL when it doesn't parse. */
export function dbUrlFor(url: string, db: string): string {
  try {
    const u = new URL(url);
    u.pathname = `/${encodeURIComponent(db)}`;
    return u.toString();
  } catch {
    return url;
  }
}

/** Connection URL pointing at the currently-active database. All
 *  table/column/row/query calls go through this. */
export function activeDbUrl(): string | undefined {
  const conn = activeConn();
  if (!conn) return undefined;
  const db = dbActiveDb();
  return db ? dbUrlFor(conn.url, db) : conn.url;
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
    setDbTables([]);
    setDbColumnCache({});
    setDbDatabases([]);
    setDbTablesByDb({});
    setDbExpandedDbs(new Set<string>());
    setDbActiveDb(dbDefaultDbName(conn.url));
  }
  await loadDatabases();
}

export function disconnectDb() {
  setActiveConnId(null);
  localStorage.removeItem(ACTIVE_CONN_KEY);
  setDbTables([]);
  setDbColumnCache({});
  setDbDatabases([]);
  setDbTablesByDb({});
  setDbExpandedDbs(new Set<string>());
  setDbActiveDb("");
  setDbSelectedTable(null);
  setDbRows(null);
  setDbColumns([]);
}

/** Load the server's database list, then the active db's tables. Falls
 *  back to flat table loading when the server refuses the database
 *  listing (older proxies / restricted roles). */
async function loadDatabases() {
  const conn = activeConn();
  if (!conn) return;
  try {
    const dbs = await api.listDbDatabases(conn.url);
    setDbDatabases(dbs);
    const active = dbActiveDb() && dbs.includes(dbActiveDb()) ? dbActiveDb() : (dbs[0] ?? "");
    setDbActiveDb(active);
    if (active) {
      setDbExpandedDbs(new Set([active]));
      await loadDbTables();
    }
  } catch {
    // Restricted server: behave like before — tables of the URL's db only.
    await loadDbTables();
  }
}

/** Make `db` the active database: its tables drive the editor tab and
 *  SQL execution. Expands the node in the rail tree. */
export async function selectDb(db: string) {
  if (!db || db === dbActiveDb()) {
    setDbExpandedDbs((s) => {
      const next = new Set<string>(s);
      next.add(db);
      return next;
    });
    return;
  }
  setDbActiveDb(db);
  setDbExpandedDbs((s) => {
    const next = new Set<string>(s);
    next.add(db);
    return next;
  });
  setDbSelectedTable(null);
  setDbRows(null);
  setDbColumns([]);
  await loadDbTables();
}

/** Expand/collapse a database in the rail tree, lazy-loading its
 *  tables on first expand. Does NOT change the active database. */
export function toggleDbExpanded(db: string) {
  const s = new Set(dbExpandedDbs());
  if (s.has(db)) {
    s.delete(db);
    setDbExpandedDbs(s);
    return;
  }
  s.add(db);
  setDbExpandedDbs(s);
  if (!dbTablesByDb()[db]) void loadTablesForDb(db);
}

/** Load tables for an arbitrary database into the tree cache. */
async function loadTablesForDb(db: string) {
  const conn = activeConn();
  if (!conn) return;
  try {
    const list = await api.listDbTables(dbUrlFor(conn.url, db));
    setDbTablesByDb((m) => ({ ...m, [db]: list }));
  } catch (e) {
    pushToast({ title: "DB error", message: String(e), level: "error" });
  }
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
  const url = activeDbUrl();
  if (!url) return;
  setDbLoading(true);
  try {
    const list = await api.listDbTables(url);
    setDbTables(list);
    const db = dbActiveDb();
    if (db) setDbTablesByDb((m) => ({ ...m, [db]: list }));
    setDbColumnCache({});
    void prefetchColumns(url, list);
  } catch (e) {
    setDbTables([]);
    pushToast({
      title: `Cannot load tables for ${dbActiveDb() || "database"}`,
      message: String(e),
      level: "error",
    });
  } finally {
    setDbLoading(false);
  }
}

export async function loadDbTableData(table: string, resetOffset = true) {
  const url = activeDbUrl();
  if (!url) return;
  if (resetOffset) setDbOffset(0);
  setDbLoading(true);
  try {
    const [cols, data] = await Promise.all([
      api.listDbColumns(table, url).then((r) => r.columns),
      api.listDbRows(table, {
        connection: url,
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
  const url = activeDbUrl();
  const q = dbSql().trim();
  if (!url || !q) return;
  setDbLoading(true);
  setDbSelectedTable(null);
  try {
    const data = await api.runDbQuery(q, url);
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
