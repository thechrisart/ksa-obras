const TYPES = ["Pintura", "Drywall", "Reparos", "Piso", "Banheiro", "Cozinha", "Elétrica", "Hidráulica", "Outro"];
const STATUS = { orc: "Orçamento", and: "Em andamento", con: "Concluída" };
const STAGES = { antes: "Antes", durante: "Durante", depois: "Depois" };
const BUCKET = "obras";
const MAX_BYTES = 50 * 1024 * 1024;
const DRIVE_MAX = 500 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;  // múltiplo de 256 KB, exigido pelo Drive
const SIGN_TTL = 60 * 60 * 24 * 7;

const S = { sb: null, user: null, projects: [], loaded: false, view: "list", pid: null, media: [],
  q: "", fStatus: "", fCity: "", stage: "durante", busy: false, urls: new Map(), folders: {}, companies: [], companiesOn: false, fCompany: "" };
const app = document.getElementById("app");
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = t => t ? new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "";
const fmtTime = t => t ? new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const isDrive = path => typeof path === "string" && path.startsWith("drive:");
const driveId = path => path.slice(6);
const url = (path, sz = "w800") => isDrive(path) ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveId(path))}&sz=${sz}` : (S.urls.get(path)?.url || "");
const fullUrl = path => isDrive(path) ? `https://drive.google.com/file/d/${encodeURIComponent(driveId(path))}/view` : url(path);
const CFG = window.KSA_CONFIG || {};
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;
const money = n => new Intl.NumberFormat(CFG.LOCALE || "en-US", { style: "currency", currency: CFG.CURRENCY || "USD" }).format(n || 0);
const matsOf = p => Array.isArray(p.materials) ? p.materials : [];
const matsTotal = p => round2(matsOf(p).reduce((s, m) => s + num(m.qty) * num(m.price), 0));
const jobTotal = p => round2(num(p.labor_value) + matsTotal(p));
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

/* ---------- Google Drive ---------- */
const driveOn = () => !!CFG.DRIVE_URL;
const folderName = p => [p.client, p.city].filter(Boolean).join(" - ");

async function driveCall(action, body = {}) {
  const { data } = await S.sb.auth.getSession();
  const r = await fetch(CFG.DRIVE_URL, { method: "POST", body: JSON.stringify({ action, token: data.session?.access_token, ...body }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "erro no Google Drive");
  return j;
}

async function ensureFolder(p) {
  if (!driveOn() || !p) return;
  try {
    const j = await driveCall("folder", { projectId: p.id, name: folderName(p) });
    S.folders[p.id] = j.folderUrl;
    if (S.view === "detail" && S.pid === p.id) { const a = $("#driveLink"); if (a) { a.href = j.folderUrl; a.hidden = false; } }
  } catch (e) { toast("Google Drive: " + e.message); }
}

const b64 = blob => new Promise((ok, bad) => {
  const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1] || ""); fr.onerror = () => bad(fr.error); fr.readAsDataURL(blob);
});

async function uploadToDrive(blob, p, stage, fileName, onPart) {
  const type = blob.type || "application/octet-stream";
  const { session } = await driveCall("start", { projectId: p.id, name: folderName(p), stage, fileName, mimeType: type, size: blob.size });
  const parts = Math.max(1, Math.ceil(blob.size / CHUNK));
  for (let k = 0, start = 0; k < parts; k++, start += CHUNK) {
    onPart?.(k + 1, parts);
    const j = await driveCall("chunk", { session, start, total: blob.size, data: await b64(blob.slice(start, start + CHUNK)) });
    if (j.done) return j.fileId;
  }
  throw new Error("o Drive não confirmou o arquivo");
}

/* ---------- empresas contratantes ---------- */
const companyOf = p => S.companies.find(c => c.id === p?.company_id) || null;

async function loadCompanies() {
  const { data, error, status } = await S.sb.from("companies").select("*").order("name");
  S.companiesOn = !error && status < 400;
  S.companies = data || [];
}

