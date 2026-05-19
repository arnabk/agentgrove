import { For, Show, createSignal } from "solid-js";
import { api } from "../api/client";
import {
  refreshChatsForCurrent,
  refreshProjects,
  refreshWorktreesForCurrent,
  selectChat,
  selectProject,
  selectWorktree,
  setTheme,
  state,
} from "../stores/app";

export default function LeftRail() {
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newRoot, setNewRoot] = createSignal("");
  const [addingWt, setAddingWt] = createSignal(false);
  const [wtBranch, setWtBranch] = createSignal("");
  const [wtPre, setWtPre] = createSignal("");
  const [addingChat, setAddingChat] = createSignal(false);
  const [chatTitle, setChatTitle] = createSignal("");

  async function createProject(ev: SubmitEvent) {
    ev.preventDefault();
    await api.createProject({ name: newName(), root: newRoot() });
    setNewName("");
    setNewRoot("");
    setAdding(false);
    await refreshProjects();
  }

  async function deleteProject(id: string, ev: MouseEvent) {
    ev.stopPropagation();
    if (!confirm("Delete this project?")) return;
    await api.deleteProject(id);
    await refreshProjects();
  }

  async function createWorktree(ev: SubmitEvent) {
    ev.preventDefault();
    const pid = state.selectedProjectId;
    if (!pid) return;
    const body: { branch: string; base_ref: string; pre_script?: string } = {
      branch: wtBranch(),
      base_ref: "main",
    };
    if (wtPre().trim()) body.pre_script = wtPre();
    await api.createWorktree(pid, body);
    setWtBranch("");
    setWtPre("");
    setAddingWt(false);
    await refreshWorktreesForCurrent();
  }

  async function deleteWorktree(wtId: string, ev: MouseEvent) {
    ev.stopPropagation();
    const pid = state.selectedProjectId;
    if (!pid) return;
    if (!confirm("Delete worktree?")) return;
    await api.deleteWorktree(pid, wtId);
    await refreshWorktreesForCurrent();
  }

  async function createChat(ev: SubmitEvent) {
    ev.preventDefault();
    const wid = state.selectedWorktreeId;
    if (!wid) return;
    await api.createChat(wid, {
      title: chatTitle() || "untitled",
      provider: "fake",
      model: "echo",
    });
    setChatTitle("");
    setAddingChat(false);
    await refreshChatsForCurrent();
  }

  return (
    <aside
      class="w-[260px] shrink-0 border-r border-border bg-bg-1 flex flex-col"
      data-testid="left-rail"
    >
      <div class="px-4 h-12 flex items-center gap-2.5 border-b border-border">
        <Logo />
        <span class="text-[13px] font-semibold tracking-tight">AgentGrove</span>
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* Projects */}
        <section>
          <h3 class="ag-section-title">
            <span>Projects</span>
            <button
              class="ag-btn ag-btn-ghost !px-1.5 !py-0.5 text-accent"
              onClick={() => setAdding(!adding())}
              data-testid="add-project-btn"
              aria-label="Add project"
              title="Add project"
            >
              +
            </button>
          </h3>
          <Show when={adding()}>
            <form
              onSubmit={createProject}
              class="rounded-md bg-bg-2 border border-border p-2 mb-2 flex flex-col gap-2"
              data-testid="add-project-form"
            >
              <input
                placeholder="Name"
                class="ag-input !py-1 !text-[12px]"
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                data-testid="new-project-name"
              />
              <input
                placeholder="/absolute/path"
                class="ag-input !py-1 !text-[12px] font-mono"
                value={newRoot()}
                onInput={(e) => setNewRoot(e.currentTarget.value)}
                data-testid="new-project-root"
              />
              <button
                type="submit"
                class="ag-btn ag-btn-primary justify-center !py-1 !text-[12px]"
                data-testid="new-project-submit"
              >
                Create
              </button>
            </form>
          </Show>
          <ul class="space-y-0.5" data-testid="project-list">
            <For each={state.projects}>
              {(p) => (
                <li
                  class="ag-list-item group"
                  classList={{ "is-active": state.selectedProjectId === p.id }}
                  onClick={() => selectProject(p.id)}
                  data-testid={`project-${p.id}`}
                >
                  <span class="text-fg-subtle">▸</span>
                  <span class="truncate text-[13px]" title={p.root}>
                    {p.name}
                  </span>
                  <button
                    onClick={(e) => deleteProject(p.id, e)}
                    class="ml-auto opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger text-[11px]"
                    aria-label={`Delete project ${p.name}`}
                    title="Delete"
                  >
                    ✕
                  </button>
                </li>
              )}
            </For>
            <Show when={state.projects.length === 0}>
              <li class="text-[12px] text-fg-subtle px-2 py-2">
                No projects yet. Click + to add one.
              </li>
            </Show>
          </ul>
        </section>

        {/* Worktrees */}
        <Show when={state.selectedProjectId}>
          <section>
            <h3 class="ag-section-title">
              <span>Worktrees</span>
              <button
                class="ag-btn ag-btn-ghost !px-1.5 !py-0.5 text-accent"
                onClick={() => setAddingWt(!addingWt())}
                data-testid="add-worktree-btn"
                aria-label="Add worktree"
              >
                +
              </button>
            </h3>
            <Show when={addingWt()}>
              <form
                onSubmit={createWorktree}
                class="rounded-md bg-bg-2 border border-border p-2 mb-2 flex flex-col gap-2"
                data-testid="add-worktree-form"
              >
                <input
                  placeholder="branch name"
                  class="ag-input !py-1 !text-[12px] font-mono"
                  value={wtBranch()}
                  onInput={(e) => setWtBranch(e.currentTarget.value)}
                  data-testid="new-worktree-branch"
                />
                <input
                  placeholder="pre-script (optional)"
                  class="ag-input !py-1 !text-[12px] font-mono"
                  value={wtPre()}
                  onInput={(e) => setWtPre(e.currentTarget.value)}
                  data-testid="new-worktree-pre"
                />
                <button
                  type="submit"
                  class="ag-btn ag-btn-primary justify-center !py-1 !text-[12px]"
                  data-testid="new-worktree-submit"
                >
                  Create
                </button>
              </form>
            </Show>
            <ul class="space-y-0.5" data-testid="worktree-list">
              <For each={state.worktrees[state.selectedProjectId!] ?? []}>
                {(w) => (
                  <li
                    class="ag-list-item group"
                    classList={{ "is-active": state.selectedWorktreeId === w.id }}
                    onClick={() => selectWorktree(w.id)}
                    data-testid={`worktree-${w.id}`}
                  >
                    <span class="text-fg-subtle">⎇</span>
                    <span class="truncate text-[13px] font-mono" title={w.path}>
                      {w.branch}
                    </span>
                    <span
                      class="ml-auto ag-chip"
                      classList={{
                        "ag-chip-success": w.status === "ready",
                        "ag-chip-warn": w.status === "creating" || w.status === "pre_script",
                      }}
                    >
                      {w.status}
                    </span>
                    <button
                      onClick={(e) => deleteWorktree(w.id, e)}
                      class="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-danger text-[11px]"
                      aria-label={`Delete worktree ${w.branch}`}
                    >
                      ✕
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>

        {/* Chats */}
        <Show when={state.selectedWorktreeId}>
          <section>
            <h3 class="ag-section-title">
              <span>Chats</span>
              <button
                class="ag-btn ag-btn-ghost !px-1.5 !py-0.5 text-accent"
                onClick={() => setAddingChat(!addingChat())}
                data-testid="add-chat-btn"
                aria-label="Add chat"
              >
                +
              </button>
            </h3>
            <Show when={addingChat()}>
              <form
                onSubmit={createChat}
                class="rounded-md bg-bg-2 border border-border p-2 mb-2 flex flex-col gap-2"
                data-testid="add-chat-form"
              >
                <input
                  placeholder="title"
                  class="ag-input !py-1 !text-[12px]"
                  value={chatTitle()}
                  onInput={(e) => setChatTitle(e.currentTarget.value)}
                  data-testid="new-chat-title"
                />
                <button
                  type="submit"
                  class="ag-btn ag-btn-primary justify-center !py-1 !text-[12px]"
                  data-testid="new-chat-submit"
                >
                  Create
                </button>
              </form>
            </Show>
            <ul class="space-y-0.5" data-testid="chat-list">
              <For each={state.chats[state.selectedWorktreeId!] ?? []}>
                {(c) => (
                  <li
                    class="ag-list-item"
                    classList={{ "is-active": state.selectedChatId === c.id }}
                    onClick={() => selectChat(c.id)}
                    data-testid={`chat-${c.id}`}
                  >
                    <span class="text-fg-subtle">◇</span>
                    <span class="truncate text-[13px]">{c.title}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>

      <div class="px-3 py-3 border-t border-border">
        <label class="block text-[11px] font-medium tracking-wider uppercase text-fg-subtle mb-1.5">
          Theme
        </label>
        <select
          class="ag-input !py-1 !text-[12px]"
          value={state.themeId}
          onChange={(e) => setTheme(e.currentTarget.value)}
          data-testid="theme-picker"
        >
          <For each={state.themes}>{(t) => <option value={t.id}>{t.name}</option>}</For>
        </select>
      </div>
    </aside>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2 4 7v10l8 5 8-5V7l-8-5Z"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M12 12 4 7m8 5 8-5m-8 5v10"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}
