import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const html = htm.bind(h);

const SUPABASE_URL = "https://qcsezegptoblkpvwhtzx.supabase.co";
const SUPABASE_KEY = "sb_publishable_PkA4IRR8xTrug-JgY-vN5g_EsH34zNB";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Helfer ---------- */
const today = () => new Date().toISOString().slice(0, 10);
function fmtDate(d) {
  if (!d) return "";
  const t = today();
  if (d === t) return "Heute";
  const tm = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  if (d === tm) return "Morgen";
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("de-DE", { day: "2-digit", month: "short" });
}
function fmtDay(d) {
  const t = today();
  if (d === t) return "Heute";
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (d === y) return "Gestern";
  return new Date(d + "T00:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
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

/* ---------- Tab: Listenübersicht ---------- */
function ListsTab({ go }) {
  const [lists, setLists] = useState(null);
  const [counts, setCounts] = useState({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  async function load() {
    const { data } = await sb.from("todo_lists").select("*").order("created_at");
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
    await sb.from("todo_lists").insert({ name: nm });
    load();
  }
  async function del(id, nm) {
    if (!confirm(`Liste „${nm}" mit allen Aufgaben löschen?`)) return;
    await sb.from("todo_lists").delete().eq("id", id);
    load();
  }

  if (lists === null) return html`<div class="spinner"></div>`;
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
      : html`
        <div class="lists">
          ${lists.map((l) => html`
            <button class="card listcard" key=${l.id} onClick=${() => go({ name: "list", list: l })}>
              <div class="nm">${l.name}</div>
              <div class="cnt">${counts[l.id] || 0}</div>
              <button class="del" title="Löschen"
                      onClick=${(e) => { e.stopPropagation(); del(l.id, l.name); }}>🗑</button>
            </button>`)}
        </div>`}
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
  const withDue = top.filter((t) => t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const withPrio = top.filter((t) => !t.due_date && t.priority).sort((a, b) => a.priority - b.priority);
  const rest = top.filter((t) => !t.due_date && !t.priority);

  if (top.length === 0)
    return html`<div class="emptyhint">Keine offenen Aufgaben. Alles erledigt! 🎉</div>`;

  const section = (title, items) => items.length > 0 && html`
    <h2>${title}</h2>
    ${items.map((t) => html`
      <${TaskRow} key=${t.id} task=${t} subs=${subs[t.id] || []}
        open=${!!open[t.id]} toggleOpen=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
        listName=${data.listMap[t.list_id]} onChange=${load} editable=${false} />`)}
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
  const [editor, setEditor] = useState(null); // null | {task} | {task:null} (neu)
  const [showDone, setShowDone] = useState(false);

  async function load() {
    const { data } = await sb.from("todos").select("*").eq("list_id", list.id).order("created_at");
    setRows(data || []);
  }
  useEffect(() => { load(); }, [list.id]);

  async function restore(id) {
    await sb.from("todos").update({ done: false, done_at: null }).eq("id", id);
    load();
  }
  async function delPerm(id) {
    if (!confirm("Endgültig löschen?")) return;
    await sb.from("todos").delete().eq("id", id);
    load();
  }

  if (rows === null) return html`<div class="spinner"></div>`;
  const active = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done).sort((a, b) => (b.done_at || "").localeCompare(a.done_at || ""));
  const { top, subs } = buildTree(active);

  return html`
    ${top.length === 0
      ? html`<div class="emptyhint">Noch keine offenen Aufgaben in „${list.name}".<br/>Tippe unten auf <strong>+ Aufgabe</strong>.</div>`
      : top.map((t) => html`
          <${TaskRow} key=${t.id} task=${t} subs=${subs[t.id] || []}
            open=${!!open[t.id]} toggleOpen=${() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
            onEdit=${() => setEditor({ task: t })} onChange=${load} editable=${true} />`)}

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
                <button title="Endgültig löschen" onClick=${() => delPerm(d.id)}>🗑</button>
              </div>
            </div>`)}
        `)}
      </div>`}

    <button class="fab" onClick=${() => setEditor({ task: null })}>+ Aufgabe</button>

    ${editor && html`<${TaskEditor} listId=${list.id} task=${editor.task}
        onClose=${() => setEditor(null)} onSaved=${() => { setEditor(null); load(); }} />`}
  `;
}

/* ---------- Eine Aufgabe mit Subtask-Dropdown ---------- */
function TaskRow({ task, subs, open, toggleOpen, onEdit, onChange, listName, editable }) {
  const [newSub, setNewSub] = useState("");

  async function complete() {
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() }).eq("id", task.id);
    onChange();
  }
  async function del() {
    if (!confirm("Aufgabe löschen?")) return;
    await sb.from("todos").delete().eq("id", task.id);
    onChange();
  }
  async function addSub() {
    const t = newSub.trim();
    if (!t) return;
    setNewSub("");
    await sb.from("todos").insert({ list_id: task.list_id, parent_id: task.id, title: t });
    onChange();
  }
  async function completeSub(id) {
    await sb.from("todos").update({ done: true, done_at: new Date().toISOString() }).eq("id", id);
    onChange();
  }
  async function delSub(id) {
    await sb.from("todos").delete().eq("id", id);
    onChange();
  }

  const over = task.due_date && task.due_date < today();
  const hasSubToggle = subs.length > 0 || open;

  return html`
    <div>
      <div class="task">
        <button class=${"check" + (task.priority === 1 ? " p1" : "")} title="Erledigt" onClick=${complete}></button>
        <div class="body">
          <div class="ttl">${task.title}</div>
          <div class="meta">
            ${listName && html`<span class="chip">🗂 ${listName}</span>`}
            ${task.due_date && html`<span class=${"chip due" + (over ? " over" : "")}>📅 ${fmtDate(task.due_date)}</span>`}
            ${task.priority && html`<span class="chip prio">⭐ P${task.priority}</span>`}
            ${subs.length > 0 && html`<span class="chip" style="cursor:pointer" onClick=${toggleOpen}>
              <span class=${"caret" + (open ? " open" : "")}>▸</span> ${subs.length} Unteraufg.</span>`}
          </div>
        </div>
        <div class="tools">
          ${editable && html`<button title="Unteraufgabe / öffnen" onClick=${toggleOpen}>${open ? "▾" : "▸"}</button>`}
          ${editable && onEdit && html`<button title="Bearbeiten" onClick=${onEdit}>✎</button>`}
          ${editable && html`<button title="Löschen" onClick=${del}>🗑</button>`}
        </div>
      </div>

      ${open && html`
        <div class="subwrap">
          ${subs.map((s) => html`
            <div class=${"sub"} key=${s.id}>
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
        </div>`}
    </div>
  `;
}

/* ---------- Aufgabe anlegen / bearbeiten (Modal) ---------- */
function TaskEditor({ listId, task, onClose, onSaved }) {
  const [title, setTitle] = useState(task?.title || "");
  const [due, setDue] = useState(task?.due_date || "");
  const [prio, setPrio] = useState(task?.priority || null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    const payload = { title: t, due_date: due || null, priority: prio || null };
    if (task) await sb.from("todos").update(payload).eq("id", task.id);
    else await sb.from("todos").insert({ ...payload, list_id: listId });
    setBusy(false);
    onSaved();
  }

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>${task ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</h3>
        <label>Aufgabe</label>
        <textarea autofocus placeholder="Was ist zu tun?" value=${title}
                  onInput=${(e) => setTitle(e.target.value)}></textarea>

        <label>Zieldatum (optional)</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" value=${due} onInput=${(e) => setDue(e.target.value)} />
          ${due && html`<button class="ghost" style="width:auto" onClick=${() => setDue("")}>✕</button>`}
        </div>

        <label>Priorität (optional)</label>
        <div class="prios">
          ${[1, 2, 3, 4, 5, 6].map((p) => html`
            <button class=${prio === p ? "sel" : ""} onClick=${() => setPrio(prio === p ? null : p)}>${p}</button>`)}
          <button class=${"none" + (prio ? "" : " sel")} onClick=${() => setPrio(null)}>keine Priorität</button>
        </div>

        <div class="row2">
          <button class="ghost" onClick=${onClose}>Abbrechen</button>
          <button class="primary" disabled=${busy || !title.trim()} onClick=${save}>${busy ? "…" : "Speichern"}</button>
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
          <input type="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.target.value)} />
          <label>Passwort</label>
          <input type="password" autocomplete="current-password" required value=${pw} onInput=${(e) => setPw(e.target.value)} />
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