const companyOptions = (sel, none = "Nenhuma (cobrar o cliente da obra)") =>
  `<option value="">${none}</option>` + S.companies.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? "selected" : ""}>${esc(c.name)}</option>`).join("");

// Abre o cadastro de empresa; onSaved recebe a empresa salva.
function openCompanyForm(co, onSaved) {
  const edit = !!co; co = co || {};
  const el = document.createElement("div"); el.className = "sheet"; el.style.zIndex = 25;
  el.innerHTML = `<form class="panel" novalidate>
    <h2>${edit ? "Editar empresa" : "Nova empresa contratante"}</h2>
    <p class="meta">A empresa que contrata e paga o serviço. Ela aparece como "Bill to" no invoice.</p>
    <div class="fields">
      <label class="f full">Nome da empresa<input id="c_name" value="${esc(co.name)}" placeholder="Ex.: Boston Home Builders LLC"></label>
      <label class="f">Contato<input id="c_contact" value="${esc(co.contact)}" placeholder="Quem cuida do pagamento"></label>
      <label class="f">Telefone<input id="c_phone" type="tel" value="${esc(co.phone)}"></label>
      <label class="f">E-mail<input id="c_email" type="email" value="${esc(co.email)}"></label>
      <label class="f">Tax ID / EIN (opcional)<input id="c_taxid" value="${esc(co.tax_id)}"></label>
      <label class="f full">Endereço<input id="c_address" value="${esc(co.address)}" placeholder="Rua, número, cidade, estado, ZIP"></label>
    </div>
    <p class="err" hidden></p>
    <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary" type="submit">${edit ? "Salvar" : "Cadastrar empresa"}</button></div>
  </form>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $("[data-x]", el).addEventListener("click", close);
  $("#c_name", el).focus();
  $("form", el).addEventListener("submit", async e => {
    e.preventDefault();
    const v = id => $("#" + id, el).value.trim();
    const data = { name: v("c_name"), contact: v("c_contact"), phone: v("c_phone"), email: v("c_email"), tax_id: v("c_taxid"), address: v("c_address") };
    const err = $(".err", el);
    if (!data.name) { err.textContent = "Informe o nome da empresa."; err.hidden = false; return; }
    $("button[type=submit]", el).disabled = true;
    const q = edit ? S.sb.from("companies").update(data).eq("id", co.id) : S.sb.from("companies").insert(data);
    const { data: row, error } = await q.select().single();
    if (error) { err.textContent = "Não foi possível salvar: " + error.message; err.hidden = false; $("button[type=submit]", el).disabled = false; return; }
    await loadCompanies();
    close(); toast(edit ? "Empresa atualizada" : "Empresa cadastrada");
    onSaved?.(row);
  });
}

// Liga um <select> de empresa aos botões "+ Nova" e "Editar".
function wireCompanyPicker(root, selId, none) {
  const sel = $("#" + selId, root), editBtn = $("[data-coedit]", root);
  const sync = () => { if (editBtn) editBtn.hidden = !sel.value; };
  sel.addEventListener("change", sync); sync();
  $("[data-conew]", root).addEventListener("click", () => openCompanyForm(null, row => { sel.innerHTML = companyOptions(row.id, none); sync(); sel.dispatchEvent(new Event("change")); }));
  editBtn?.addEventListener("click", () => openCompanyForm(S.companies.find(c => c.id === sel.value), row => { sel.innerHTML = companyOptions(row.id, none); sync(); sel.dispatchEvent(new Event("change")); }));
}

const companyPicker = (selId, selected, label, none) => `<div class="f full">${label}
  <div class="copick"><select id="${selId}">${companyOptions(selected, none)}</select>
  <button type="button" class="btn" data-coedit hidden>Editar</button><button type="button" class="btn" data-conew>+ Nova empresa</button></div></div>`;

/* ---------- data ---------- */
async function sign(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(p => p && !isDrive(p) && !(S.urls.get(p)?.exp > now + 3600e3)))];
  if (!need.length) return;
  const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrls(need, SIGN_TTL);
  if (error) return;
  data.forEach(d => { if (d.signedUrl) S.urls.set(d.path, { url: d.signedUrl, exp: now + SIGN_TTL * 1000 }); });
}

