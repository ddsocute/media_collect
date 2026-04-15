const state = {
  sources: [],
  items: [],
  readIds: new Set(),
  sourceErrors: {},
  lastRefresh: null,
  storage: null,
  filter: "all"
};

const els = {
  sourceForm: document.querySelector("#source-form"),
  sourcesList: document.querySelector("#sources-list"),
  itemsList: document.querySelector("#items-list"),
  sourceCount: document.querySelector("#source-count"),
  unreadCount: document.querySelector("#unread-count"),
  itemCount: document.querySelector("#item-count"),
  lastRefresh: document.querySelector("#last-refresh"),
  refreshAll: document.querySelector("#refresh-all"),
  refreshSmall: document.querySelector("#refresh-all-small"),
  markRead: document.querySelector("#mark-read"),
  sidebarToggle: document.querySelector("#sidebar-toggle"),
  sidebarClose: document.querySelector("#sidebar-close"),
  sidebarBackdrop: document.querySelector("#sidebar-backdrop"),
  storageNotice: document.querySelector("#storage-notice"),
  message: document.querySelector("#message"),
  emptyTemplate: document.querySelector("#empty-template")
};

const platformMeta = {
  youtube: {
    label: "YouTube",
    image: "https://www.google.com/s2/favicons?domain=youtube.com&sz=64"
  },
  podcast: {
    label: "Podcast",
    image: "https://www.google.com/s2/favicons?domain=spotify.com&sz=64"
  },
  facebook: {
    label: "Facebook",
    image: "https://www.google.com/s2/favicons?domain=facebook.com&sz=64"
  },
  threads: {
    label: "Threads",
    image: "https://www.google.com/s2/favicons?domain=threads.net&sz=64"
  },
  rss: {
    label: "RSS",
    image: "https://www.google.com/s2/favicons?domain=rss.com&sz=64"
  }
};

init();

async function init() {
  bindEvents();
  await loadDashboard();
}

function bindEvents() {
  els.sourceForm.addEventListener("submit", onAddSource);
  els.refreshAll.addEventListener("click", () => refreshAll());
  els.refreshSmall.addEventListener("click", () => refreshAll());
  els.markRead.addEventListener("click", markAllRead);
  els.sidebarToggle.addEventListener("click", openSidebar);
  els.sidebarClose.addEventListener("click", closeSidebar);
  els.sidebarBackdrop.addEventListener("click", closeSidebar);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((item) => {
        item.classList.toggle("is-active", item === button);
      });
      renderItems();
    });
  });

  els.sourcesList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.closest("[data-source-id]")?.dataset.sourceId;
    if (!id) return;

    if (button.dataset.action === "delete") {
      await deleteSource(id);
    }

    if (button.dataset.action === "refresh") {
      await refreshSource(id);
    }
  });

  els.itemsList.addEventListener("click", async (event) => {
    const readButton = event.target.closest("button[data-read-id]");
    if (readButton) {
      await markRead([readButton.dataset.readId]);
    }
  });
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    applyDashboard(data);
    render();
  } catch (error) {
    showMessage(error.message);
  }
}

function applyDashboard(data) {
  state.sources = data.sources || [];
  state.items = data.state?.items || [];
  state.readIds = new Set(data.state?.readIds || []);
  state.sourceErrors = data.state?.sourceErrors || {};
  state.lastRefresh = data.state?.lastRefresh || null;
  state.storage = data.storage || state.storage;
}

async function onAddSource(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    setBusy(true);
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    form.reset();
    await loadDashboard();
    closeSidebar();
    hideMessage();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
}

function openSidebar() {
  document.body.classList.add("is-sidebar-open");
  els.sidebarBackdrop.hidden = false;
  els.sidebarToggle.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  document.body.classList.remove("is-sidebar-open");
  els.sidebarBackdrop.hidden = true;
  els.sidebarToggle.setAttribute("aria-expanded", "false");
}

