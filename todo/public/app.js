import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";

/* Session dauerhaft speichern und über alle *.valeska.cc-Apps teilen (SSO) */
const COOKIE_DOMAIN = location.hostname.endsWith("valeska.cc") ? "; domain=.valeska.cc" : "";
const COOKIE_SET = "; path=/; max-age=34560000; SameSite=Lax; Secure" + COOKIE_DOMAIN;
const COOKIE_DEL = "; path=/; max-age=0; SameSite=Lax; Secure" + COOKIE_DOMAIN;
const CHUNK = 3200;
function readCookies() {
  const o = {};
  for (const c of (document.cookie ? document.cookie.split("; ") : [])) {
    const i = c.indexOf("=");
    if (i > 0) o[c.slice(0, i)] = c.slice(i + 1);
  }
  return o;
}
const cookieStorage = {
  getItem(key) {
    const c = readCookies();
    if (c[key] != null) return decodeURIComponent(c[key]);
    if (c[key + ".0"] != null) {
      let i = 0, out = "";
      while (c[key + "." + i] != null) { out += c[key + "." + i]; i++; }
      return decodeURIComponent(out);
    }
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  setItem(key, value) {
    this.removeItem(key, true);
    const enc = encodeURIComponent(value);
    if (enc.length <= CHUNK) document.cookie = key + "=" + enc + COOKIE_SET;
    else for (let i = 0, n = Math.ceil(enc.length / CHUNK); i < n; i++)
      document.cookie = key + "." + i + "=" + enc.slice(i * CHUNK, (i + 1) * CHUNK) + COOKIE_SET;
    try { localStorage.setItem(key, value); } catch (e) {}
  },
  removeItem(key, keepLocal) {
    const c = readCookies();
    if (c[key] != null) document.cookie = key + "=" + COOKIE_DEL;
    let i = 0;
    while (c[key + "." + i] != null) { document.cookie = key + "." + i + "=" + COOKIE_DEL; i++; }
    if (!keepLocal) { try { localStorage.removeItem(key); } catch (e) {} }
  },
};
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: cookieStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* Footer-Navigation zwischen den Apps */
function Footer({ current }) {
  const apps = [
    { k: "home", i: "⌂", l: "Home", u: "https://home.valeska.cc" },
    { k: "travel", i: "🧳", l: "Reisen", u: "https://travel.valeska.cc" },
    { k: "todo", i: "✅", l: "To-Do", u: "https://todo.valeska.cc" },
  ];
  return html`
    <nav class="appnav">
      ${apps.map((a) => html`
        <a class=${a.k === current ? "active" : ""} href=${a.u}>
          <span class="i">${a.i}</span><span>${a.l}</span>
        </a>`)}
    </nav>`;
}

/* ---------- Helfer ---------- */
const pad = (n) => String(n).padStart(2, "0");
const localYmd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const localHm = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
const today = () => localYmd(new Date());
function dayLabel(ymd) {
  if (!ymd) return "";
  const t = today();
  if (ymd === t) return "Heute";
  if (ymd === localYmd(new Date(Date.now() + 864e5))) return "Morgen";
  if (ymd === localYmd(new Date(Date.now() - 864e5))) return "Gestern";
  return new Date(ymd + "T00:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "short" });
}
const fmtDay = dayLabel;
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return dayLabel(localYmd(d)) + ", " + fmtTime(iso) + " Uhr";
}
// Gruppiert erledigte Aufgaben nach Erledigungs-Datum (neueste zuerst)
function groupDone(done) {
  const map = {};
  for (const d of done) { const day = (d.done_at || "").slice(0, 10) || "—"; (map[day] ||= []).push(d); }
  return Object.keys(map).sort((a, b) => b.localeCompare(a)).map((k) => [k, map[k]]);
}
// Baut aus flacher Liste einen {top:[], subs:{parentId:[]}} Baum
function buildTree(rows) {
  const top = [], subs = {};
  for (const r of rows) {
    if (r.parent_id) (subs[r.parent_id] ||= []).push(r);
    else top.push(r);
  }
  return { top, subs };
}

/* ---------- Drag & Drop (Zeiger-basiert, funktioniert auch mobil) ---------- */
function Sortable({ ids, render, onCommit, movedRef }) {
  const [order, setOrder] = useState(ids);
  const orderRef = useRef(ids);
  const dragId = useRef(null);
  const moved = useRef(false);
  const contRef = useRef(null);
  useEffect(() => { setOrder(ids); orderRef.current = ids; }, [ids.join("|")]);
  orderRef.current = order;

  function start(e, id) {
    dragId.current = id; moved.current = false;
    try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function move(e) {
    if (dragId.current == null) return;
    const cont = contRef.current; if (!cont) return;
    const rows = Array.from(cont.querySelectorAll("[data-sid]"));
    const y = e.clientY;
    let beforeId = null;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) { beforeId = r.getAttribute("data-sid"); break; }
    }
    setOrder((cur) => {
      const id = dragId.current;
      const at = cur.indexOf(id);
      const without = cur.filter((x) => x !== id);
      let idx = beforeId == null ? without.length : without.indexOf(beforeId);
      if (idx < 0) idx = without.length;
      without.splice(idx, 0, id);
      if (without.indexOf(id) !== at) moved.current = true;
      return without;
    });
  }
  function end() {
    if (dragId.current == null) return;
    dragId.current = null;
    if (moved.current) { if (movedRef) movedRef.current = Date.now(); onCommit(orderRef.current); }
    moved.current = false;
  }
  return html`
    <div ref=${contRef} onPointerMove=${move} onPointerUp=${end} onPointerCancel=${end}>
      ${order.map((id) => render(id, (e) => start(e, id), dragId.current === id))}
    </div>`;
}

