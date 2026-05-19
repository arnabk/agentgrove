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
      class="w-72 border-r border-[var(--ag-muted)] p-4 flex flex-col gap-4 overflow-y-auto"
      data-testid="left-rail"
    >
      <div>
        <div class="flex items-center justify-between mb-2">
          <h2 class="font-semibold">Projects</h2>
          <button
            class="text-sm text-[var(--ag-accent)]"
            onClick={() => setAdding(!adding())}
            data-testid="add-project-btn"
          >
            + Add
          </button>
        </div>
        <Show when={adding()}>
          <form
            onSubmit={createProject}
            class="flex flex-col gap-2 mb-2"
            data-testid="add-project-form"
          >
            <input
              placeholder="name"
              class="px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              data-testid="new-project-name"
            />
            <input
              placeholder="absolute path"
              class="px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
              value={newRoot()}
              onInput={(e) => setNewRoot(e.currentTarget.value)}
              data-testid="new-project-root"
            />
            <button
              type="submit"
              class="px-2 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
              data-testid="new-project-submit"
            >
              Create
            </button>
          </form>
        </Show>
        <ul class="flex flex-col gap-1" data-testid="project-list">
          <For each={state.projects}>
            {(p) => (
              <li
                class="flex items-center justify-between px-2 py-1 rounded cursor-pointer hover:bg-[var(--ag-muted)]/20"
                classList={{ "bg-[var(--ag-accent)]/30": state.selectedProjectId === p.id }}
                onClick={() => selectProject(p.id)}
                data-testid={`project-${p.id}`}
              >
                <span class="truncate" title={p.root}>
                  {p.name}
                </span>
                <button
                  onClick={(e) => deleteProject(p.id, e)}
                  class="text-xs text-red-400 ml-2"
                  aria-label={`Delete project ${p.name}`}
                >
                  ✕
                </button>
              </li>
            )}
          </For>
          <Show when={state.projects.length === 0}>
            <li class="text-sm text-[var(--ag-muted)] px-2 py-1">No projects yet.</li>
          </Show>
        </ul>
      </div>

      <Show when={state.selectedProjectId}>
        <div>
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-semibold">Worktrees</h2>
            <button
              class="text-sm text-[var(--ag-accent)]"
              onClick={() => setAddingWt(!addingWt())}
              data-testid="add-worktree-btn"
            >
              + Add
            </button>
          </div>
          <Show when={addingWt()}>
            <form
              onSubmit={createWorktree}
              class="flex flex-col gap-2 mb-2"
              data-testid="add-worktree-form"
            >
              <input
                placeholder="branch name"
                class="px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
                value={wtBranch()}
                onInput={(e) => setWtBranch(e.currentTarget.value)}
                data-testid="new-worktree-branch"
              />
              <input
                placeholder="pre-script (optional)"
                class="px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
                value={wtPre()}
                onInput={(e) => setWtPre(e.currentTarget.value)}
                data-testid="new-worktree-pre"
              />
              <button
                type="submit"
                class="px-2 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
                data-testid="new-worktree-submit"
              >
                Create
              </button>
            </form>
          </Show>
          <ul class="flex flex-col gap-1" data-testid="worktree-list">
            <For each={state.worktrees[state.selectedProjectId!] ?? []}>
              {(w) => (
                <li
                  class="flex items-center justify-between px-2 py-1 rounded cursor-pointer hover:bg-[var(--ag-muted)]/20"
                  classList={{ "bg-[var(--ag-accent)]/30": state.selectedWorktreeId === w.id }}
                  onClick={() => selectWorktree(w.id)}
                  data-testid={`worktree-${w.id}`}
                >
                  <span class="truncate" title={w.path}>
                    {w.branch}
                  </span>
                  <button
                    onClick={(e) => deleteWorktree(w.id, e)}
                    class="text-xs text-red-400 ml-2"
                    aria-label={`Delete worktree ${w.branch}`}
                  >
                    ✕
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={state.selectedWorktreeId}>
        <div>
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-semibold">Chats</h2>
            <button
              class="text-sm text-[var(--ag-accent)]"
              onClick={() => setAddingChat(!addingChat())}
              data-testid="add-chat-btn"
            >
              + Add
            </button>
          </div>
          <Show when={addingChat()}>
            <form
              onSubmit={createChat}
              class="flex flex-col gap-2 mb-2"
              data-testid="add-chat-form"
            >
              <input
                placeholder="title"
                class="px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
                value={chatTitle()}
                onInput={(e) => setChatTitle(e.currentTarget.value)}
                data-testid="new-chat-title"
              />
              <button
                type="submit"
                class="px-2 py-1 rounded bg-[var(--ag-accent)] text-white text-sm"
                data-testid="new-chat-submit"
              >
                Create
              </button>
            </form>
          </Show>
          <ul class="flex flex-col gap-1" data-testid="chat-list">
            <For each={state.chats[state.selectedWorktreeId!] ?? []}>
              {(c) => (
                <li
                  class="px-2 py-1 rounded cursor-pointer hover:bg-[var(--ag-muted)]/20"
                  classList={{ "bg-[var(--ag-accent)]/30": state.selectedChatId === c.id }}
                  onClick={() => selectChat(c.id)}
                  data-testid={`chat-${c.id}`}
                >
                  {c.title}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <div class="mt-auto pt-4 border-t border-[var(--ag-muted)]">
        <label class="text-sm text-[var(--ag-muted)]">Theme</label>
        <select
          class="w-full mt-1 px-2 py-1 rounded bg-transparent border border-[var(--ag-muted)] text-sm"
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