async function deleteSource(id) {
  try {
    setBusy(true);
    await api(`/api/sources/${id}`, { method: "DELETE" });
    await loadDashboard();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshSource(id) {
  try {
    setBusy(true);
    const data = await api(`/api/sources/${id}/refresh`, { method: "POST" });
    applyDashboard(data);
    render();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
}

async function refreshAll() {
  try {
    setBusy(true);
    const data = await api("/api/refresh", { method: "POST" });
    applyDashboard(data);
    render();
    hideMessage();
  } catch (error) {
    showMessage(error.message);
  } finally {
    setBusy(false);
  }
}

async function markAllRead() {
  await markRead(state.items.map((item) => item.id));
}

async function markRead(ids) {
  try {
    const data = await api("/api/read", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    applyDashboard({ sources: state.sources, state: data.state });
    render();
  } catch (error) {
    showMessage(error.message);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "請稍後再試");
  }
  return data;
}

function render() {
  renderStorageNotice();
  renderStats();
  renderSources();
  renderItems();
}

function renderStorageNotice() {
  if (!state.storage || state.storage.shared) {
    els.storageNotice.hidden = true;
    els.storageNotice.textContent = "";
    return;
  }

  els.storageNotice.hidden = false;
  els.storageNotice.textContent = `目前是${state.storage.label}模式，手機、電腦和 Vercel 不會共用來源。接上 Upstash Redis / Vercel KV 後會自動同步。`;
}

function renderStats() {
  const unread = state.items.filter((item) => !state.readIds.has(item.id)).length;
  els.sourceCount.textContent = `${state.sources.length} 個來源`;
  els.unreadCount.textContent = unread;
  els.itemCount.textContent = state.items.length;
  els.lastRefresh.textContent = state.lastRefresh ? formatDate(state.lastRefresh) : "尚未刷新";
}

function renderSources() {
  if (!state.sources.length) {
    els.sourcesList.innerHTML = `<p class="item-summary">還沒有來源。</p>`;
    return;
  }

  els.sourcesList.innerHTML = state.sources
    .map((source) => {
      const meta = platformMeta[source.type] || platformMeta.rss;
      const error = state.sourceErrors[source.id]?.message;
      const subtitle = error ? `無法更新：${escapeHtml(error)}` : escapeHtml(source.notes || source.url || source.feedUrl);
      return `
        <article class="source-row" data-source-id="${escapeHtml(source.id)}">
          <img src="${meta.image}" alt="${meta.label}">
          <div class="source-main">
            <strong title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</strong>
            <span title="${subtitle}">${subtitle}</span>
          </div>
          <div class="source-actions">
            <button class="icon-button" type="button" data-action="refresh" title="刷新">刷</button>
            <button class="icon-button" type="button" data-action="delete" title="刪除">刪</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderItems() {
  const items = filteredItems();
  if (!state.sources.length) {
    els.itemsList.replaceChildren(els.emptyTemplate.content.cloneNode(true));
    return;
  }

  if (!items.length) {
    els.itemsList.innerHTML = `
      <div class="empty-state">
        <img src="https://www.google.com/s2/favicons?domain=rss.com&sz=64" alt="RSS">
        <h2>最近 7 天沒有符合的更新</h2>
        <p>按下刷新後，新的影片、節目和社群 feed 會排在這裡。</p>
      </div>
    `;
    return;
  }

  els.itemsList.innerHTML = items.map(renderItem).join("");
}

function renderItem(item) {
  const meta = platformMeta[item.sourceType] || platformMeta.rss;
  const image = item.image || meta.image;
  const unread = !state.readIds.has(item.id);
  const typeClass = `type-${String(item.sourceType || "rss").replace(/[^a-z0-9_-]/gi, "")}`;
  const summary = item.summary ? `<p class="item-summary">${escapeHtml(item.summary)}</p>` : "";

  return `
    <article class="item-card ${typeClass} ${unread ? "is-unread" : ""}">
      <img class="item-image" src="${escapeAttribute(image)}" alt="${escapeAttribute(item.sourceName)}" loading="lazy">
      <div class="item-body">
        <div class="item-meta">
          <span class="badge">${meta.label}</span>
          <span>${escapeHtml(item.sourceName)}</span>
          <span>${formatDate(item.publishedAt)}</span>
        </div>
        <a class="item-title" href="${escapeAttribute(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
        ${summary}
      </div>
      <div class="item-actions">
        <a class="secondary-button" href="${escapeAttribute(item.link)}" target="_blank" rel="noreferrer">打開</a>
        <button class="secondary-button" type="button" data-read-id="${escapeAttribute(item.id)}">${unread ? "已讀" : "讀過"}</button>
      </div>
    </article>
  `;
}

function filteredItems() {
  return state.items.filter((item) => {
    if (state.filter === "all") return true;
    if (state.filter === "unread") return !state.readIds.has(item.id);
    if (state.filter === "social") return item.sourceType === "facebook" || item.sourceType === "threads";
    return item.sourceType === state.filter;
  });
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間未知";
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function showMessage(text) {
  els.message.hidden = false;
  els.message.textContent = text;
}

function hideMessage() {
  els.message.hidden = true;
  els.message.textContent = "";
}

function setBusy(isBusy) {
  document.body.classList.toggle("is-loading", isBusy);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