/* ---------- Bestätigungs-Dialog im App-Stil ---------- */
function ConfirmModal({ text, sub, yes = "OK", danger, onYes, onClose }) {
  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal confirm" onClick=${(e) => e.stopPropagation()}>
        <h3>${text}</h3>
        ${sub && html`<p class="muted" style="margin:6px 0 0">${sub}</p>`}
        <div class="row2">
          <button class="ghost" onClick=${onClose}>Abbrechen</button>
          <button class=${danger ? "danger-solid" : "primary"} onClick=${onYes}>${yes}</button>
        </div>
      </div>
    </div>`;
}

/* ---------- App ---------- */
function App() {
  const [session, setSession] = useState(undefined);
  const [aal, setAal] = useState(null);
  const [view, setView] = useState({ name: "home" });
  const [tab, setTab] = useState("lists"); // lists | all

  async function refreshAal() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal(data || { currentLevel: "aal1", nextLevel: "aal1" });
  }
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAal(); else setAal(null); }, [session]);

  if (session === undefined) return html`<div class="spinner"></div>`;
  if (!session) return html`<${Login} />`;
  if (aal === null) return html`<div class="spinner"></div>`;
  if (aal.currentLevel === "aal1" && aal.nextLevel === "aal2")
    return html`<${MfaChallenge} onDone=${refreshAal} onLogout=${() => sb.auth.signOut()} />`;

  const go = (v) => setView(v);
  return html`
    <header class="appbar">
      ${view.name === "list"
        ? html`<button onClick=${() => go({ name: "home" })}>‹</button>`
        : ""}
      <div class="title" style="cursor:pointer" onClick=${() => go({ name: "home" })}>
        ${view.name === "list" ? view.list.name : "✅ To-Do"}
      </div>
      <a href="https://home.valeska.cc" style="text-decoration:none"><button>⌂ Home</button></a>
      <button onClick=${() => sb.auth.signOut()}>Logout</button>
    </header>
    <main>
      ${view.name === "home"
        ? html`<${Home} tab=${tab} setTab=${setTab} go=${go} />`
        : html`<${ListView} list=${view.list} />`}
      <${Footer} current="todo" />
    </main>
  `;
}

/* ---------- Startseite: Tabs Listen / Alle ---------- */
function Home({ tab, setTab, go }) {
  return html`
    <div class="tabs">
      <button class=${tab === "lists" ? "active" : ""} onClick=${() => setTab("lists")}>Listen</button>
      <button class=${tab === "all" ? "active" : ""} onClick=${() => setTab("all")}>Alle Aufgaben</button>
    </div>
    ${tab === "lists" ? html`<${ListsTab} go=${go} />` : html`<${AllTab} go=${go} />`}
  `;
}

/* ---------- Tab: Listenübersicht (Drag & Drop) ---------- */
function ListsTab({ go }) {
  const [lists, setLists] = useState(null);
  const [counts, setCounts] = useState({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(null);
  const movedRef = useRef(0);

  async function load() {
    const { data } = await sb.from("todo_lists").select("*").order("sort").order("created_at");
    setLists(data || []);
    const { data: t } = await sb.from("todos").select("list_id").eq("done", false).is("parent_id", null);
    const c = {};
    (t || []).forEach((r) => { c[r.list_id] = (c[r.list_id] || 0) + 1; });
    setCounts(c);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    const nm = name.trim();
    if (!nm) return;
    setName(""); setAdding(false);
    await sb.from("todo_lists").insert({ name: nm, sort: Date.now() });
    load();
  }
  function askDel(l) {
    setConfirm({
      text: `Liste „${l.name}" löschen?`,
      sub: "Alle Aufgaben dieser Liste werden mitgelöscht.",
      yes: "Löschen", danger: true,
      onYes: async () => { await sb.from("todo_lists").delete().eq("id", l.id); setConfirm(null); load(); },
    });
  }
  async function commit(ids) {
    await Promise.all(ids.map((id, i) => sb.from("todo_lists").update({ sort: i }).eq("id", id)));
    load();
  }

  if (lists === null) return html`<div class="spinner"></div>`;
  const byId = {}; lists.forEach((l) => (byId[l.id] = l));

  return html`
    ${adding
      ? html`
        <div class="card" style="margin-bottom:14px">
          <label>Name der Liste</label>
          <input autofocus placeholder="z. B. Einkauf, Arbeit, Umzug …" value=${name}
                 onInput=${(e) => setName(e.target.value)}
                 onKeyDown=${(e) => e.key === "Enter" && create()} />
          <div class="row2">
            <button class="ghost" onClick=${() => { setAdding(false); setName(""); }}>Abbrechen</button>
            <button class="primary" onClick=${create}>Anlegen</button>
          </div>
        </div>`
      : html`<button class="primary block" style="margin-bottom:14px" onClick=${() => setAdding(true)}>+ Neue Liste</button>`}

    ${lists.length === 0 && !adding
      ? html`<div class="emptyhint">Noch keine Listen. Leg deine erste Liste an. 📝</div>`
      : html`<${Sortable} ids=${lists.map((l) => l.id)} movedRef=${movedRef} onCommit=${commit}
          render=${(id, onDown, dragging) => {
            const l = byId[id]; if (!l) return null;
            return html`
              <div class=${"card listcard" + (dragging ? " dragging" : "")} data-sid=${id} key=${id}
                   onClick=${() => { if (Date.now() - movedRef.current < 250) return; go({ name: "list", list: l }); }}>
                <span class="drag" title="Ziehen zum Sortieren" onPointerDown=${onDown}>⋮⋮</span>
                <div class="nm">${l.name}</div>
                <div class="cnt">${counts[id] || 0}</div>
                <button class="del" title="Löschen" onClick=${(e) => { e.stopPropagation(); askDel(l); }}>🗑</button>
              </div>`;
          }} />`}

    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}
  `;
}

