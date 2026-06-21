'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allItems = [];
let allLists = [];
let currentListId = null;
let currentUser = null;
let pendingFocus = null;
const saveTimers = new Map();

// Drag state
let dragItemId = null;
let dropTarget = null;
const INDENT = 28;

// ── API ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

// ── Tree helpers ───────────────────────────────────────────────────────────
function buildTree() {
  const byId = {};
  allItems.forEach(item => (byId[item.id] = { ...item, children: [] }));
  const roots = [];
  allItems.forEach(item => {
    if (item.parent_id != null && byId[item.parent_id]) {
      byId[item.parent_id].children.push(byId[item.id]);
    } else {
      roots.push(byId[item.id]);
    }
  });
  const sort = nodes => {
    nodes.sort((a, b) => a.position - b.position);
    nodes.forEach(n => sort(n.children));
  };
  sort(roots);
  return { byId, roots };
}

function flattenTree(nodes, depth = 0) {
  const out = [];
  nodes.forEach(n => {
    out.push({ ...n, depth });
    out.push(...flattenTree(n.children, depth + 1));
  });
  return out;
}

function getFlatItems() { return flattenTree(buildTree().roots); }
function getItem(id) { return allItems.find(i => i.id === id); }

function getSiblings(parentId) {
  return allItems
    .filter(i => i.parent_id === parentId)
    .sort((a, b) => a.position - b.position);
}

function getDescendantIds(id) {
  const ids = [];
  allItems.filter(i => i.parent_id === id).forEach(c => {
    ids.push(c.id);
    ids.push(...getDescendantIds(c.id));
  });
  return ids;
}

// ── SVG icons ──────────────────────────────────────────────────────────────
const checkSvg = () => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const trashSvg = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
const gripSvg = () => `<svg viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="2.5" r="1.4"/><circle cx="7" cy="2.5" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13.5" r="1.4"/><circle cx="7" cy="13.5" r="1.4"/></svg>`;
const shareSvg = () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

// ── Render (todos) ─────────────────────────────────────────────────────────
function render() {
  const list = document.getElementById('todo-list');
  if (!list) return;

  if (!currentListId) {
    list.innerHTML = '';
    return;
  }

  const flat = getFlatItems();
  const newIds = new Set(flat.map(i => i.id));

  [...list.querySelectorAll(':scope > .todo-item')].forEach(el => {
    if (!newIds.has(Number(el.dataset.id))) el.remove();
  });

  flat.forEach((item, idx) => {
    let el = list.querySelector(`:scope > .todo-item[data-id="${item.id}"]`);

    if (!el) {
      el = makeItemEl(item);
      list.appendChild(el);
    }

    el.setAttribute('data-depth', item.depth);
    el.classList.toggle('is-checked', !!item.checked);
    const cb = el.querySelector('.cb');
    cb.classList.toggle('is-checked', !!item.checked);
    cb.innerHTML = item.checked ? checkSvg() : '';
    const textEl = el.querySelector('.item-text');
    if (document.activeElement !== textEl) textEl.textContent = item.content;

    const itemEls = [...list.querySelectorAll(':scope > .todo-item')];
    if (itemEls[idx] !== el) {
      list.insertBefore(el, itemEls[idx] || document.getElementById('drop-line') || null);
    }
  });

  let emptyEl = list.querySelector('.empty-hint');
  if (flat.length === 0) {
    if (!emptyEl) {
      emptyEl = document.createElement('p');
      emptyEl.className = 'empty-hint';
      emptyEl.textContent = 'No items yet. Click "Add item" or press Enter to start.';
      list.insertBefore(emptyEl, document.getElementById('drop-line') || null);
    }
  } else {
    emptyEl?.remove();
  }

  if (pendingFocus) {
    const { id, atEnd } = pendingFocus;
    pendingFocus = null;
    requestAnimationFrame(() => focusItem(id, atEnd));
  }
}

