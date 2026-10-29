/**
 * KSA Grand Construction · ponte entre o site e o Google Drive da empresa.
 *
 * Instale com a conta ksagrandconstruction@gmail.com (passo a passo no README).
 * Cria a pasta "KSA Obras" no Drive e, dentro dela, uma pasta por obra com
 * as subpastas Antes, Durante e Depois. Só aceita pedidos de quem está logado no site.
 */
const SUPABASE_URL = 'https://vovcceybjhalwukwaxid.supabase.co';
const SUPABASE_KEY = 'sb_publishable_UxqvGeEYX2G2tl56U9Rb_w_TUKGHDmA';
const ROOT_NAME = 'KSA Obras';
const STAGES = { antes: 'Antes', durante: 'Durante', depois: 'Depois' };

function doGet() {
  return json({ ok: true, service: 'ksa-obras-drive', root: rootFolder().getUrl() });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    checkUser(req.token);
    switch (req.action) {
      case 'folder': return json(Object.assign({ ok: true }, folderInfo(projectFolder(req.projectId, req.name))));
      case 'start': return json({ ok: true, session: startUpload(req) });
      case 'chunk': return json(Object.assign({ ok: true }, sendChunk(req)));
      case 'move': DriveApp.getFileById(req.fileId).moveTo(stageFolder(projectFolder(req.projectId, req.name), req.stage)); return json({ ok: true });
      case 'trash': DriveApp.getFileById(req.fileId).setTrashed(true); return json({ ok: true });
      case 'trashFolder': trashProject(req.projectId); return json({ ok: true });
      default: throw new Error('Ação desconhecida: ' + req.action);
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Confere com o Supabase que o token é de alguém logado no site (guarda a resposta por 10 min).
function checkUser(token) {
  if (!token) throw new Error('Faça login no site.');
  const cache = CacheService.getScriptCache();
  const key = 'u' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  if (cache.get(key)) return;
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Login expirado. Saia e entre de novo no site.');
  cache.put(key, '1', 600);
}

function rootFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.createFolder(ROOT_NAME);
  props.setProperty('ROOT_ID', f.getId());
  return f;
}

function cleanName(name) {
  return String(name || 'Obra sem nome').replace(/[\\/]/g, '-').trim().slice(0, 120);
}

function projectFolder(projectId, name) {
  if (!projectId) throw new Error('Obra não informada.');
  const props = PropertiesService.getScriptProperties();
  const key = 'P_' + projectId;
  let folder = null;
  const id = props.getProperty(key);
  if (id) { try { folder = DriveApp.getFolderById(id); if (folder.isTrashed()) folder = null; } catch (e) { folder = null; } }
  if (!folder) {
    folder = rootFolder().createFolder(cleanName(name));
    Object.keys(STAGES).forEach(k => folder.createFolder(STAGES[k]));
    props.setProperty(key, folder.getId());
  } else if (name && folder.getName() !== cleanName(name)) {
    folder.setName(cleanName(name));
  }
  return folder;
}

function folderInfo(folder) {
  return { folderId: folder.getId(), folderUrl: folder.getUrl() };
}

function stageFolder(folder, stage) {
  const label = STAGES[stage] || STAGES.durante;
  const it = folder.getFoldersByName(label);
  return it.hasNext() ? it.next() : folder.createFolder(label);
}

// Abre um envio em partes direto no Drive; o site manda o arquivo em pedaços de 4 MB.
function startUpload(req) {
  const parent = stageFolder(projectFolder(req.projectId, req.name), req.stage);
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': req.mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(req.size),
    },
    payload: JSON.stringify({ name: req.fileName || 'arquivo', parents: [parent.getId()] }),
    muteHttpExceptions: true,
  });
  const h = res.getAllHeaders();
  const session = h.Location || h.location;
  if (!session) throw new Error('O Drive não aceitou o envio: ' + res.getContentText().slice(0, 200));
  return session;
}

function sendChunk(req) {
  const bytes = Utilities.base64Decode(req.data);
  const end = req.start + bytes.length - 1;
  const res = UrlFetchApp.fetch(req.session, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + req.start + '-' + end + '/' + req.total },
    payload: bytes,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 308) return { done: false };
  if (code !== 200 && code !== 201) throw new Error('Falha no envio ao Drive (' + code + ').');
  const file = JSON.parse(res.getContentText());
  // Link de visualização para o site mostrar a foto ou o vídeo.
  DriveApp.getFileById(file.id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { done: true, fileId: file.id };
}

function trashProject(projectId) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('P_' + projectId);
  if (!id) return;
  try { DriveApp.getFolderById(id).setTrashed(true); } catch (e) {}
  props.deleteProperty('P_' + projectId);
}

// Rode esta função uma vez no editor para autorizar o acesso ao Drive.
function autorizar() {
  Logger.log('Pasta da empresa: ' + rootFolder().getUrl());
  UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/health', { headers: { apikey: SUPABASE_KEY }, muteHttpExceptions: true });
}