/* ---------- Tab: Alle Aufgaben (gruppiert) ---------- */
function AllTab({ go }) {
  const [data, setData] = useState(null); // {tree, listMap}
  const [open, setOpen] = useState({});

  async function load() {
    const { data: lists } = await sb.from("todo_lists").select("id,name");
    const listMap = {};
    (lists || []).forEach((l) => (listMap[l.id] = l.name));
    const { data: rows } = await sb.from("todos").select("*").eq("done", false);
    setData({ tree: buildTree(rows || []), listMap });
  }
  useEffect(() => { load(); }, []);

  if (data === null) return html`<div class="spinner"></div>`;
  const { top, subs } = data.tree;
  const withDue = top.filter((t) => t.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const withPrio = top.filter((t) => !t.due_at && t.priority).sort((a, b) => a.priority - b.priority);
  const rest = top.filter((t) => !t.due_at && !t.priority);
  const openTask = (t) => go({ name: "list", list: { id: t.list_id, name: data.listMap[t.list_id] || "Liste" } });

  if (top.length === 0)
    return html`<div class="emptyhint">Keine offenen Aufgaben. Alles erledigt! 🎉</div>`;

  const section = (title, items) => items.length > 0 && html`
    <h2>${title}</h2>
    ${items.map((t) => html`
      <${TaskRow} key=${t.id} task=${t} subs=${subs[t.id] || []}
        open=${!!open[t.id]} toggleOpen=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
        listName=${data.listMap[t.list_id]} onChange=${load} onOpen=${openTask} showSub=${true} />`)}
  `;

  return html`
    ${section("📅 Mit Zieldatum", withDue)}
    ${section("⭐ Nach Priorität", withPrio)}
    ${section("Ohne Datum / Priorität", rest)}
  `;
}

/* ---------- Listenansicht ---------- */
function ListView({ list }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});
  const [editor, setEditor] = useState(null);   // null | {task} | {task:null}
  const [detailId, setDetailId] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const movedRef = useRef(0);

  async function load() {
    const { data } = await sb.from("todos").select("*").eq("list_id", list.id).order("created_at");
    setRows(data || []);
  }
  useEffect(() => { load(); }, [list.id]);

  async function restore(id) {
    await sb.from("todos").update({ done: false, done_at: null }).eq("id", id);
    load();
  }
  function askDelPerm(d) {
    setConfirm({ text: `„${d.title}" endgültig löschen?`, yes: "Löschen", danger: true,
      onYes: async () => { await sb.from("todos").delete().eq("id", d.id); setConfirm(null); load(); } });
  }
  function askDelTask(t, after) {
    setConfirm({ text: `Aufgabe „${t.title}" löschen?`, yes: "Löschen", danger: true,
      onYes: async () => { await sb.from("todos").delete().or(`id.eq.${t.id},parent_id.eq.${t.id}`); setConfirm(null); if (after) after(); load(); } });
  }
  async function commit(ids) {
    await Promise.all(ids.map((id, i) => sb.from("todos").update({ sort: i }).eq("id", id)));
    load();
  }
  const openDetail = (t) => { if (Date.now() - movedRef.current < 250) return; setDetailId(t.id); };

  if (rows === null) return html`<div class="spinner"></div>`;
  const active = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));
  const { top, subs } = buildTree(active);
  const detailTask = detailId ? rows.find((r) => r.id === detailId && !r.done) : null;

  // Reihenfolge: Datum zuerst, dann Priorität, dann frei sortierbar (Drag & Drop)
  const dated = top.filter((t) => t.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const prioed = top.filter((t) => !t.due_at && t.priority).sort((a, b) => a.priority - b.priority);
  const manual = top.filter((t) => !t.due_at && !t.priority)
    .sort((a, b) => (a.sort - b.sort) || (a.created_at || "").localeCompare(b.created_at || ""));
  const manualById = {}; manual.forEach((t) => (manualById[t.id] = t));

  const staticRow = (t) => html`
    <${TaskRow} key=${t.id} task=${t} subs=${subs[t.id] || []}
      open=${!!open[t.id]} toggleOpen=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
      onChange=${load} onOpen=${openDetail} onDelete=${() => askDelTask(t)} showSub=${true} />`;

  const overlays = html`
    ${editor && html`<${TaskEditor} listId=${list.id} task=${editor.task}
        onClose=${() => setEditor(null)} onSaved=${() => { setEditor(null); load(); }} />`}
    ${confirm && html`<${ConfirmModal} text=${confirm.text} sub=${confirm.sub} yes=${confirm.yes}
        danger=${confirm.danger} onYes=${confirm.onYes} onClose=${() => setConfirm(null)} />`}`;

  if (detailTask) return html`
    <${TaskDetail} task=${detailTask} subs=${subs[detailTask.id] || []}
      onBack=${() => setDetailId(null)} onChange=${load}
      onEdit=${() => setEditor({ task: detailTask })}
      onDelete=${() => askDelTask(detailTask, () => setDetailId(null))} />
    ${overlays}`;

  return html`
    ${top.length === 0
      ? html`<div class="emptyhint">Noch keine offenen Aufgaben in „${list.name}".<br/>Tippe unten auf <strong>+ Aufgabe</strong>.</div>`
      : html`
          ${dated.map(staticRow)}
          ${prioed.map(staticRow)}
          <${Sortable} ids=${manual.map((t) => t.id)} movedRef=${movedRef} onCommit=${commit}
            render=${(id, onDown, dragging) => {
              const t = manualById[id]; if (!t) return null;
              return html`
                <${TaskRow} key=${id} task=${t} subs=${subs[id] || []}
                  open=${!!open[id]} toggleOpen=${() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
                  onChange=${load} onOpen=${openDetail} onDelete=${() => askDelTask(t)}
                  dragHandle=${onDown} dragging=${dragging} showSub=${true} />`;
            }} />`}

    ${done.length > 0 && html`
      <div style="margin-top:26px">
        <button class="ghost block" style="text-align:left;display:flex;align-items:center;gap:8px"
                onClick=${() => setShowDone((s) => !s)}>
          <span class=${"caret" + (showDone ? " open" : "")}>▸</span> ✓ Erledigt (${done.length})
        </button>
        ${showDone && groupDone(done).map(([day, items]) => html`
          <h2 key=${day}>${fmtDay(day)}</h2>
          ${items.map((d) => html`
            <div class="task done" key=${d.id}>
              <button class="check" style="background:var(--primary);border-color:transparent" title="Wiederherstellen"
                      onClick=${() => restore(d.id)}>✓</button>
              <div class="body">
                <div class="ttl">${d.title}</div>
                <div class="meta"><span class="chip">${fmtTime(d.done_at)} Uhr</span></div>
              </div>
              <div class="tools">
                <button title="Wiederherstellen" onClick=${() => restore(d.id)}>↩</button>
                <button title="Endgültig löschen" onClick=${() => askDelPerm(d)}>🗑</button>
              </div>
            </div>`)}
        `)}
      </div>`}

    <button class="fab" onClick=${() => setEditor({ task: null })}>+ Aufgabe</button>
    ${overlays}
  `;
}

/* ---------- Unteraufgaben-Liste (in Zeile & Detailseite) ---------- */
function SubList({ task, subs, onChange, editable }) {
  const [newSub, setNewSub] = useState("");
  async function addSub() {
    const t = newSub.trim(); if (!t) return;
    setNewSub("");
    await sb.from("todos").insert({ list_id: task.list_id, parent_id: task.id, title: t });
    onChange();
  }
  async function completeSub(id) {
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() }).eq("id", id);
    onChange();
  }
  async function delSub(id) { await sb.from("todos").delete().eq("id", id); onChange(); }

  return html`
    <div class="subwrap">
      ${subs.map((s) => html`
        <div class="sub" key=${s.id}>
          <button class="check" title="Erledigt" onClick=${() => completeSub(s.id)}></button>
          <div class="ttl">${s.title}</div>
          ${editable && html`<button class="del" onClick=${() => delSub(s.id)}>🗑</button>`}
        </div>`)}
      ${editable && html`
        <div class="addsub">
          <input placeholder="Unteraufgabe hinzufügen …" value=${newSub}
                 onInput=${(e) => setNewSub(e.target.value)}
                 onKeyDown=${(e) => e.key === "Enter" && addSub()} />
          <button class="ghost" style="width:auto;min-height:40px" onClick=${addSub}>+</button>
        </div>`}
    </div>`;
}

/* ---------- Eine Aufgabe (ohne Datum in der Liste) ---------- */
function TaskRow({ task, subs, open, toggleOpen, onChange, onOpen, onDelete, listName, dragHandle, dragging, showSub }) {
  async function complete() {
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() })
      .or(`id.eq.${task.id},parent_id.eq.${task.id}`);
    onChange();
  }
  const hasToggle = subs.length > 0 || open;
  return html`
    <div class=${"task" + (dragging ? " dragging" : "")} data-sid=${task.id}>
      <button class=${"check" + (task.priority === 1 ? " p1" : "")} title="Erledigt" onClick=${complete}></button>
      <div class="body" style=${onOpen ? "cursor:pointer" : ""} onClick=${() => onOpen && onOpen(task)}>
        <div class="ttl">${task.title}</div>
        ${(listName || task.priority || subs.length > 0) && html`
          <div class="meta">
            ${listName && html`<span class="chip">🗂 ${listName}</span>`}
            ${task.priority && html`<span class="chip prio">⭐ P${task.priority}</span>`}
            ${subs.length > 0 && html`<span class="chip" style="cursor:pointer"
              onClick=${(e) => { e.stopPropagation(); toggleOpen(); }}>
              <span class=${"caret" + (open ? " open" : "")}>▸</span> ${subs.length} Unteraufg.</span>`}
          </div>`}
      </div>
      <div class="tools">
        ${hasToggle && html`<button title="Unteraufgaben" onClick=${toggleOpen}>${open ? "▾" : "▸"}</button>`}
        ${onDelete && html`<button title="Löschen" onClick=${onDelete}>🗑</button>`}
        ${dragHandle && html`<span class="drag" title="Ziehen zum Sortieren" onPointerDown=${dragHandle}>⋮⋮</span>`}
      </div>
    </div>
    ${open && showSub && html`<${SubList} task=${task} subs=${subs} onChange=${onChange} editable=${true} />`}
  `;
}

/* ---------- Detailseite einer Aufgabe ---------- */
function TaskDetail({ task, subs, onBack, onChange, onEdit, onDelete }) {
  const over = task.due_at && task.due_at < new Date().toISOString();
  return html`
    <div class="detailbar">
      <button class="ghost" style="width:auto" onClick=${onBack}>‹ Zurück</button>
      <button class="ghost" style="width:auto" onClick=${onEdit}>✎ Bearbeiten</button>
    </div>
    <h1 style="margin:12px 0 6px">${task.title}</h1>
    <div class="meta" style="margin-bottom:8px">
      ${task.due_at
        ? html`<span class=${"chip due" + (over ? " over" : "")}>📅 ${fmtDateTime(task.due_at)}</span>`
        : html`<span class="chip">Kein Zieldatum</span>`}
      ${task.priority
        ? html`<span class="chip prio">⭐ Priorität ${task.priority}</span>`
        : html`<span class="chip">Keine Priorität</span>`}
    </div>
    <h2>Unteraufgaben</h2>
    <${SubList} task=${task} subs=${subs} onChange=${onChange} editable=${true} />
    <button class="ghost block" style="color:var(--danger);margin-top:24px" onClick=${onDelete}>🗑 Aufgabe löschen</button>
  `;
}

/* ---------- Aufgabe anlegen / bearbeiten (Modal) ---------- */
function TaskEditor({ listId, task, onClose, onSaved }) {
  const init = task?.due_at ? new Date(task.due_at) : null;
  const [title, setTitle] = useState(task?.title || "");
  const [date, setDate] = useState(init ? localYmd(init) : "");
  const [time, setTime] = useState(init ? localHm(init) : "");
  const [prio, setPrio] = useState(task?.priority || null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} }
  }, []);

  async function save() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    let due_at = null;
    if (date) { const d = new Date(`${date}T${time || "09:00"}`); due_at = isNaN(d.getTime()) ? null : d.toISOString(); }
    const payload = { title: t, due_at, priority: prio || null };
    if (task) await sb.from("todos").update(payload).eq("id", task.id);
    else await sb.from("todos").insert({ ...payload, list_id: listId, sort: Date.now() });
    setBusy(false);
    onSaved();
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <div class="editbar">
          <button class="ghost" style="width:auto" onClick=${onClose}>Abbrechen</button>
          <strong>${task ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</strong>
          <button class="primary" style="width:auto" disabled=${busy || !title.trim()} onClick=${save}>${busy ? "…" : "Speichern"}</button>
        </div>
        <label>Aufgabe</label>
        <textarea ref=${inputRef} placeholder="Was ist zu tun?" value=${title}
                  onInput=${(e) => setTitle(e.target.value)}
                  onKeyDown=${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}></textarea>

        <label>Zieldatum & Uhrzeit (optional)</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="date" style="flex:1;min-width:140px" value=${date} onInput=${(e) => setDate(e.target.value)} />
          <input type="time" style="flex:1;min-width:110px" value=${time} disabled=${!date} onInput=${(e) => setTime(e.target.value)} />
          ${(date || time) && html`<button class="ghost" style="width:auto" onClick=${() => { setDate(""); setTime(""); }}>✕</button>`}
        </div>

        <label>Priorität (optional)</label>
        <div class="prios">
          ${[1, 2, 3, 4, 5, 6].map((p) => html`
            <button class=${prio === p ? "sel" : ""} onClick=${() => setPrio(prio === p ? null : p)}>${p}</button>`)}
          <button class=${"none" + (prio ? "" : " sel")} onClick=${() => setPrio(null)}>keine Priorität</button>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Login ---------- */
function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setMsg("");
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
      if (error) setMsg(error.message);
    } catch (err) { setMsg("Fehler: " + (err?.message || String(err))); }
    finally { setBusy(false); }
  }
  return html`
    <main>
      <h1 class="center">✅ To-Do</h1>
      <p class="muted center">Bitte anmelden.</p>
      <div class="card" style="max-width:380px;margin:0 auto">
        <form onSubmit=${submit}>
          <label>E-Mail</label>
          <input type="email" name="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" name="password" autocomplete="current-password" required value=${pw} onInput=${(e) => setPw(e.target.value)} />
          ${msg && html`<p class="error" style="margin-top:12px">${msg}</p>`}
          <button class="primary block" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Anmelden"}</button>
        </form>
      </div>
    </main>
  `;
}

/* ---------- 2FA-Abfrage beim Login ---------- */
function MfaChallenge({ onDone, onLogout }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const { data: f } = await sb.auth.mfa.listFactors();
      const totp = (f?.totp || []).find((x) => x.status === "verified");
      if (!totp) { setErr("Kein 2FA-Faktor gefunden."); setBusy(false); return; }
      const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: totp.id });
      if (e1) { setErr(e1.message); setBusy(false); return; }
      const { error: e2 } = await sb.auth.mfa.verify({ factorId: totp.id, challengeId: ch.id, code: code.trim() });
      if (e2) { setErr(e2.message); setBusy(false); return; }
      setBusy(false); onDone();
    } catch (err) { setErr(err?.message || String(err)); setBusy(false); }
  }
  return html`
    <main>
      <h1 class="center">🔐 2-Faktor</h1>
      <p class="muted center">Code aus deiner Authenticator-App eingeben.</p>
      <div class="card" style="max-width:380px;margin:0 auto">
        <form onSubmit=${submit}>
          <label>6-stelliger Code</label>
          <input inputmode="numeric" autocomplete="one-time-code" placeholder="123456"
                 value=${code} onInput=${(e) => setCode(e.target.value)} />
          ${err && html`<p class="error" style="margin-top:12px">${err}</p>`}
          <button class="primary block" style="margin-top:16px" disabled=${busy}>${busy ? "…" : "Bestätigen"}</button>
        </form>
        <button class="ghost block" style="margin-top:10px" onClick=${onLogout}>Abbrechen / Logout</button>
      </div>
    </main>
  `;
}

render(html`<${App} />`, document.getElementById("app"));
