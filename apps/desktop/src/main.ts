import "@fontsource-variable/geist";
import mascot from "../../../assets/images/supertag-mascot-round.png";
import {
  type Conversation,
  type Gateway,
  type Message,
  nativeGateway,
  type Tag,
  type TaskEvent,
} from "./gateway";
import "./style.css";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing desktop element ${id}`);
  return result as T;
}

const app = element("app");
app.innerHTML = `
  <div class="shell">
    <aside class="rail" aria-label="Workspace">
      <div class="brand"><img id="mascot" alt="" width="31" height="31" /><strong>SuperTag</strong></div>
      <div class="rail-content">
        <nav aria-label="Tags">
          <div class="rail-heading"><h2>Tags</h2></div>
          <div id="tags" class="rail-list"></div>
        </nav>
        <nav id="conversations" aria-label="Conversations" hidden>
          <div class="rail-heading">
            <h2>Conversations</h2>
            <button id="new-conversation" type="button" class="icon-button" title="New conversation" aria-label="New conversation">+</button>
          </div>
          <div id="threads" class="rail-list"></div>
        </nav>
      </div>
      <button id="connection" type="button" class="connection">
        <span class="connection-dot" aria-hidden="true"></span>
        <span id="connection-label"></span>
        <span class="connection-arrow" aria-hidden="true">›</span>
      </button>
    </aside>
    <main class="main" aria-label="Conversation">
      <header class="topbar">
        <button id="toggle-rail" type="button" class="icon-button mobile-toggle" aria-label="Toggle workspace" aria-expanded="true">☰</button>
        <div id="identity"></div>
      </header>
      <div id="sync-error" class="sync-error" role="status" hidden></div>
      <div class="work-area">
        <div class="conversation">
          <div id="history" class="history" role="region" aria-label="Conversation history" tabindex="0">
            <div id="timeline" class="timeline"></div>
          </div>
          <form id="composer" class="composer" hidden>
            <p id="send-error" class="field-error" role="alert" hidden></p>
            <div class="composer-box">
              <textarea id="prompt" rows="2" required aria-label="Message"></textarea>
              <button id="send" type="submit" class="send" aria-label="Send message" title="Send message">↑</button>
            </div>
            <div class="composer-footer">Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</div>
          </form>
        </div>
        <aside id="activity" class="activity" aria-label="Task activity" hidden>
          <div class="activity-header"><h2>Task activity</h2><button id="close-activity" type="button" class="icon-button" aria-label="Close task activity">×</button></div>
          <p id="activity-status" class="activity-status" role="status"></p>
          <ol id="activity-events"></ol>
        </aside>
      </div>
    </main>
  </div>
  <dialog id="gateway-dialog" aria-labelledby="gateway-heading">
    <form id="gateway-form">
      <div class="dialog-title">
        <h2 id="gateway-heading">Gateway connection</h2>
        <button type="button" class="icon-button" data-close="gateway-dialog" aria-label="Close">×</button>
      </div>
      <p>Connect to the Gateway for your SuperTag workspace.</p>
      <label for="gateway-url">Gateway URL</label>
      <input id="gateway-url" type="url" placeholder="http://127.0.0.1:7001" autocomplete="off" spellcheck="false" required />
      <label for="gateway-token">Operator token</label>
      <input id="gateway-token" type="password" autocomplete="off" required />
      <p id="gateway-error" class="field-error" role="alert" hidden></p>
      <div class="dialog-actions"><button id="disconnect" class="secondary" type="button" hidden>Disconnect</button><button id="connect" class="primary" type="submit">Connect</button></div>
    </form>
  </dialog>
  <dialog id="thread-dialog" aria-labelledby="thread-heading">
    <form id="thread-form">
      <div class="dialog-title">
        <h2 id="thread-heading">New conversation</h2>
        <button type="button" class="icon-button" data-close="thread-dialog" aria-label="Close">×</button>
      </div>
      <label for="thread-name">Conversation name</label>
      <input id="thread-name" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*" placeholder="release-review" autocomplete="off" required />
      <p>Use letters, numbers, dots, underscores, or hyphens.</p>
      <div class="dialog-actions"><button class="primary" type="submit">Open conversation</button></div>
    </form>
  </dialog>