function makeItemEl(item) {
  const div = document.createElement('div');
  div.className = `todo-item${item.checked ? ' is-checked' : ''}`;
  div.dataset.id = item.id;
  div.setAttribute('data-depth', item.depth);

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.innerHTML = gripSvg();
  grip.title = 'Drag to reorder or indent';

  div.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.cb') || e.target.closest('.delete-btn')) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const THRESHOLD = e.pointerType === 'touch' ? 12 : 8;
    let dragging = false;
    let ghost = null;
    const itemRect = div.getBoundingClientRect();
    const offsetX = e.clientX - itemRect.left;
    const offsetY = e.clientY - itemRect.top;

    const onMove = ev => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
        ev.preventDefault();
        dragging = true;
        dragItemId = item.id;
        div.setPointerCapture(ev.pointerId);
        div.classList.add('dragging');
        document.getElementById('todo-list')?.classList.add('drag-active');

        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = getItem(item.id)?.content || '…';
        document.body.appendChild(ghost);
      }

      if (ghost) {
        ghost.style.left = (ev.clientX - offsetX) + 'px';
        ghost.style.top  = (ev.clientY - offsetY) + 'px';
      }

      const list = document.getElementById('todo-list');
      if (list) {
        dropTarget = calcDropTarget(ev.clientX, ev.clientY, list);
        if (dropTarget) showDropLine(dropTarget, list);
      }
    };

    const onUp = () => {
      div.removeEventListener('pointermove', onMove);
      div.removeEventListener('pointerup', onUp);
      div.removeEventListener('pointercancel', onUp);

      if (dragging) {
        if (dropTarget && dragItemId) executeDrop(dragItemId, dropTarget);
        div.classList.remove('dragging');
        document.getElementById('todo-list')?.classList.remove('drag-active');
        ghost?.remove();
        hideDropLine();
        dragItemId = null;
        dropTarget = null;
      }
    };

    div.addEventListener('pointermove', onMove, { passive: false });
    div.addEventListener('pointerup', onUp);
    div.addEventListener('pointercancel', onUp);
  });

  const cb = document.createElement('div');
  cb.className = `cb${item.checked ? ' is-checked' : ''}`;
  cb.innerHTML = item.checked ? checkSvg() : '';
  cb.addEventListener('click', () => toggleCheck(item.id));

  const text = document.createElement('div');
  text.className = 'item-text';
  text.contentEditable = 'true';
  text.textContent = item.content;
  text.dataset.placeholder = 'List item';
  text.spellcheck = true;
  text.addEventListener('keydown', e => handleKeyDown(e, item.id));
  text.addEventListener('input', () => scheduleContentSave(item.id, text.textContent));
  text.addEventListener('blur', () => flushContentSave(item.id, text.textContent));
  text.addEventListener('paste', e => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });

  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.innerHTML = trashSvg();
  del.title = 'Delete';
  del.addEventListener('click', () => deleteItem(item.id));

  div.appendChild(grip);
  div.appendChild(cb);
  div.appendChild(text);
  div.appendChild(del);
  return div;
}