async function loadProjects() {
  const { data, error } = await S.sb.from("projects").select("*").order("created_at", { ascending: false });
  if (error) { S.loaded = true; app.innerHTML = `<div class="empty" style="margin-top:20px"><h2>Erro ao carregar obras</h2><p>${esc(error.message)}</p></div>`; return; }
  S.projects = data; S.loaded = true;
  await loadCompanies();
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
    (!S.fCompany || (S.fCompany === "-" ? !p.company_id : p.company_id === S.fCompany)) &&
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
      ${S.companiesOn && S.companies.length ? `<select id="fCompany" aria-label="Filtrar por empresa"><option value="">Todas as empresas</option>
        ${S.companies.map(c => `<option value="${esc(c.id)}" ${S.fCompany === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        <option value="-" ${S.fCompany === "-" ? "selected" : ""}>Sem empresa</option></select>` : ""}
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
  $("#fCompany")?.addEventListener("change", e => { S.fCompany = e.target.value; renderList(); });
  app.querySelectorAll(".card").forEach(c => c.addEventListener("click", () => openDetail(c.dataset.id)));
}

function card(p) {
  const st = p.status || "orc", cover = url(p.cover_path);
  return `<button class="card st-${st}" data-id="${esc(p.id)}">
    <div class="cover">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : "Sem fotos ainda"}</div>
    <div class="body">
      <div class="row"><span class="chip">${esc(STATUS[st])}</span>${p.type ? `<span class="chip">${esc(p.type)}</span>` : ""}</div>
      <h3>${esc(p.client || "Sem nome")}</h3>
      ${companyOf(p) ? `<div class="meta co">Para: <b>${esc(companyOf(p).name)}</b></div>` : ""}
      <div class="meta">${esc([p.address, p.city].filter(Boolean).join(" · "))}</div>
      <div class="meta">${p.media_count || 0} registros · desde ${fmtDate(p.created_at)}</div>
      ${jobTotal(p) ? `<div class="meta"><b style="color:var(--ink)">${money(jobTotal(p))}</b> investimento total</div>` : ""}
    </div></button>`;
}

function openDetail(id) {
  S.view = "detail"; S.pid = id; S.media = [];
  renderDetail(); loadMedia(); window.scrollTo(0, 0);
  if (driveOn() && !S.folders[id]) ensureFolder(S.projects.find(p => p.id === id));
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
      <div class="row">
        ${driveOn() ? `<a class="btn" id="driveLink" target="_blank" rel="noopener" href="${esc(S.folders[p.id] || "#")}" ${S.folders[p.id] ? "" : "hidden"}>Pasta no Drive ↗</a>` : ""}
        <button class="btn" id="edit">Editar dados</button>
      </div>
    </div>
    <div class="info">
      <div><div class="k">Cidade</div><div class="v">${esc(p.city || "—")}</div></div>
      <div><div class="k">Endereço</div><div class="v">${esc(p.address || "—")}${mapsQ ? ` <a href="https://www.google.com/maps/search/?api=1&query=${mapsQ}" target="_blank" rel="noopener">Mapa ↗</a>` : ""}</div></div>
      ${S.companiesOn ? `<div><div class="k">Empresa contratante</div><div class="v">${companyOf(p) ? esc(companyOf(p).name) : "—"}</div></div>` : ""}
      <div><div class="k">Contato</div><div class="v">${esc(p.contact || "—")}</div></div>
      <div><div class="k">Telefone</div><div class="v">${phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}">${esc(phone)}</a><button class="copy" data-copy="${esc(phone)}">Copiar</button>` : "—"}</div></div>
      <div><div class="k">E-mail</div><div class="v">${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a><button class="copy" data-copy="${esc(email)}">Copiar</button>` : "—"}</div></div>
      <div><div class="k">Início</div><div class="v">${esc(p.start_date ? new Date(p.start_date + "T12:00").toLocaleDateString("pt-BR") : fmtDate(p.created_at))}</div></div>
      ${p.notes ? `<div style="grid-column:1/-1"><div class="k">Observações</div><div class="v notes">${esc(p.notes)}</div></div>` : ""}
    </div>

    <section class="log">
      <div class="logbar"><h2>Valores</h2><button class="btn tape" id="invBtn">Criar invoice (PDF)</button></div>
      ${matsOf(p).length ? `<div class="tablewrap"><table class="mtable">
        <thead><tr><th>Material</th><th class="r">Qtd.</th><th class="r">Preço unit.</th><th class="r">Total</th></tr></thead>
        <tbody>${matsOf(p).map(m => `<tr><td>${esc(m.desc)}</td><td class="r">${esc(m.qty)}</td><td class="r">${money(m.price)}</td><td class="r">${money(num(m.qty) * num(m.price))}</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="meta">Nenhum material cadastrado. Use "Editar dados" para adicionar.</p>`}
      <div class="totals">
        <div><span>Material</span><b>${money(matsTotal(p))}</b></div>
        <div><span>Trabalho</span><b>${money(p.labor_value)}</b></div>
        <div class="grand"><span>Investimento total</span><b>${money(jobTotal(p))}</b></div>
      </div>
      ${p.invoice_number ? `<p class="meta">Último invoice: ${esc(p.invoice_number)} · ${esc(p.invoice_date ? new Date(p.invoice_date + "T12:00").toLocaleDateString("pt-BR") : "")}</p>` : ""}
    </section>

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
      <div class="upl" style="padding-top:0"><span class="hint">${driveOn() ? "Os envios vão para a pasta da obra no Google Drive, na etapa marcada em laranja. Vídeos até 500 MB." : "Os envios entram na etapa marcada em laranja. Vídeos até 50 MB (cerca de 1 minuto no celular)."}</span></div>
      ${Object.entries(STAGES).map(([k, v]) => {
        const items = byStage(k);
        return `<div class="stage"><h3><span class="chip" style="background:${k === "antes" ? "var(--warn)" : k === "depois" ? "var(--ok)" : "var(--navy)"};color:var(--bg)">${v}</span><span class="n">${items.length} ${items.length === 1 ? "registro" : "registros"}</span></h3>
          ${items.length ? `<div class="thumbs">${items.map(thumb).join("")}</div>` : `<div class="meta">Nenhum registro de “${v.toLowerCase()}” ainda.</div>`}</div>`;
      }).join("")}
    </section>`;

  $("#back").addEventListener("click", goList);
  $("#edit").addEventListener("click", () => openForm(p));
  $("#invBtn").addEventListener("click", () => openInvoice(p));
  app.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy, b)));
  app.querySelectorAll("[data-stage]").forEach(b => b.addEventListener("click", () => { S.stage = b.dataset.stage; renderDetail(); }));
  $("#bCam").addEventListener("click", () => $("#fileCam").click());
  $("#bVid").addEventListener("click", () => $("#fileVid").click());
  $("#bLib").addEventListener("click", () => $("#fileLib").click());
  app.querySelectorAll(".thumb").forEach(t => t.addEventListener("click", () => openViewer(t.dataset.id)));
  app.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!b.classList.contains("armed")) {
      b.classList.add("armed"); b.textContent = "Remover?";
      setTimeout(() => { if (b.isConnected && !b.disabled) { b.classList.remove("armed"); b.textContent = "×"; } }, 4000);
      return;
    }
    b.disabled = true;
    const m = S.media.find(x => x.id === b.dataset.del);
    try { await deleteMedia(m); toast("Removido"); renderDetail(); }
    catch (e) { b.disabled = false; toast("Não foi possível remover: " + e.message); }
  }));
}

function thumb(m) {
  const isVid = m.kind === "video";
  return `<div class="thumbwrap"><button class="thumb" data-id="${esc(m.id)}" aria-label="${esc(m.caption || (isVid ? "Vídeo" : "Foto"))}">
    ${isVid && isDrive(m.path) ? `<img src="${esc(url(m.path))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span class="play">▶</span>`
      : isVid ? `<video src="${esc(url(m.path))}#t=0.1" preload="metadata" muted playsinline></video><span class="play">▶</span>`
      : `<img src="${esc(url(m.path))}" alt="" loading="lazy">`}
    <span class="tag">${esc(m.caption ? m.caption.slice(0, 24) : fmtDate(m.created_at))}</span></button>
    <button class="tdel" data-del="${esc(m.id)}" aria-label="Remover ${isVid ? "vídeo" : "foto"}" title="Remover">×</button></div>`;
}

async function deleteMedia(m) {
  const { error } = await S.sb.from("media").delete().eq("id", m.id);
  if (error) throw error;
  if (isDrive(m.path)) driveCall("trash", { fileId: driveId(m.path) }).catch(e => toast("Google Drive: " + e.message));
  else await S.sb.storage.from(BUCKET).remove([m.path]);
  S.media = S.media.filter(x => x.id !== m.id);
  await syncProjectSummary(S.pid);
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
      ${S.companiesOn ? companyPicker("f_company", p.company_id, "Empresa contratante (quem contratou e paga)", "Nenhuma") : ""}
      <label class="f">Contato<input id="f_contact" value="${esc(p.contact)}" placeholder="Nome de quem atende"></label>
      <label class="f">Telefone<input id="f_phone" type="tel" value="${esc(p.phone)}" placeholder="(000) 000-0000"></label>
      <label class="f">E-mail<input id="f_email" type="email" value="${esc(p.email)}"></label>
      <label class="f">Data de início<input id="f_start" type="date" value="${esc(p.start_date)}"></label>
      <label class="f">Status<select id="f_status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="f full">Observações<textarea id="f_notes" rows="3" placeholder="Cômodos, cores, medidas…">${esc(p.notes)}</textarea></label>
    </div>
    <div class="money-box">
      <h3>Valores</h3>
      <label class="f">Valor do trabalho (mão de obra)<input id="f_labor" type="number" inputmode="decimal" step="0.01" min="0" value="${p.labor_value ?? ""}" placeholder="0.00"></label>
      <div class="f">Material gasto</div>
      <div class="mat mat-head" aria-hidden="true"><span>Material</span><span>Qtd.</span><span>Preço unit.</span><span>Total</span><span></span></div>
      <div id="mats" class="mats"></div>
      <button type="button" class="btn" id="addMat">+ Adicionar material</button>
      <div class="totals" id="ftot"></div>
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

  if (S.companiesOn) wireCompanyPicker(el, "f_company", "Nenhuma");
  const matsEl = $("#mats", el);
  const readMats = () => [...matsEl.querySelectorAll(".mat")].map(r => ({
    desc: $(".m_desc", r).value.trim(), qty: num($(".m_qty", r).value), price: num($(".m_price", r).value) }))
    .filter(m => m.desc || m.price);
  const updateTotals = () => {
    matsEl.querySelectorAll(".mat").forEach(r => $(".m_total", r).textContent = money(num($(".m_qty", r).value) * num($(".m_price", r).value)));
    const draft = { labor_value: num($("#f_labor", el).value), materials: readMats() };
    $("#ftot", el).innerHTML = `<div><span>Material</span><b>${money(matsTotal(draft))}</b></div>
      <div><span>Trabalho</span><b>${money(draft.labor_value)}</b></div>
      <div class="grand"><span>Investimento total</span><b>${money(jobTotal(draft))}</b></div>`;
  };
  const addMatRow = (m = { desc: "", qty: 1, price: "" }) => {
    const r = document.createElement("div"); r.className = "mat";
    r.innerHTML = `<input class="m_desc" placeholder="Ex.: Tinta acrílica 5 gal" value="${esc(m.desc)}" aria-label="Material">
      <input class="m_qty" type="number" inputmode="decimal" step="any" min="0" value="${esc(m.qty)}" aria-label="Quantidade">
      <input class="m_price" type="number" inputmode="decimal" step="0.01" min="0" value="${esc(m.price)}" placeholder="0.00" aria-label="Preço unitário">
      <span class="m_total"></span>
      <button type="button" class="m_del" aria-label="Remover material">×</button>`;
    $(".m_del", r).addEventListener("click", () => { r.remove(); updateTotals(); });
    matsEl.appendChild(r);
  };
  matsOf(p).forEach(addMatRow);
  if (!matsOf(p).length) addMatRow();
  $("#addMat", el).addEventListener("click", () => { addMatRow(); updateTotals(); matsEl.lastElementChild.querySelector(".m_desc").focus(); });
  el.addEventListener("input", e => { if (e.target.closest(".money-box")) updateTotals(); });
  updateTotals();

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
      phone: v("f_phone"), email: v("f_email"), start_date: v("f_start") || null, status: v("f_status"), notes: v("f_notes"),
      labor_value: round2(num(v("f_labor"))), materials: readMats() };
    if (S.companiesOn) data.company_id = v("f_company") || null;
    if (!data.client) return err("Informe o nome do cliente ou da obra.");
    if (!data.city) return err("Informe a cidade.");
    $("#fsave", el).disabled = true;
    if (edit) {
      const { error } = await S.sb.from("projects").update({ ...data, updated_at: new Date().toISOString() }).eq("id", p.id);
      if (error) { $("#fsave", el).disabled = false; return err("Não foi possível salvar: " + error.message); }
      close(); toast("Obra atualizada"); loadProjects();
      if (driveOn() && folderName(p) !== folderName(data)) ensureFolder({ ...p, ...data });
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
  const paths = (data || []).map(m => m.path).filter(p => !isDrive(p));
  for (let i = 0; i < paths.length; i += 100) await S.sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
  const { error } = await S.sb.from("projects").delete().eq("id", id);
  if (error) throw error;
  if (driveOn()) driveCall("trashFolder", { projectId: id }).catch(e => toast("Google Drive: " + e.message));
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
  const pid = S.pid, stage = S.stage, p = S.projects.find(x => x.id === pid);
  let ok = 0; const fail = [];
  for (let i = 0; i < files.length; i++) {
    S.busy = `Enviando ${i + 1} de ${files.length}…`; if (S.view === "detail") renderDetail();
    const f = files[i];
    try {
      const blob = await shrink(f);
      const kind = (blob.type || f.type || "").startsWith("video") ? "video" : "image";
      let path;
      if (driveOn()) {
        if (blob.size > DRIVE_MAX) throw new Error("maior que 500 MB");
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
        const fileName = `${STAGES[stage]} ${stamp} ${uid().slice(0, 4)}.${extFor(blob, f.name || "")}`;
        const fileId = await uploadToDrive(blob, p, stage, fileName, (k, n) => {
          if (n > 1) { S.busy = `Enviando ${i + 1} de ${files.length} · ${Math.round(k / n * 100)}%`; const pr = $("#prog"); if (pr) pr.textContent = S.busy; }
        });
        path = "drive:" + fileId;
      } else {
        if (blob.size > MAX_BYTES) throw new Error("maior que 50 MB");
        path = `${pid}/${uid()}.${extFor(blob, f.name || "")}`;
        const up = await S.sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || f.type || "application/octet-stream" });
        if (up.error) throw up.error;
      }
      const { error } = await S.sb.from("media").insert({ project_id: pid, path, kind, stage, caption: "", name: f.name || "", size: blob.size, created_by: S.user.id });
      if (error) {
        if (isDrive(path)) driveCall("trash", { fileId: driveId(path) }).catch(() => {}); else await S.sb.storage.from(BUCKET).remove([path]);
        throw error;
      }
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
    const isVid = m.kind === "video", src = url(m.path, "w2400");
    el.innerHTML = `
      <div class="vt"><span class="when">${idx + 1} / ${S.media.length} · ${esc(fmtTime(m.created_at))}</span><span class="spacer"></span>
        <a class="btn" href="${esc(fullUrl(m.path))}" target="_blank" rel="noopener">${isDrive(m.path) ? "Abrir no Drive" : "Abrir original"}</a>
        <button class="btn" id="vclose">Fechar</button></div>
      <div class="stagebox">
        ${isVid && isDrive(m.path) ? `<iframe src="https://drive.google.com/file/d/${esc(encodeURIComponent(driveId(m.path)))}/preview" allow="autoplay; fullscreen" title="Vídeo"></iframe>`
          : isVid ? `<video src="${esc(src)}" controls playsinline></video>` : `<img src="${esc(src)}" alt="${esc(m.caption)}">`}
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
      if (isDrive(m.path) && stage !== m.stage) {
        const p = S.projects.find(x => x.id === S.pid);
        driveCall("move", { fileId: driveId(m.path), projectId: S.pid, name: folderName(p), stage }).catch(e => toast("Google Drive: " + e.message));
      }
      Object.assign(m, { caption, stage }); toast("Salvo");
      await syncProjectSummary(S.pid); renderDetail();
    });
    $("#vdel", el).addEventListener("click", async function () {
      if (!this.dataset.armed) { this.dataset.armed = 1; this.textContent = "Confirmar exclusão"; this.classList.add("solid"); return; }
      this.disabled = true;
      try { await deleteMedia(m); } catch (e) { this.disabled = false; return toast("Não foi possível excluir: " + e.message); }
      toast("Registro excluído");
      renderDetail();
      if (!S.media.length) return close();
      idx = Math.min(idx, S.media.length - 1); draw();
    });
  }
  draw();
}