`;
element<HTMLImageElement>("mascot").src = mascot;

const tags = element("tags");
const threads = element("threads");
const identity = element("identity");
const history = element("history");
const timeline = element("timeline");
const composer = element<HTMLFormElement>("composer");
const prompt = element<HTMLTextAreaElement>("prompt");
const send = element<HTMLButtonElement>("send");
const sendError = element("send-error");
const syncError = element("sync-error");
const gatewayDialog = element<HTMLDialogElement>("gateway-dialog");
const gatewayForm = element<HTMLFormElement>("gateway-form");
const gatewayUrl = element<HTMLInputElement>("gateway-url");
const gatewayToken = element<HTMLInputElement>("gateway-token");
const gatewayError = element("gateway-error");
const connect = element<HTMLButtonElement>("connect");
const disconnect = element<HTMLButtonElement>("disconnect");
const threadDialog = element<HTMLDialogElement>("thread-dialog");
const threadForm = element<HTMLFormElement>("thread-form");
const threadName = element<HTMLInputElement>("thread-name");
const activity = element("activity");
const activityStatus = element("activity-status");
const activityEvents = element("activity-events");
const toggleRail = element<HTMLButtonElement>("toggle-rail");

type Draft = { text: string; operationId?: string; sending: boolean; error?: string };
type View = {
  tag: Tag;
  name: string;
  conversations: Conversation[];
  recent: Message[];
  older: Message[];
  cursor?: string;
  loading: boolean;
  loadingOlder: boolean;
  revision: number;
};
type Activity = { taskId: string; after: number; loading: boolean };

let gateway: Gateway = nativeGateway;
let address = "";
let preview = false;
let connected = false;
let roster: Tag[] = [];
let view: View | undefined;
let active: Activity | undefined;
let epoch = 0;
let selection = 0;
let pendingSends = 0;
let rosterRefreshedAt = 0;
const drafts = new Map<string, Draft>();

function node<K extends keyof HTMLElementTagNameMap>(
  type: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(type);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const value = node("button", className, label);
  value.type = "button";
  value.addEventListener("click", action);
  return value;
}

function avatar(tagId: string, large = false): HTMLElement {
  const colors = ["peach", "mint", "lilac", "blue", "yellow"];
  let hash = 0;
  for (const letter of tagId) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  const value = node("span", `avatar ${colors[hash % colors.length]}${large ? " large" : ""}`);
  value.setAttribute("aria-hidden", "true");
  value.append(node("span", `mark mark-${hash % 3}`));
  return value;
}

function label(name: string): string {
  const words = name.replace(/[._-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function newOperationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function harness(kind: string): string {
  return { codex: "Codex", claude_code: "Claude Code", openai_agents: "OpenAI Agents" }[kind] ?? "";
}

function statusText(state: string): string {
  return (
    {
      queued: "Queued",
      claimed: "Starting",
      running: "Working",
      succeeded: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      uncertain: "Needs attention",
    }[state] ?? "Pending"
  );
}

function inputStatus(state: string | undefined): string | undefined {
  return {
    pending: "Waiting to join Task",
    dispatching: "Joining Task",
    accepted: "Joined active Task",
    unknown: "Delivery uncertain",
    withdrawn: "Withdrawn",
  }[state ?? ""];
}

function problem(target: HTMLElement, message?: string): void {
  const value = message ?? "";
  if (target.textContent !== value) target.textContent = value;
  target.hidden = !value;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The Gateway request failed.";
}

function draftFor(current: View): Draft {
  const key = JSON.stringify([current.tag.tagId, current.name]);
  let draft = drafts.get(key);
  if (!draft) {
    draft = { text: "", sending: false };
    drafts.set(key, draft);
  }
  return draft;
}

function renderTags(): void {
  tags.replaceChildren();
  if (roster.length === 0) {
    tags.append(
      node("p", "rail-empty", connected ? "No Tags available" : "Connect to see your Tags"),
    );
  }
  for (const tag of roster) {
    const row = button("", "rail-row tag-row", () => selectTag(tag));
    row.setAttribute("aria-current", view?.tag.tagId === tag.tagId ? "true" : "false");
    row.append(avatar(tag.tagId), node("span", "row-title", tag.tagId));
    tags.append(row);
  }
}

function renderThreads(current?: View): void {
  element("conversations").hidden = !current;
  threads.replaceChildren();
  if (!current) return;
  const names = current.conversations.map(({ name }) => name);
  if (!names.includes(current.name)) names.unshift(current.name);
  for (const name of names) {
    const row = button("", "rail-row thread-row", () =>
      selectConversation(current.tag, name, current.conversations),
    );
    row.setAttribute("aria-current", current.name === name ? "true" : "false");
    row.title = name;
    row.append(node("span", "thread-icon"), node("span", "row-title", label(name)));
    threads.append(row);
  }
}

function renderIdentity(current?: View): void {
  identity.replaceChildren();
  if (!current) {
    identity.append(node("h1", "workspace-title", "Workspace"));
    return;
  }
  const tagName = node("strong", "tag-name", current.tag.tagId);
  const thread = node("h1", "thread-title", label(current.name));
  thread.title = current.name;
  const heading = node("div", "identity-heading");
  heading.append(tagName, thread);
  identity.append(avatar(current.tag.tagId), heading);
  const provider = harness(current.tag.harnessKind);
  if (provider) identity.append(node("span", "harness", provider));
}

function renderEmpty(current?: View): void {
  const empty = node("div", "empty");
  if (current?.loading) {
    empty.append(node("p", "muted", "Loading conversation…"));
  } else if (current) {
    empty.append(avatar(current.tag.tagId, true), node("h2", "", `Message ${current.tag.tagId}`));
    if (current.tag.instructions)
      empty.append(node("p", "tag-instructions", current.tag.instructions));
    const details = node("details", "permissions");
    details.append(node("summary", "", "Permissions"));
    const permissions = current.tag.allowedActions;
    if (permissions.length > 0) {
      const list = node("ul");
      for (const permission of permissions) list.append(node("li", "", permission));
      details.append(list);
    } else {
      details.append(node("p", "", "No allowed actions are configured."));
    }
    empty.append(details);
  } else if (connected) {
    empty.append(
      node("h2", "", "No Tags available"),
      node("p", "", "Configure a Tag in this workspace to start a conversation."),
    );
  } else {
    const image = node("img", "empty-mascot");
    image.src = mascot;
    image.alt = "";
    empty.append(
      image,
      node("h2", "", "Your Tags, in one place"),
      node("p", "", "Connect to a SuperTag Gateway to work with your persistent coding agents."),
      button("Connect Gateway", "primary", openGateway),
    );
  }
  timeline.append(empty);
}

function renderHistory(current?: View, forceBottom = false): void {
  const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90;
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.taskId
      : undefined;
  timeline.replaceChildren();
  const messages = current
    ? [
        ...new Map(
          [...current.older, ...current.recent].map((message) => [message.task.taskId, message]),
        ).values(),
      ]
    : [];
  if (!current || messages.length === 0) {
    renderEmpty(current);
    return;
  }

  if (current.cursor) {
    const earlier = button(
      current.loadingOlder ? "Loading…" : "Load earlier messages",
      "earlier",
      () => void loadOlder(current),
    );
    earlier.disabled = current.loadingOlder;
    timeline.append(earlier);
  }
  for (const { task, liveInput } of messages) {
    const group = node("article", "exchange");
    const user = node("div", "user-turn");
    user.append(node("span", "visually-hidden", "You"), node("p", "prompt-text", task.prompt));
    const reply = node("div", "tag-turn");
    const body = node("div", "reply-body");
    const header = node("div", "reply-heading");
    const status = inputStatus(liveInput?.state) ?? statusText(task.state);
    const activityTask = liveInput?.state === "accepted" ? liveInput.taskId : task.taskId;
    const inspect = button(status, "task-status", () => openActivity(activityTask));
    inspect.dataset.state = task.state;
    inspect.dataset.taskId = task.taskId;
    inspect.title = "View Task activity";
    inspect.setAttribute("aria-label", `${status} · View Task activity`);
    inspect.setAttribute("aria-controls", "activity");
    inspect.setAttribute("aria-expanded", String(active?.taskId === activityTask));
    header.append(node("strong", "", current.tag.tagId), inspect);
    body.append(header);
    if (task.result && liveInput?.state !== "accepted")
      body.append(node("p", "result-text", task.result));
    reply.append(avatar(current.tag.tagId), body);
    group.append(user, reply);
    timeline.append(group);
  }
  if (focused) {
    [...timeline.querySelectorAll<HTMLButtonElement>(".task-status")]
      .find((item) => item.dataset.taskId === focused)
      ?.focus({ preventScroll: true });
  }
  if (forceBottom || nearBottom) history.scrollTop = history.scrollHeight;
}

function renderComposer(current?: View): void {
  composer.hidden = !current;
  if (!current) return;
  const draft = draftFor(current);
  if (prompt.value !== draft.text) prompt.value = draft.text;
  prompt.placeholder = `Message ${current.tag.tagId}…`;
  prompt.readOnly = draft.sending;
  send.disabled = draft.sending || draft.text.trim().length === 0;
  problem(sendError, draft.error);
}

function renderConnection(): void {
  const connection = element("connection");
  connection.dataset.connected = String(connected);
  element("connection-label").textContent = preview
    ? "Preview workspace"
    : connected
      ? "Gateway connected"
      : "Gateway disconnected";
  connection.title = preview ? "Exit preview" : "Gateway settings";
}

function selectConversation(tag: Tag, name: string, conversations: Conversation[]): void {
  selection++;
  if (view?.tag.tagId === tag.tagId && view.name === name) return;
  closeActivity();
  const current = {
    tag,
    name,
    conversations,
    recent: [],
    older: [],
    loading: true,
    loadingOlder: false,
    revision: 0,
  };
  view = current;
  problem(syncError);
  renderIdentity(current);
  renderTags();
  renderThreads(current);
  renderComposer(current);
  renderHistory(current, true);
  if (window.matchMedia("(max-width: 700px)").matches) setRail(false);
  void refreshView(current, true);
}

function selectTag(tag: Tag): void {
  if (view?.tag.tagId === tag.tagId) {
    selection++;
    return;
  }
  void openTag(tag);
}

async function openTag(tag: Tag): Promise<void> {
  const request = ++selection;
  const selectedEpoch = epoch;
  try {
    const result = await gateway.conversations(tag.tagId);
    if (epoch !== selectedEpoch || selection !== request) return;
    selectConversation(tag, result[0]?.name ?? "default", result);
  } catch (error) {
    if (epoch === selectedEpoch && selection === request) problem(syncError, describe(error));
  }
}

function selectInitialTag(): void {
  const first = roster[0];
  if (first && !view) void openTag(first);
}

async function refreshView(current: View, first = false): Promise<void> {
  const revision = ++current.revision;
  try {
    const [conversations, page] = await Promise.all([
      gateway.conversations(current.tag.tagId),
      gateway.messages(current.tag.tagId, current.name),
    ]);
    if (view !== current || revision !== current.revision) return;
    const changedThreads =
      JSON.stringify(conversations.map(({ name }) => name)) !==
      JSON.stringify(current.conversations.map(({ name }) => name));
    if (changedThreads) {
      current.conversations = conversations;
      renderThreads(current);
    }
    const recent = [...page.messages].reverse();
    const changedMessages = JSON.stringify(recent) !== JSON.stringify(current.recent);
    const wasLoading = current.loading;
    const oldCursor = current.cursor;
    if (current.older.length || current.loadingOlder) {
      const latestIds = new Set(recent.map(({ task }) => task.taskId));
      current.older.push(...current.recent.filter(({ task }) => !latestIds.has(task.taskId)));
    } else {
      current.cursor = page.nextCursor || undefined;
    }
    current.recent = recent;
    current.loading = false;
    if (wasLoading || changedMessages || current.cursor !== oldCursor)
      renderHistory(current, first);
    problem(syncError);
  } catch (error) {
    if (view !== current || revision !== current.revision) return;
    if (current.loading) {
      current.loading = false;
      renderHistory(current);
    }
    problem(syncError, describe(error));
  }
}

async function loadOlder(current: View): Promise<void> {
  if (!current.cursor || current.loadingOlder) return;
  current.loadingOlder = true;
  renderHistory(current);
  try {
    const page = await gateway.messages(current.tag.tagId, current.name, current.cursor);
    if (view !== current) return;
    current.older = [...page.messages].reverse().concat(current.older);
    current.cursor = page.nextCursor || undefined;
  } catch (error) {
    if (view === current) problem(syncError, describe(error));
  } finally {
    current.loadingOlder = false;
    if (view === current) {
      const oldHeight = history.scrollHeight;
      const oldTop = history.scrollTop;
      renderHistory(current);
      history.scrollTop = Math.max(0, oldTop + history.scrollHeight - oldHeight);
    }
  }
}

async function sendMessage(current: View): Promise<void> {
  const draft = draftFor(current);
  const text = draft.text.trim();
  if (!text || draft.sending) return;
  draft.sending = true;
  pendingSends++;
  draft.error = undefined;
  draft.operationId ??= newOperationId();
  renderComposer(current);
  try {
    const message = await gateway.send(current.tag.tagId, current.name, text, draft.operationId);
    draft.text = "";
    draft.operationId = undefined;
    if (view === current) {
      current.revision++;
      current.loading = false;
      if (!current.recent.some(({ task }) => task.taskId === message.task.taskId))
        current.recent.push(message);
      renderHistory(current, true);
      void refreshView(current);
    }
  } catch (error) {
    draft.error = describe(error);
  } finally {
    draft.sending = false;
    pendingSends--;
    if (view === current) {
      renderComposer(current);
      prompt.focus();
    }
  }
}

function openActivity(taskId: string): void {
  const current = view;
  if (!current) return;
  active = { taskId, after: 0, loading: false };
  activityEvents.replaceChildren();
  activity.hidden = false;
  activityStatus.textContent = "Loading activity…";
  renderHistory(current);
  element<HTMLButtonElement>("close-activity").focus();
  void refreshActivity(current, active);
}

function closeActivity(restoreFocus = false): void {
  const taskId = active?.taskId;
  active = undefined;
  activity.hidden = true;
  activityStatus.textContent = "";
  activityEvents.replaceChildren();
  if (restoreFocus && view) {
    renderHistory(view);
    const buttons = timeline.querySelectorAll<HTMLButtonElement>(".task-status");
    Array.from(buttons)
      .find((item) => item.dataset.taskId === taskId)
      ?.focus({ preventScroll: true });
  }
}

async function refreshActivity(current: View, selection: Activity): Promise<void> {
  if (selection.loading) return;
  selection.loading = true;
  try {
    const events = await gateway.events(current.tag.tagId, selection.taskId, selection.after);
    if (view !== current || active !== selection) return;
    for (const event of events) appendEvent(selection, event);
    activityStatus.textContent = activityEvents.childElementCount
      ? ""
      : "No activity recorded yet.";
  } catch (error) {
    if (active === selection) activityStatus.textContent = describe(error);
  } finally {
    selection.loading = false;
  }
}

function appendEvent(selection: Activity, event: TaskEvent): void {
  if (event.sequence <= selection.after) return;
  selection.after = event.sequence;
  if (event.text) activityEvents.append(node("li", "", event.text));
}

function openGateway(): void {
  if (pendingSends) {
    problem(syncError, "Wait for the message to finish sending before switching Gateways.");
    return;
  }
  if (preview) {
    preview = false;
    gateway = nativeGateway;
    reset();
  }
  gatewayUrl.value = address;
  gatewayToken.value = "";
  disconnect.hidden = !connected;
  problem(gatewayError);
  gatewayDialog.showModal();
}

function reset(nextRoster?: Tag[]): void {
  epoch++;
  selection++;
  connected = nextRoster !== undefined;
  rosterRefreshedAt = performance.now();
  roster = nextRoster ?? [];
  view = undefined;
  drafts.clear();
  closeActivity();
  problem(syncError);
  renderConnection();
  renderTags();
  renderThreads();
  renderIdentity();
  renderHistory();
  renderComposer();
  selectInitialTag();
}

async function poll(): Promise<void> {
  try {
    if (!connected || document.hidden) return;
    const selectedEpoch = epoch;
    if (performance.now() - rosterRefreshedAt > 15_000) {
      const updated = await gateway.tags();
      if (selectedEpoch !== epoch) return;
      rosterRefreshedAt = performance.now();
      if (JSON.stringify(updated) !== JSON.stringify(roster)) {
        roster = updated;
        const selectedTag = roster.find((tag) => tag.tagId === view?.tag.tagId);
        if (view && selectedTag) {
          view.tag = selectedTag;
          renderIdentity(view);
        } else {
          view = undefined;
          closeActivity();
          renderIdentity();
          renderThreads();
          renderHistory();
          renderComposer();
          selectInitialTag();
        }
        renderTags();
      }
    }
    const current = view;
    if (current)
      await Promise.all([
        refreshView(current),
        active ? refreshActivity(current, active) : Promise.resolve(),
      ]);
    else selectInitialTag();
  } catch (error) {
    if (connected) problem(syncError, describe(error));
  } finally {
    window.setTimeout(() => void poll(), 2_500);
  }
}

function setRail(open: boolean): void {
  app.classList.toggle("rail-closed", !open);
  toggleRail.setAttribute("aria-expanded", String(open));
}

element("connection").addEventListener("click", openGateway);
element("new-conversation").addEventListener("click", () => {
  threadName.value = "";
  threadDialog.showModal();
});
element("close-activity").addEventListener("click", () => closeActivity(true));
toggleRail.addEventListener("click", () => setRail(app.classList.contains("rail-closed")));

for (const close of app.querySelectorAll<HTMLButtonElement>("[data-close]")) {
  close.addEventListener("click", () => {
    const dialogId = close.dataset.close;
    if (dialogId && !(dialogId === "gateway-dialog" && connect.disabled)) {
      element<HTMLDialogElement>(dialogId).close();
    }
  });
}

gatewayDialog.addEventListener("close", () => {
  gatewayToken.value = "";
});
gatewayDialog.addEventListener("cancel", (event) => {
  if (connect.disabled) event.preventDefault();
});
gatewayForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (connect.disabled) return;
  connect.disabled = true;
  disconnect.disabled = true;
  problem(gatewayError);
  const nextAddress = gatewayUrl.value.trim();
  reset();
  disconnect.hidden = true;
  try {
    const pending = gateway.connect(nextAddress, gatewayToken.value.trim());
    gatewayToken.value = "";
    await pending;
    address = nextAddress;
    try {
      reset(await gateway.tags());
    } catch (error) {
      await gateway.disconnect();
      reset();
      throw error;
    }
    gatewayDialog.close();
  } catch (error) {
    problem(gatewayError, describe(error));
    gatewayToken.focus();
  } finally {
    connect.disabled = false;
    disconnect.disabled = false;
  }
});
disconnect.addEventListener("click", async () => {
  if (disconnect.disabled) return;
  disconnect.disabled = true;
  connect.disabled = true;
  try {
    await gateway.disconnect();
    reset();
    gatewayDialog.close();
  } catch (error) {
    problem(gatewayError, describe(error));
  } finally {
    disconnect.disabled = false;
    connect.disabled = false;
  }
});
threadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const current = view;
  if (!current) return;
  selectConversation(current.tag, threadName.value, current.conversations);
  threadDialog.close();
  prompt.focus();
});
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (view) void sendMessage(view);
});
prompt.addEventListener("input", () => {
  if (!view) return;
  const draft = draftFor(view);
  if (draft.text.trim() !== prompt.value.trim()) draft.operationId = undefined;
  draft.text = prompt.value;
  draft.error = undefined;
  renderComposer(view);
});
prompt.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!send.disabled) composer.requestSubmit();
});

async function start(): Promise<void> {
  if (window.matchMedia("(max-width: 700px)").matches) setRail(false);
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("preview")) {
    const { previewGateway } = await import("./preview");
    gateway = previewGateway;
    preview = true;
    reset(await gateway.tags());
  } else {
    reset();
  }
  void poll();
}

void start();