function focusItem(id, atEnd = true) {
  const el = document.querySelector(`[data-id="${id}"] .item-text`);
  if (!el) return;
  el.focus();
  if (atEnd) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ── Drag and drop ──────────────────────────────────────────────────────────
let dragDropReady = false;

function initDragDrop() {
  if (dragDropReady) return;
  dragDropReady = true;

  const list = document.getElementById('todo-list');
  const dropLine = document.createElement('div');
  dropLine.id = 'drop-line';
  dropLine.className = 'drop-line';
  list.appendChild(dropLine);
}

function calcDropTarget(clientX, clientY, list) {
  const listRect = list.getBoundingClientRect();
  const cursorY = clientY;
  const cursorX = clientX - listRect.left;

  const excludeIds = new Set([dragItemId, ...getDescendantIds(dragItemId)]);
  const flat = getFlatItems().filter(i => !excludeIds.has(i.id));

  let afterIdx = -1;
  let afterEl = null;
  for (let i = 0; i < flat.length; i++) {
    const el = list.querySelector(`:scope > .todo-item[data-id="${flat[i].id}"]`);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (cursorY >= rect.top + rect.height / 2) { afterIdx = i; afterEl = el; }
  }

  const itemAbove = afterIdx >= 0 ? flat[afterIdx] : null;
  const maxDepth = itemAbove ? itemAbove.depth + 1 : 0;
  const rawDepth = Math.floor((cursorX - 20) / INDENT);
  const depth = Math.max(0, Math.min(maxDepth, rawDepth));

  let parentId = null;
  if (depth > 0 && itemAbove) {
    parentId = depth > itemAbove.depth
      ? itemAbove.id
      : findAncestorAtDepth(itemAbove, depth - 1, flat);
  }

  const position = calcInsertPosition(parentId, afterIdx, flat);
  return { parentId, position, lineLeft: 12 + depth * INDENT, afterEl };
}

function findAncestorAtDepth(item, targetDepth, flat) {
  if (targetDepth < 0) return null;
  let cur = item;
  while (cur) {
    if (cur.depth === targetDepth) return cur.id;
    if (cur.depth < targetDepth || cur.parent_id == null) return null;
    cur = flat.find(f => f.id === cur.parent_id) ?? null;
  }
  return null;
}

function calcInsertPosition(parentId, afterIdx, flat) {
  const siblings = getSiblings(parentId)
    .filter(s => s.id !== dragItemId)
    .sort((a, b) => a.position - b.position);
  if (siblings.length === 0) return 100;

  const before = siblings.filter(s => {
    const i = flat.findIndex(f => f.id === s.id);
    return i !== -1 && i <= afterIdx;
  }).sort((a, b) => b.position - a.position);

  const after = siblings.filter(s => {
    const i = flat.findIndex(f => f.id === s.id);
    return i !== -1 && i > afterIdx;
  }).sort((a, b) => a.position - b.position);

  if (before.length === 0) return siblings[0].position / 2;
  if (after.length === 0) return before[0].position + 100;
  return (before[0].position + after[0].position) / 2;
}

function showDropLine(target, list) {
  const line = document.getElementById('drop-line');
  if (!line) return;
  const listRect = list.getBoundingClientRect();
  const topPx = target.afterEl
    ? target.afterEl.getBoundingClientRect().bottom - listRect.top - 1
    : (list.querySelector(':scope > .todo-item')?.getBoundingClientRect().top ?? listRect.top) - listRect.top;
  line.style.cssText = `display:block;top:${topPx}px;left:${target.lineLeft}px;right:8px`;
}

function hideDropLine() {
  const line = document.getElementById('drop-line');
  if (line) line.style.display = 'none';
}

async function executeDrop(itemId, target) {
  const item = getItem(itemId);
  if (!item) return;
  const prev = { parent_id: item.parent_id, position: item.position };
  const idx = allItems.findIndex(i => i.id === itemId);
  allItems[idx] = { ...allItems[idx], parent_id: target.parentId, position: target.position };
  render();
  api('PUT', `/api/todos/${itemId}/move`, { parent_id: target.parentId, position: target.position })
    .catch(err => { allItems[idx] = { ...allItems[idx], ...prev }; render(); showToast(err.message); });
}

// ── Keyboard ───────────────────────────────────────────────────────────────
async function handleKeyDown(e, itemId) {
  const item = getItem(itemId);
  if (!item) return;
  const flat = getFlatItems();
  const idx = flat.findIndex(i => i.id === itemId);

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    flushContentSave(itemId, e.target.textContent);
    await createItem(item.parent_id, itemId);
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    flushContentSave(itemId, e.target.textContent);
    await indentItem(item, flat, idx);
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    flushContentSave(itemId, e.target.textContent);
    await outdentItem(item);
  } else if (e.key === 'Backspace' && e.target.textContent === '') {
    e.preventDefault();
    const prevId = idx > 0 ? flat[idx - 1].id : null;
    await deleteItem(itemId);
    if (prevId) pendingFocus = { id: prevId, atEnd: true };
    render();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (idx > 0) focusItem(flat[idx - 1].id, true);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx < flat.length - 1) focusItem(flat[idx + 1].id, false);
  }
}

// ── Content save ───────────────────────────────────────────────────────────
function scheduleContentSave(id, content) {
  const item = getItem(id);
  if (item) item.content = content;
  if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => {
    saveTimers.delete(id);
    api('PUT', `/api/todos/${id}`, { content }).catch(err => showToast(err.message));
  }, 800));
}

function flushContentSave(id, content) {
  if (saveTimers.has(id)) {
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    const item = getItem(id);
    if (item) item.content = content;
    api('PUT', `/api/todos/${id}`, { content }).catch(err => showToast(err.message));
  }
}

// ── Operations ─────────────────────────────────────────────────────────────
async function createItem(parentId, afterId = null) {
  if (!currentListId) return;
  try {
    const newItem = await api('POST', '/api/todos', {
      content: '', list_id: currentListId,
      parent_id: parentId ?? null, after_id: afterId ?? null,
    });
    allItems.push(newItem);
    pendingFocus = { id: newItem.id, atEnd: true };
    render();
  } catch (err) { showToast(err.message); }
}