/* ---------- invoice ---------- */
const INV_TXT = {
  en: { title: "INVOICE", billTo: "BILL TO", date: "Invoice date", due: "Due date", service: "Service", site: "Job site",
    desc: "Description", qty: "Qty", unit: "Unit price", amount: "Amount", labor: t => `${t} services - labor`,
    client: "Client", materials: "Materials", matsSub: "Materials subtotal", laborSub: "Labor", total: "TOTAL DUE", notes: "Notes",
    thanks: "Thank you for your business!", locale: "en-US" },
  pt: { title: "INVOICE", billTo: "COBRAR DE", date: "Data", due: "Vencimento", service: "Serviço", site: "Local da obra",
    desc: "Descrição", qty: "Qtd.", unit: "Preço unit.", amount: "Valor", labor: t => `Mão de obra - ${t.toLowerCase()}`,
    client: "Cliente", materials: "Materiais", matsSub: "Subtotal de materiais", laborSub: "Mão de obra", total: "TOTAL A PAGAR", notes: "Observações",
    thanks: "Obrigado pela preferência!", locale: "pt-BR" },
};
const TYPE_EN = { Pintura: "Painting", Drywall: "Drywall", Reparos: "Repair", Piso: "Flooring", Banheiro: "Bathroom", Cozinha: "Kitchen",
  "Elétrica": "Electrical", "Hidráulica": "Plumbing", Outro: "Renovation" };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

