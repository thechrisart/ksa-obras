const TYPES = ["Pintura", "Drywall", "Reparos", "Piso", "Banheiro", "Cozinha", "Elétrica", "Hidráulica", "Outro"];
const STATUS = { orc: "Orçamento", and: "Em andamento", con: "Concluída" };
const STAGES = { antes: "Antes", durante: "Durante", depois: "Depois" };
const BUCKET = "obras";
const MAX_BYTES = 50 * 1024 * 1024;
const SIGN_TTL = 60 * 60 * 24 * 7;

const S = { sb: null, user: null, projects: [], loaded: false, view: "list", pid: null, media: [],
  q: "", fStatus: "", fCity: "", stage: "durante", busy: false, urls: new Map() };
const app = document.getElementById("app");
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = t => t ? new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "";
const fmtTime = t => t ? new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const url = path => S.urls.get(path)?.url || "";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
}

/* ---------- boot ---------- */
(async () => {
  const cfg = window.KSA_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    app.innerHTML = `<div class="empty" style="margin-top:20px"><h2>Site ainda não configurado</h2>
      <p>Preencha <code>config.js</code> com a URL e a chave "anon public" do projeto Supabase e rode o <code>setup.sql</code>. O passo a passo está no README.</p></div>`;
    return;
  }
  S.sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const { data } = await S.sb.auth.getSession();
  setUser(data.session?.user || null);
  S.sb.auth.onAuthStateChange((_e, session) => {
    const u = session?.user || null;
    if ((u && u.id) !== (S.user && S.user.id)) setUser(u);
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();

function setUser(u) {
  S.user = u;
  $("#newBtn").hidden = !u; $("#logout").hidden = !u; $("#who").textContent = u?.email || "";
  if (!u) { S.view = "list"; S.projects = []; S.loaded = false; return renderLogin(); }
  S.view = "list";
  loadProjects();
  if (S.channel) return;
  S.channel = S.sb.channel("obras")
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => loadProjects())
    .on("postgres_changes", { event: "*", schema: "public", table: "media" }, p => {
      const pid = p.new?.project_id || p.old?.project_id;
      if (S.view === "detail" && (!pid || pid === S.pid)) loadMedia();
    })
    .subscribe();
}

function renderLogin(msg = "") {
  app.innerHTML = `<form class="login" id="lf">
    <img src="icons/mark.jpg" alt="">
    <h2>Entrar</h2>
    <p>Use o e-mail e a senha cadastrados pela KSA Grand Construction.</p>
    <label class="f">E-mail<input id="l_email" type="email" autocomplete="username" required></label>
    <label class="f">Senha<input id="l_pass" type="password" autocomplete="current-password" required></label>
    <p class="err" id="lerr" ${msg ? "" : "hidden"}>${esc(msg)}</p>
    <button class="btn primary" type="submit" id="lbtn">Entrar</button>
  </form>`;
  $("#lf").addEventListener("submit", async e => {
    e.preventDefault();
    $("#lbtn").disabled = true;
    const { error } = await S.sb.auth.signInWithPassword({ email: $("#l_email").value.trim(), password: $("#l_pass").value });
    if (error) renderLogin(error.message.includes("Invalid") ? "E-mail ou senha incorretos." : "Não foi possível entrar: " + error.message);
  });
}

/* ---------- data ---------- */
async function sign(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !(S.urls.get(p)?.exp > now + 3600e3)))];
  if (!need.length) return;
  const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrls(need, SIGN_TTL);
  if (error) return;
  data.forEach(d => { if (d.signedUrl) S.urls.set(d.path, { url: d.signedUrl, exp: now + SIGN_TTL * 1000 }); });
}

async function loadProjects() {
  const { data, error } = await S.sb.from("projects").select("*").order("created_at", { ascending: false });
  if (error) { S.loaded = true; app.innerHTML = `<div class="empty" style="margin-top:20px"><h2>Erro ao carregar obras</h2><p>${esc(error.message)}</p></div>`; return; }
  S.projects = data; S.loaded = true;
  await sign(data.map(p => p.cover_path));
  if (S.view === "detail" && !S.projects.find(p => p.id === S.pid)) return goList();
  render();
}