async function toggleCheck(id) {
  const item = getItem(id);
  if (!item) return;
  const newChecked = !item.checked;

  const affected = [id, ...getDescendantIds(id)];

  if (!newChecked) {
    let curId = item.parent_id;
    while (curId != null) {
      const ancestor = getItem(curId);
      if (!ancestor) break;
      if (ancestor.checked) affected.push(ancestor.id);
      curId = ancestor.parent_id;
    }
  }

  const prev = {};
  affected.forEach(aid => {
    const i = getItem(aid);
    if (i) { prev[aid] = i.checked; i.checked = newChecked; }
  });
  render();

  Promise.all(affected.map(aid => api('PUT', `/api/todos/${aid}`, { checked: newChecked })))
    .catch(err => {
      affected.forEach(aid => { const i = getItem(aid); if (i) i.checked = prev[aid]; });
      render();
      showToast(err.message);
    });
}

async function deleteItem(id) {
  const toRemove = new Set([id, ...getDescendantIds(id)]);
  allItems = allItems.filter(i => !toRemove.has(i.id));
  render();
  api('DELETE', `/api/todos/${id}`).catch(async err => {
    showToast(err.message); await loadTodos();
  });
}

async function indentItem(item, flat, idx) {
  if (idx === 0) return;
  const newParentId = flat[idx - 1].id;
  if (newParentId === item.parent_id) return;

  const siblings = getSiblings(newParentId);
  const maxPos = siblings.length > 0 ? Math.max(...siblings.map(i => i.position)) : 0;
  const newPosition = maybeRenorm(siblings, newParentId) ?? maxPos + 100;

  const prev = { parent_id: item.parent_id, position: item.position };
  const i = allItems.findIndex(x => x.id === item.id);
  allItems[i] = { ...allItems[i], parent_id: newParentId, position: newPosition };
  pendingFocus = { id: item.id, atEnd: true };
  render();
  api('PUT', `/api/todos/${item.id}/move`, { parent_id: newParentId, position: newPosition })
    .catch(err => { allItems[i] = { ...allItems[i], ...prev }; render(); showToast(err.message); });
}

async function outdentItem(item) {
  if (item.parent_id == null) return;
  const parent = getItem(item.parent_id);
  if (!parent) return;
  const newParentId = parent.parent_id;
  const grandSiblings = getSiblings(newParentId);
  const pIdx = grandSiblings.findIndex(s => s.id === parent.id);
  const nextSib = grandSiblings[pIdx + 1];
  const newPosition = nextSib ? (parent.position + nextSib.position) / 2 : parent.position + 100;

  const prev = { parent_id: item.parent_id, position: item.position };
  const i = allItems.findIndex(x => x.id === item.id);
  allItems[i] = { ...allItems[i], parent_id: newParentId, position: newPosition };
  pendingFocus = { id: item.id, atEnd: true };
  render();
  api('PUT', `/api/todos/${item.id}/move`, { parent_id: newParentId ?? null, position: newPosition })
    .catch(err => { allItems[i] = { ...allItems[i], ...prev }; render(); showToast(err.message); });
}

function maybeRenorm(siblings, parentId) {
  if (siblings.length === 0) return null;
  const sorted = [...siblings].sort((a, b) => a.position - b.position);
  if (!sorted.some((s, i) => i > 0 && s.position - sorted[i - 1].position < 1)) return null;
  const updates = sorted.map((s, i) => {
    const newPos = (i + 1) * 100;
    const item = getItem(s.id); if (item) item.position = newPos;
    return { id: s.id, position: newPos };
  });
  api('POST', '/api/todos/bulk-positions', updates).catch(err => showToast(err.message));
  return (sorted.length + 1) * 100;
}

// ── Views ──────────────────────────────────────────────────────────────────
function showListsView() {
  currentListId = null;
  allItems = [];
  document.getElementById('lists-view').style.display = '';
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('back-btn').style.display = 'none';
  renderListTiles();
}

function showDetailView() {
  document.getElementById('lists-view').style.display = 'none';
  document.getElementById('detail-view').style.display = '';
  document.getElementById('back-btn').style.display = '';
}