// Último nome de empresa digitado no invoice desta obra (fica salvo neste aparelho).
function lastCompany(p) { try { return localStorage.getItem("ksa_co_" + p.id) || ""; } catch { return ""; } }

function nextInvoiceNumber() {
  const y = new Date().getFullYear(), pre = `INV-${y}-`;
  const max = S.projects.map(p => p.invoice_number || "").filter(n => n.startsWith(pre))
    .reduce((m, n) => Math.max(m, parseInt(n.slice(pre.length), 10) || 0), 0);
  return pre + String(max + 1).padStart(4, "0");
}

function loadScript(src) {
  return new Promise((ok, bad) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("não carregou " + src));
    document.head.appendChild(s);
  });
}
async function imgData(src) {
  const b = await (await fetch(src)).blob();
  return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
}

function openInvoice(p) {
  const el = document.createElement("div"); el.className = "sheet";
  const d0 = today();
  el.innerHTML = `<form class="panel" id="invf" novalidate>
    <h2>Criar invoice</h2>
    <p class="meta">${esc(p.client)} · total ${money(jobTotal(p))} (trabalho ${money(p.labor_value)} + material ${money(matsTotal(p))})</p>
    <div class="fields">
      ${S.companiesOn ? companyPicker("i_company", p.company_id, "Cobrar de (Bill to)", "Cliente da obra: " + (p.client || "")) : ""}
      <label class="f">Empresa (Bill to)<input id="i_coname" value="${esc(lastCompany(p))}" placeholder="Empresa para quem fez o trabalho"></label>
      <label class="f">Número<input id="i_num" value="${esc(nextInvoiceNumber())}"></label>
      <label class="f">Idioma do PDF<select id="i_lang"><option value="en">English</option><option value="pt">Português</option></select></label>
      <label class="f">Data<input id="i_date" type="date" value="${d0}"></label>
      <label class="f">Vencimento<input id="i_due" type="date" value="${addDays(d0, 15)}"></label>
      <label class="f full" style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:.95rem;color:var(--ink)">
        <input id="i_detail" type="checkbox" checked style="width:auto;min-height:0"> Mostrar cada material no invoice</label>
      <label class="f full">Observações / forma de pagamento<textarea id="i_notes" rows="3" placeholder="Ex.: Pagamento via Zelle ou cheque. 50% no início, 50% na entrega."></textarea></label>
    </div>
    <p class="err" id="ierr" hidden></p>
    <div class="actions">
      <button type="button" class="btn" id="icancel">Cancelar</button>
      <button type="submit" class="btn primary" id="igo">Baixar PDF</button>
    </div></form>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener("click", e => { if (e.target === el) close(); });
  $("#icancel", el).addEventListener("click", close);
  if (S.companiesOn) wireCompanyPicker(el, "i_company", "Cliente da obra: " + (p.client || ""));
  $("#invf", el).addEventListener("submit", async e => {
    e.preventDefault();
    const opt = { number: $("#i_num", el).value.trim() || nextInvoiceNumber(), lang: $("#i_lang", el).value,
      date: $("#i_date", el).value || d0, due: $("#i_due", el).value, detail: $("#i_detail", el).checked, notes: $("#i_notes", el).value.trim(),
      company: (S.companiesOn && S.companies.find(c => c.id === $("#i_company", el).value)) || null };
    const coName = $("#i_coname", el).value.trim();
    if (!opt.company && coName) opt.company = { name: coName };
    try { localStorage.setItem("ksa_co_" + p.id, coName); } catch {}
    $("#igo", el).disabled = true; $("#igo", el).textContent = "Gerando…";
    try {
      await buildInvoicePdf(p, opt);
      const upd = { invoice_number: opt.number, invoice_date: opt.date };
      if (S.companiesOn) upd.company_id = opt.company?.id || null;  // lembra a empresa para a próxima vez
      await S.sb.from("projects").update(upd).eq("id", p.id);
      close(); toast("Invoice " + opt.number + " gerado"); loadProjects();
    } catch (x) {
      const er = $("#ierr", el); er.textContent = "Não foi possível gerar o PDF: " + x.message; er.hidden = false;
      $("#igo", el).disabled = false; $("#igo", el).textContent = "Baixar PDF";
    }
  });
}

async function buildInvoicePdf(p, o) {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
  const T = INV_TXT[o.lang];
  const fmt = n => new Intl.NumberFormat(T.locale, { style: "currency", currency: CFG.CURRENCY || "USD" }).format(n || 0);
  const fdate = d => d ? new Date(d + "T12:00").toLocaleDateString(T.locale, { year: "numeric", month: "short", day: "2-digit" }) : "-";
  const co = CFG.COMPANY || {};
  const type = o.lang === "en" ? (TYPE_EN[p.type] || p.type || "Renovation") : (p.type || "Reforma");
  const ORANGE = [255, 87, 34], INK = [22, 32, 43], MUTED = [91, 102, 114];

  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;

  // Header band
  doc.setFillColor(...ORANGE); doc.rect(0, 0, W, 112, "F");
  try { doc.addImage(await imgData("icons/mark.jpg"), "JPEG", M, 24, 106, 63); } catch {}
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.text(co.name || "KSA Grand Construction, Inc.", M + 120, 48);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9);
  [co.address, [co.phone, co.email].filter(Boolean).join("  ·  ")].filter(Boolean).forEach((l, i) => doc.text(l, M + 120, 64 + i * 13));
  doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.text(T.title, W - M, 52, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.text("# " + o.number, W - M, 72, { align: "right" });

  // Bill to + meta
  let y = 148;
  doc.setTextColor(...ORANGE); doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.text(T.billTo, M, y);
  const billCo = o.company;
  doc.setTextColor(...INK); doc.setFontSize(12); doc.text(doc.splitTextToSize((billCo ? billCo.name : p.client) || "", 250)[0], M, y + 17);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const billLines = (billCo ? [billCo.contact, billCo.address, billCo.phone, billCo.email, billCo.tax_id && "Tax ID: " + billCo.tax_id]
    : [p.contact, p.address, p.city, p.phone, p.email]).filter(Boolean);
  billLines.forEach((l, i) => doc.text(doc.splitTextToSize(l, 250)[0], M, y + 33 + i * 14));

  const meta = [[T.date, fdate(o.date)], [T.due, fdate(o.due)], [T.service, type]];
  if (billCo) meta.push([T.client, p.client || "-"]);
  meta.push([T.site, [p.address, p.city].filter(Boolean).join(", ") || "-"]);
  meta.forEach(([k, v], i) => {
    const yy = y + i * 18;
    doc.setTextColor(...MUTED); doc.setFontSize(9); doc.text(k, W - M - 210, yy);
    doc.setTextColor(...INK); doc.setFontSize(10); doc.text(doc.splitTextToSize(v, 130)[0], W - M, yy, { align: "right" });
  });
  y = Math.max(y + 33 + billLines.length * 14, y + meta.length * 18) + 16;

  // Line items
  const labor = num(p.labor_value), mats = matsOf(p), matSum = matsTotal(p);
  const body = [];
  if (labor) body.push([T.labor(type), "1", fmt(labor), fmt(labor)]);
  if (o.detail) mats.forEach(m => body.push([m.desc || T.materials, String(m.qty), fmt(m.price), fmt(num(m.qty) * num(m.price))]));
  else if (matSum) body.push([T.materials, "1", fmt(matSum), fmt(matSum)]);
  if (!body.length) body.push([T.labor(type), "1", fmt(0), fmt(0)]);

  doc.autoTable({
    startY: y, margin: { left: M, right: M },
    head: [[T.desc, T.qty, T.unit, T.amount]], body,
    styles: { font: "helvetica", fontSize: 10, textColor: INK, cellPadding: 7, lineColor: [213, 218, 224], lineWidth: 0.5 },
    headStyles: { fillColor: INK, textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [246, 247, 249] },
    columnStyles: { 1: { halign: "right", cellWidth: 50 }, 2: { halign: "right", cellWidth: 95 }, 3: { halign: "right", cellWidth: 95 } },
  });
  y = doc.lastAutoTable.finalY + 18;

  // Totals
  if (y > H - 160) { doc.addPage(); y = 60; }
  const tx = W - M - 230;
  [[T.matsSub, fmt(matSum)], [T.laborSub, fmt(labor)]].forEach(([k, v]) => {
    doc.setTextColor(...MUTED); doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text(k, tx, y);
    doc.setTextColor(...INK); doc.text(v, W - M, y, { align: "right" }); y += 18;
  });
  doc.setFillColor(...ORANGE); doc.rect(tx - 10, y - 6, W - M - tx + 10, 30, "F");
  doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(12);
  doc.text(T.total, tx, y + 13); doc.text(fmt(jobTotal(p)), W - M - 8, y + 13, { align: "right" });
  y += 50;

  // Notes
  if (o.notes) {
    if (y > H - 110) { doc.addPage(); y = 60; }
    doc.setTextColor(...ORANGE); doc.setFontSize(9); doc.text(T.notes.toUpperCase(), M, y);
    doc.setTextColor(...INK); doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text(doc.splitTextToSize(o.notes, W - 2 * M), M, y + 15);
  }

  // Footer
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...ORANGE); doc.setLineWidth(2); doc.line(M, H - 50, W - M, H - 50);
    doc.setTextColor(...MUTED); doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text(T.thanks, M, H - 34);
    doc.text([co.name || "KSA Grand Construction, Inc.", co.email].filter(Boolean).join("  ·  "), W - M, H - 34, { align: "right" });
  }

  const safe = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "").trim();
  doc.save(`${safe(o.number)} - ${safe(p.client)}.pdf`);
}

$("#home").addEventListener("click", () => { if (S.user && S.view !== "list") goList(); });
$("#newBtn").addEventListener("click", () => openForm());
$("#logout").addEventListener("click", () => S.sb.auth.signOut());