async function loadMedia() {
  const pid = S.pid;
  const { data, error } = await S.sb.from("media").select("*").eq("project_id", pid).order("created_at", { ascending: true });
  if (error) return toast("Erro ao carregar fotos: " + error.message);
  await sign(data.map(m => m.path));
  if (S.pid !== pid) return;
  S.media = data;
  if (S.view === "detail") renderDetail();
}

/* ---------- views ---------- */
function render() { if (!S.user) return; if (S.view === "detail") return renderDetail(); renderList(); }

function renderList() {
  if (!S.loaded) return;
  const cities = [...new Set(S.projects.map(p => (p.city || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const q = S.q.trim().toLowerCase();
  const list = S.projects.filter(p =>
    (!S.fStatus || p.status === S.fStatus) &&
    (!S.fCity || (p.city || "").trim() === S.fCity) &&
    (!q || [p.client, p.city, p.address, p.contact, p.phone, p.type].join(" ").toLowerCase().includes(q)));
  const count = k => S.projects.filter(p => p.status === k).length;
  const totalMedia = S.projects.reduce((n, p) => n + (p.media_count || 0), 0);

  if (!S.projects.length) {
    app.innerHTML = `<div class="empty" style="margin-top:20px">
      <h2>Nenhuma obra cadastrada</h2>
      <p>Cadastre a primeira obra com cliente, cidade, endereço e contato. Depois registre fotos e vídeos de antes, durante e depois do serviço.</p>
      <button class="btn tape" id="emptyNew">+ Cadastrar primeira obra</button></div>`;
    $("#emptyNew").addEventListener("click", () => openForm());
    return;
  }

  app.innerHTML = `
    <div class="tools">
      <input type="search" id="q" placeholder="Buscar cliente, cidade, endereço, telefone…" value="${esc(S.q)}" aria-label="Buscar obras">
      <select id="fStatus" aria-label="Filtrar por status"><option value="">Todos os status</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${S.fStatus === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select id="fCity" aria-label="Filtrar por cidade"><option value="">Todas as cidades</option>
        ${cities.map(c => `<option ${S.fCity === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
    </div>
    <div class="stats">
      <span><b>${S.projects.length}</b> obras</span>
      <span><span class="dot" style="background:var(--navy)"></span> <b>${count("and")}</b> em andamento</span>
      <span><span class="dot" style="background:var(--warn)"></span> <b>${count("orc")}</b> orçamento</span>
      <span><span class="dot" style="background:var(--ok)"></span> <b>${count("con")}</b> concluídas</span>
      <span><b>${totalMedia}</b> fotos e vídeos</span>
    </div>
    ${list.length ? `<div class="grid">${list.map(card).join("")}</div>`
      : `<div class="empty"><h2>Nada encontrado</h2><p>Nenhuma obra combina com a busca ou os filtros.</p></div>`}`;

  $("#q").addEventListener("input", e => { S.q = e.target.value; const pos = e.target.selectionStart; renderList(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); });
  $("#fStatus").addEventListener("change", e => { S.fStatus = e.target.value; renderList(); });
  $("#fCity").addEventListener("change", e => { S.fCity = e.target.value; renderList(); });
  app.querySelectorAll(".card").forEach(c => c.addEventListener("click", () => openDetail(c.dataset.id)));
}

function card(p) {
  const st = p.status || "orc", cover = url(p.cover_path);
  return `<button class="card st-${st}" data-id="${esc(p.id)}">
    <div class="cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : "Sem fotos ainda"}</div>
    <div class="body">
      <div class="row"><span class="chip">${esc(STATUS[st])}</span>${p.type ? `<span class="chip">${esc(p.type)}</span>` : ""}</div>
      <h3>${esc(p.client || "Sem nome")}</h3>
      <div class="meta">${esc([p.address, p.city].filter(Boolean).join(" · "))}</div>
      <div class="meta">${p.media_count || 0} registros · desde ${fmtDate(p.created_at)}</div>
    </div></button>`;
}

function openDetail(id) {
  S.view = "detail"; S.pid = id; S.media = [];
  renderDetail(); loadMedia(); window.scrollTo(0, 0);
}
function goList() { S.view = "list"; S.pid = null; S.media = []; renderList(); window.scrollTo(0, 0); }

function renderDetail() {
  const p = S.projects.find(x => x.id === S.pid);
  if (!p) return;
  const st = p.status || "orc";
  const phone = p.phone || "", email = p.email || "";
  const mapsQ = encodeURIComponent([p.address, p.city].filter(Boolean).join(", "));
  const byStage = k => S.media.filter(m => (m.stage || "durante") === k);
  app.innerHTML = `
    <button class="btn ghost back" id="back">← Todas as obras</button>
    <div class="head">
      <div class="t">
        <div class="row" style="margin-bottom:6px"><span class="chip">${esc(STATUS[st])}</span>${p.type ? `<span class="chip">${esc(p.type)}</span>` : ""}</div>
        <h1>${esc(p.client || "Sem nome")}</h1>
      </div>
      <button class="btn" id="edit">Editar dados</button>
    </div>
    <div class="info">
      <div><div class="k">Cidade</div><div class="v">${esc(p.city || "—")}</div></div>
      <div><div class="k">Endereço</div><div class="v">${esc(p.address || "—")}${mapsQ ? ` <a href="https://www.google.com/maps/search/?api=1&query=${mapsQ}" target="_blank" rel="noopener">Mapa ↗</a>` : ""}</div></div>
      <div><div class="k">Contato</div><div class="v">${esc(p.contact || "—")}</div></div>
      <div><div class="k">Telefone</div><div class="v">${phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}">${esc(phone)}</a><button class="copy" data-copy="${esc(phone)}">Copiar</button>` : "—"}</div></div>
      <div><div class="k">E-mail</div><div class="v">${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a><button class="copy" data-copy="${esc(email)}">Copiar</button>` : "—"}</div></div>
      <div><div class="k">Início</div><div class="v">${esc(p.start_date ? new Date(p.start_date + "T12:00").toLocaleDateString("pt-BR") : fmtDate(p.created_at))}</div></div>
      ${p.notes ? `<div style="grid-column:1/-1"><div class="k">Observações</div><div class="v notes">${esc(p.notes)}</div></div>` : ""}
    </div>

    <section class="log">
      <div class="logbar"><h2>Registro da obra</h2><span class="meta">${S.media.length} fotos e vídeos</span></div>
      <div class="upl">
        <span class="seg" role="group" aria-label="Etapa dos próximos envios">
          ${Object.entries(STAGES).map(([k, v]) => `<button data-stage="${k}" aria-pressed="${S.stage === k}">${v}</button>`).join("")}
        </span>
        <button class="btn tape" id="bCam" ${S.busy ? "disabled" : ""}>Tirar foto</button>
        <button class="btn" id="bVid" ${S.busy ? "disabled" : ""}>Gravar vídeo</button>
        <button class="btn" id="bLib" ${S.busy ? "disabled" : ""}>Escolher arquivos</button>
        <span class="progress" id="prog">${S.busy ? esc(S.busy) : ""}</span>
      </div>
      <div class="upl" style="padding-top:0"><span class="hint">Os envios entram na etapa marcada em laranja. Vídeos até 50 MB (cerca de 1 minuto no celular).</span></div>
      ${Object.entries(STAGES).map(([k, v]) => {
        const items = byStage(k);
        return `<div class="stage"><h3><span class="chip" style="background:${k === "antes" ? "var(--warn)" : k === "depois" ? "var(--ok)" : "var(--navy)"};color:var(--bg)">${v}</span><span class="n">${items.length} ${items.length === 1 ? "registro" : "registros"}</span></h3>
          ${items.length ? `<div class="thumbs">${items.map(thumb).join("")}</div>` : `<div class="meta">Nenhum registro de “${v.toLowerCase()}” ainda.</div>`}</div>`;
      }).join("")}
    </section>`;

  $("#back").addEventListener("click", goList);
  $("#edit").addEventListener("click", () => openForm(p));
  app.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy, b)));
  app.querySelectorAll("[data-stage]").forEach(b => b.addEventListener("click", () => { S.stage = b.dataset.stage; renderDetail(); }));
  $("#bCam").addEventListener("click", () => $("#fileCam").click());
  $("#bVid").addEventListener("click", () => $("#fileVid").click());
  $("#bLib").addEventListener("click", () => $("#fileLib").click());
  app.querySelectorAll(".thumb").forEach(t => t.addEventListener("click", () => openViewer(t.dataset.id)));
}

function thumb(m) {
  const isVid = m.kind === "video";
  return `<button class="thumb" data-id="${esc(m.id)}" aria-label="${esc(m.caption || (isVid ? "Vídeo" : "Foto"))}">
    ${isVid ? `<video src="${esc(url(m.path))}#t=0.1" preload="metadata" muted playsinline></video><span class="play">▶</span>`
      : `<img src="${esc(url(m.path))}" alt="" loading="lazy">`}
    <span class="tag">${esc(m.caption ? m.caption.slice(0, 24) : fmtDate(m.created_at))}</span></button>`;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copiado"; setTimeout(() => btn.textContent = "Copiar", 1500); }
  catch { toast(text); }
}

/* ---------- project form ---------- */
function openForm(p) {
  const edit = !!p; p = p || { status: "and", type: "Pintura" };
  const el = document.createElement("div"); el.className = "sheet";
  el.innerHTML = `<form class="panel" id="pf" novalidate>
    <h2>${edit ? "Editar obra" : "Nova obra"}</h2>
    <div class="fields">
      <label class="f full">Cliente / nome da obra<input id="f_client" required value="${esc(p.client)}" placeholder="Ex.: Residência Oliveira"></label>
      <label class="f">Cidade<input id="f_city" required value="${esc(p.city)}" list="citylist" placeholder="Ex.: Orlando"></label>
      <label class="f">Tipo de serviço<select id="f_type">${TYPES.map(t => `<option ${p.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="f full">Endereço<input id="f_address" value="${esc(p.address)}" placeholder="Rua, número, bairro, CEP"></label>
      <label class="f">Contato<input id="f_contact" value="${esc(p.contact)}" placeholder="Nome de quem atende"></label>
      <label class="f">Telefone<input id="f_phone" type="tel" value="${esc(p.phone)}" placeholder="(000) 000-0000"></label>
      <label class="f">E-mail<input id="f_email" type="email" value="${esc(p.email)}"></label>
      <label class="f">Data de início<input id="f_start" type="date" value="${esc(p.start_date)}"></label>
      <label class="f">Status<select id="f_status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="f full">Observações<textarea id="f_notes" rows="3" placeholder="Cômodos, cores, medidas, materiais…">${esc(p.notes)}</textarea></label>
    </div>
    <datalist id="citylist">${[...new Set(S.projects.map(x => x.city).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join("")}</datalist>
    <p class="err" id="ferr" hidden></p>
    <div class="actions">
      ${edit ? `<button type="button" class="btn danger left" id="fdel">Excluir obra</button>` : ""}
      <button type="button" class="btn" id="fcancel">Cancelar</button>
      <button type="submit" class="btn primary" id="fsave">${edit ? "Salvar" : "Cadastrar obra"}</button>
    </div></form>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener("click", e => { if (e.target === el) close(); });
  $("#fcancel", el).addEventListener("click", close);
  $("#f_client", el).focus();
  const err = m => { const e = $("#ferr", el); e.textContent = m; e.hidden = !m; };

  $("#fdel", el)?.addEventListener("click", function () {
    if (this.dataset.armed) {
      this.disabled = true;
      deleteProject(p.id).then(() => { close(); goList(); loadProjects(); toast("Obra excluída"); })
        .catch(e => { err("Não foi possível excluir: " + e.message); this.disabled = false; });
    } else { this.dataset.armed = 1; this.textContent = `Confirmar: apagar obra e ${p.media_count || 0} registros`; this.classList.add("solid"); }
  });

  $("#pf", el).addEventListener("submit", async e => {
    e.preventDefault();
    const v = id => $("#" + id, el).value.trim();
    const data = { client: v("f_client"), city: v("f_city"), type: v("f_type"), address: v("f_address"), contact: v("f_contact"),
      phone: v("f_phone"), email: v("f_email"), start_date: v("f_start") || null, status: v("f_status"), notes: v("f_notes") };
    if (!data.client) return err("Informe o nome do cliente ou da obra.");
    if (!data.city) return err("Informe a cidade.");
    $("#fsave", el).disabled = true;
    if (edit) {
      const { error } = await S.sb.from("projects").update({ ...data, updated_at: new Date().toISOString() }).eq("id", p.id);
      if (error) { $("#fsave", el).disabled = false; return err("Não foi possível salvar: " + error.message); }
      close(); toast("Obra atualizada"); loadProjects();
    } else {
      const { data: row, error } = await S.sb.from("projects").insert({ ...data, created_by: S.user.id }).select().single();
      if (error) { $("#fsave", el).disabled = false; return err("Não foi possível salvar: " + error.message); }
      close(); toast("Obra cadastrada");
      S.projects.unshift(row); openDetail(row.id); loadProjects();
    }
  });
}

async function deleteProject(id) {
  const { data } = await S.sb.from("media").select("path").eq("project_id", id);
  const paths = (data || []).map(m => m.path);
  for (let i = 0; i < paths.length; i += 100) await S.sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
  const { error } = await S.sb.from("projects").delete().eq("id", id);
  if (error) throw error;
}

/* ---------- uploads ---------- */
["fileCam", "fileVid", "fileLib"].forEach(id => document.getElementById(id).addEventListener("change", e => {
  const files = [...e.target.files]; e.target.value = "";
  if (files.length) uploadFiles(files);
}));

async function shrink(file) {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 2200, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 3e6) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return (await new Promise(r => c.toBlob(r, "image/jpeg", 0.85))) || file;
  } catch { return file; }
}

function extFor(blob, name) {
  const t = blob.type || "";
  if (t === "image/jpeg") return "jpg";
  const fromType = t.split("/")[1]?.replace("quicktime", "mov").replace(/[^a-z0-9]/gi, "");
  return fromType || (name.split(".").pop() || "bin").toLowerCase();
}

async function uploadFiles(files) {
  const pid = S.pid, stage = S.stage;
  let ok = 0; const fail = [];
  for (let i = 0; i < files.length; i++) {
    S.busy = `Enviando ${i + 1} de ${files.length}…`; if (S.view === "detail") renderDetail();
    const f = files[i];
    try {
      const blob = await shrink(f);
      if (blob.size > MAX_BYTES) throw new Error("maior que 50 MB");
      const path = `${pid}/${uid()}.${extFor(blob, f.name || "")}`;
      const up = await S.sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || f.type || "application/octet-stream" });
      if (up.error) throw up.error;
      const kind = (blob.type || f.type || "").startsWith("video") ? "video" : "image";
      const { error } = await S.sb.from("media").insert({ project_id: pid, path, kind, stage, caption: "", name: f.name || "", size: blob.size, created_by: S.user.id });
      if (error) { await S.sb.storage.from(BUCKET).remove([path]); throw error; }
      ok++;
    } catch (e) { fail.push(`${f.name || "arquivo"}: ${e.message || "falhou"}`); }
  }
  await syncProjectSummary(pid);
  S.busy = false;
  await loadMedia();
  toast(fail.length ? `${ok} enviado(s). Não enviados: ${fail.join("; ")}` : `${ok} ${ok === 1 ? "registro enviado" : "registros enviados"}`);
}

async function syncProjectSummary(pid) {
  const { data } = await S.sb.from("media").select("path,kind,stage,created_at").eq("project_id", pid).order("created_at", { ascending: false });
  if (!data) return;
  const imgs = data.filter(m => m.kind === "image");
  const cover = imgs.find(m => m.stage === "depois") || imgs[0];
  await S.sb.from("projects").update({ media_count: data.length, cover_path: cover ? cover.path : null }).eq("id", pid);
  loadProjects();
}

/* ---------- viewer ---------- */
function openViewer(mid) {
  let idx = S.media.findIndex(m => m.id === mid);
  const el = document.createElement("div"); el.className = "viewer"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Visualizar registro");
  document.body.appendChild(el);
  const close = () => { el.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.target.tagName === "INPUT") return; if (e.key === "Escape") close(); if (e.key === "ArrowRight") go(1); if (e.key === "ArrowLeft") go(-1); };
  document.addEventListener("keydown", onKey);
  const go = d => { idx = (idx + d + S.media.length) % S.media.length; draw(); };

  function draw() {
    const m = S.media[idx]; if (!m) return close();
    const isVid = m.kind === "video", src = url(m.path);
    el.innerHTML = `
      <div class="vt"><span class="when">${idx + 1} / ${S.media.length} · ${esc(fmtTime(m.created_at))}</span><span class="spacer"></span>
        <a class="btn" href="${esc(src)}" target="_blank" rel="noopener">Abrir original</a>
        <button class="btn" id="vclose">Fechar</button></div>
      <div class="stagebox">
        ${isVid ? `<video src="${esc(src)}" controls playsinline></video>` : `<img src="${esc(src)}" alt="${esc(m.caption)}">`}
        ${S.media.length > 1 ? `<button class="nav l" id="vprev" aria-label="Anterior">‹</button><button class="nav r" id="vnext" aria-label="Próximo">›</button>` : ""}
      </div>
      <div class="vb">
        <div class="row">
          <input id="vcap" placeholder="Descrição (ex.: massa corrida na parede da sala)" value="${esc(m.caption)}" aria-label="Descrição">
          <select id="vstage" aria-label="Etapa">${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${m.stage === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        </div>
        <div class="row"><button class="btn" id="vsave">Salvar descrição</button><span class="spacer" style="flex:1"></span><button class="btn danger" id="vdel">Excluir</button></div>
      </div>`;
    $("#vclose", el).onclick = close;
    $("#vprev", el)?.addEventListener("click", () => go(-1));
    $("#vnext", el)?.addEventListener("click", () => go(1));
    $("#vsave", el).addEventListener("click", async () => {
      const caption = $("#vcap", el).value.trim(), stage = $("#vstage", el).value;
      const { error } = await S.sb.from("media").update({ caption, stage }).eq("id", m.id);
      if (error) return toast("Não foi possível salvar: " + error.message);
      Object.assign(m, { caption, stage }); toast("Salvo");
      await syncProjectSummary(S.pid); renderDetail();
    });
    $("#vdel", el).addEventListener("click", async function () {
      if (!this.dataset.armed) { this.dataset.armed = 1; this.textContent = "Confirmar exclusão"; this.classList.add("solid"); return; }
      this.disabled = true;
      const { error } = await S.sb.from("media").delete().eq("id", m.id);
      if (error) { this.disabled = false; return toast("Não foi possível excluir: " + error.message); }
      await S.sb.storage.from(BUCKET).remove([m.path]);
      toast("Registro excluído");
      S.media = S.media.filter(x => x.id !== m.id);
      await syncProjectSummary(S.pid); renderDetail();
      if (!S.media.length) return close();
      idx = Math.min(idx, S.media.length - 1); draw();
    });
  }
  draw();
}

$("#home").addEventListener("click", () => { if (S.user && S.view !== "list") goList(); });
$("#newBtn").addEventListener("click", () => openForm());
$("#logout").addEventListener("click", () => S.sb.auth.signOut());