// ── List tiles ─────────────────────────────────────────────────────────────
function renderListTiles() {
  const grid = document.getElementById('lists-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (allLists.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tiles-empty';
    empty.innerHTML = '<strong>No lists yet</strong>Click "New list" to get started.';
    grid.appendChild(empty);
    return;
  }

  allLists.forEach(list => {
    const tile = document.createElement('div');
    tile.className = 'list-tile';
    tile.dataset.id = list.id;

    const titleEl = document.createElement('div');
    titleEl.className = 'tile-title';
    titleEl.textContent = list.title;

    const pills = document.createElement('div');
    pills.className = 'tile-pills';

    if (list.shared_by) {
      const pill = document.createElement('span');
      pill.className = 'pill pill-shared-by';
      pill.textContent = `Shared by ${list.shared_by}`;
      pills.appendChild(pill);
    } else if (list.shared_with && list.shared_with.length > 0) {
      const pill = document.createElement('span');
      pill.className = 'pill pill-shared-with';
      const n = list.shared_with.length;
      pill.textContent = `Shared with ${n} ${n === 1 ? 'person' : 'people'}`;
      pills.appendChild(pill);
    }

    const actions = document.createElement('div');
    actions.className = 'tile-actions';

    if (list.is_owner) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'tile-action-btn';
      shareBtn.title = 'Share';
      shareBtn.innerHTML = shareSvg();
      shareBtn.addEventListener('click', e => { e.stopPropagation(); openShareModal(list.id); });
      actions.appendChild(shareBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'tile-action-btn tile-action-del';
      delBtn.title = 'Delete list';
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      delBtn.addEventListener('click', e => { e.stopPropagation(); deleteList(list.id); });
      actions.appendChild(delBtn);
    } else {
      const leaveBtn = document.createElement('button');
      leaveBtn.className = 'tile-action-btn tile-action-del';
      leaveBtn.title = 'Leave list';
      leaveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="13" height="13"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      leaveBtn.addEventListener('click', e => { e.stopPropagation(); leaveList(list.id); });
      actions.appendChild(leaveBtn);
    }

    tile.appendChild(actions);
    tile.appendChild(titleEl);
    tile.appendChild(pills);
    tile.addEventListener('click', () => switchList(list.id));
    grid.appendChild(tile);
  });
}

// ── Lists management ───────────────────────────────────────────────────────
async function loadLists() {
  allLists = await api('GET', '/api/lists');
  renderListTiles();
}

async function switchList(listId) {
  currentListId = listId;
  allItems = [];
  const list = allLists.find(l => l.id === listId);
  setNoteTitle(list?.title ?? '');
  renderNoteHeaderActions(list);
  showDetailView();
  initDragDrop();
  await loadTodos();
}

function renderNoteHeaderActions(list) {
  const actions = document.getElementById('note-header-actions');
  if (!actions) return;
  actions.innerHTML = '';

  if (!list) return;

  if (list.is_owner) {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-ghost btn-share-note';
    shareBtn.innerHTML = `${shareSvg()} Share`;
    shareBtn.addEventListener('click', () => openShareModal(list.id));
    actions.appendChild(shareBtn);
  } else if (list.shared_by) {
    const badge = document.createElement('span');
    badge.className = 'pill pill-shared-by';
    badge.textContent = `Shared by ${list.shared_by}`;
    actions.appendChild(badge);
  }
}

async function createList() {
  try {
    const list = await api('POST', '/api/lists', { title: 'New List' });
    allLists.push(list);
    await switchList(list.id);
    // Put focus on the title so user can rename immediately
    requestAnimationFrame(() => {
      const titleEl = document.getElementById('note-title');
      if (titleEl) {
        titleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  } catch (err) { showToast(err.message); }
}

async function deleteList(listId) {
  if (!confirm('Delete this list and all its items?')) return;
  try {
    await api('DELETE', `/api/lists/${listId}`);
    allLists = allLists.filter(l => l.id !== listId);
    showListsView();
  } catch (err) { showToast(err.message); }
}

async function leaveList(listId) {
  if (!confirm('Leave this shared list?')) return;
  try {
    await api('DELETE', `/api/lists/${listId}/share/${currentUser.username}`);
    allLists = allLists.filter(l => l.id !== listId);
    if (currentListId === listId) showListsView();
    else renderListTiles();
  } catch (err) { showToast(err.message); }
}

function setNoteTitle(title) {
  const el = document.getElementById('note-title');
  if (el) el.textContent = title;
}

// ── Share modal ────────────────────────────────────────────────────────────
let shareModalListId = null;

function openShareModal(listId) {
  shareModalListId = listId;
  const list = allLists.find(l => l.id === listId);
  const titleEl = document.getElementById('share-modal-title');
  if (titleEl) titleEl.textContent = `Share "${list?.title ?? 'list'}"`;
  document.getElementById('share-username-input').value = '';
  renderShareMembers(list?.shared_with ?? []);
  document.getElementById('share-modal').style.display = '';
  document.getElementById('share-username-input').focus();
}

function closeShareModal() {
  document.getElementById('share-modal').style.display = 'none';
  shareModalListId = null;
}

function renderShareMembers(sharedWith) {
  const container = document.getElementById('share-members');
  if (!container) return;
  container.innerHTML = '';

  if (!sharedWith || sharedWith.length === 0) {
    container.innerHTML = '<p class="share-empty">Not shared with anyone yet.</p>';
    return;
  }

  const label = document.createElement('p');
  label.className = 'share-members-label';
  label.textContent = 'Shared with:';
  container.appendChild(label);

  sharedWith.forEach(username => {
    const row = document.createElement('div');
    row.className = 'share-member-row';

    const name = document.createElement('span');
    name.className = 'share-member-name';
    name.textContent = username;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-ghost btn-remove-share';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/lists/${shareModalListId}/share/${username}`);
        const list = allLists.find(l => l.id === shareModalListId);
        if (list) {
          list.shared_with = list.shared_with.filter(u => u !== username);
          renderShareMembers(list.shared_with);
          renderListTiles();
        }
      } catch (err) { showToast(err.message); }
    });

    row.appendChild(name);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

// ── Auth & load ────────────────────────────────────────────────────────────
async function loadTodos() {
  if (!currentListId) return;
  try { allItems = await api('GET', `/api/todos?list_id=${currentListId}`); render(); }
  catch (err) { showToast(err.message); }
}

async function checkAuth() {
  try { currentUser = await api('GET', '/api/auth/me'); showApp(); await loadLists(); }
  catch { showAuth(); }
}

function showApp() {
  document.getElementById('auth-section').style.display = 'none';
  document.getElementById('app-section').style.display = '';
  document.getElementById('username-display').textContent = currentUser.username;
}

function showAuth() {
  document.getElementById('auth-section').style.display = '';
  document.getElementById('app-section').style.display = 'none';
  allItems = []; allLists = []; currentListId = null;
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ── Note title sync (renames current list) ─────────────────────────────────
function initNoteTitleSync() {
  const titleEl = document.getElementById('note-title');
  if (!titleEl) return;
  titleEl.addEventListener('blur', async () => {
    const newTitle = titleEl.textContent.trim() || 'Untitled';
    if (!currentListId) return;
    const list = allLists.find(l => l.id === currentListId);
    if (list && list.title !== newTitle) {
      list.title = newTitle;
      renderListTiles();
      api('PUT', `/api/lists/${currentListId}`, { title: newTitle }).catch(err => showToast(err.message));
    }
  });
  titleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      currentUser = await api('POST', '/api/auth/login', {
        username: document.getElementById('login-username').value.trim(),
        password: document.getElementById('login-password').value,
      });
      showApp(); await loadLists();
    } catch (err) { showToast(err.message); }
  });

  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      currentUser = await api('POST', '/api/auth/register', {
        username: document.getElementById('reg-username').value.trim(),
        password: document.getElementById('reg-password').value,
      });
      showApp(); await loadLists();
    } catch (err) { showToast(err.message); }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    currentUser = null; showAuth();
  });

  document.getElementById('back-btn').addEventListener('click', () => {
    showListsView();
    loadLists();
  });

  document.getElementById('new-list-btn').addEventListener('click', createList);

  document.getElementById('add-item-btn').addEventListener('click', () => {
    const lastRoot = allItems.filter(i => i.parent_id == null).sort((a, b) => b.position - a.position)[0];
    createItem(null, lastRoot?.id ?? null);
  });

  document.getElementById('show-register').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('login-panel').style.display = 'none';
    document.getElementById('register-panel').style.display = '';
    document.getElementById('reg-username').focus();
  });

  document.getElementById('show-login').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('register-panel').style.display = 'none';
    document.getElementById('login-panel').style.display = '';
    document.getElementById('login-username').focus();
  });

  // Share modal
  document.getElementById('share-modal-close').addEventListener('click', closeShareModal);
  document.getElementById('share-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeShareModal();
  });

  document.getElementById('share-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('share-username-input');
    const username = input.value.trim();
    if (!username || !shareModalListId) return;
    try {
      await api('POST', `/api/lists/${shareModalListId}/share`, { username });
      const list = allLists.find(l => l.id === shareModalListId);
      if (list && !list.shared_with.includes(username)) {
        list.shared_with.push(username);
        renderShareMembers(list.shared_with);
        renderListTiles();
      }
      input.value = '';
      showToast(`Shared with ${username}`);
    } catch (err) { showToast(err.message); }
  });

  initNoteTitleSync();
  checkAuth();
});
