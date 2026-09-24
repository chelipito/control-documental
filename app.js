/* =========================================================
   Lógica principal de Control documental
   - Lee la configuración (config/configuracion.json)
   - Maneja el inicio de sesión y la base de datos (Firebase)
   - Dibuja la pantalla y las ventanas emergentes
   ========================================================= */
import { firebaseConfig } from './config.js';
import { esc, uid, today, fmtDate, isUrl, lsGet, lsSet, normRut, rutValido, cellOf, semaforo } from './utilidades.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, sendPasswordResetEmail, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, getDoc, onSnapshot, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* =========================================================
   Configuración editable (config/configuracion.json)
   ========================================================= */
const CFG_DEFAULT = {
  nombreApp: 'Control documental',
  documentosPorDefecto: ['Contrato de trabajo','Anexo de contrato','Reglamento interno (recepción)','ODI / Obligación de informar'],
  estados: {pendiente:'Pendiente', recibido:'Recibido', aprobado:'Aprobado', observado:'Observado'},
  diasAvisoPlazo: 7
};
let CFG = CFG_DEFAULT;
try{
  const r = await fetch('config/configuracion.json', {cache:'no-store'});
  if(r.ok) CFG = {...CFG_DEFAULT, ...(await r.json())};
}catch(e){ console.warn('No se pudo leer configuracion.json; se usan valores por defecto.', e); }

/* Los códigos de estado (pendiente, recibido...) están fijos porque los usan
   el semáforo y los colores. En el JSON solo se cambia el texto que se muestra. */
const ESTADOS = ['pendiente','recibido','aprobado','observado'].map(k => ({k, t: (CFG.estados && CFG.estados[k]) || CFG_DEFAULT.estados[k]}));
const DOCS_DEFAULT = CFG.documentosPorDefecto;

/* =========================================================
   Estado de la app
   ========================================================= */
const S = {ready:false, user:null, projects:[], workers:[], current:null, filter:'todos', q:''};
let auth, db, unsubs = [];

const $ = s => document.querySelector(s);
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('on'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('on'),2600); }
const curProject = () => S.projects.find(p=>p.id===S.current) || null;
const projWorkers = pid => S.workers.filter(w=>w.proyectoId===pid);

/* =========================================================
   Capa de datos (Firestore)
   ========================================================= */
const stamp = () => ({modificadoPor: S.user?.email || '', modificado: new Date().toISOString()});

async function putProject(p){ const {id, ...body}=p; await setDoc(doc(db,'proyectos',id), {...body, ...stamp()}); }
async function putWorker(w){ const {id, ...body}=w; await setDoc(doc(db,'trabajadores',id), {...body, ...stamp()}); }
async function patchCell(wid, key, cell){
  await updateDoc(doc(db,'trabajadores',wid), {[`docs.${key}`]: {...cell, por: S.user?.email || ''}, ...stamp()});
}
async function removeWorker(wid){ await deleteDoc(doc(db,'trabajadores',wid)); }
async function removeProject(pid){
  const ws = projWorkers(pid);
  // Lotes de hasta 400 operaciones
  for(let i=0;i<ws.length;i+=400){
    const b = writeBatch(db); ws.slice(i,i+400).forEach(w=>b.delete(doc(db,'trabajadores',w.id))); await b.commit();
  }
  await deleteDoc(doc(db,'proyectos',pid));
  if(S.current===pid){ S.current=null; lsSet('cd-current', null); }
}
function dbErr(e){
  console.error(e);
  if(e && e.code==='permission-denied') toast('Tu usuario no tiene permiso para este cambio.');
  else if(e && e.code==='unavailable') toast('Sin conexión. El cambio se enviará al reconectar.');
  else toast('No se pudo guardar el cambio. Intenta de nuevo.');
}

/* =========================================================
   Pantallas de acceso
   ========================================================= */
function renderSetup(){
  $('#topbar').hidden = true;
  $('#app').innerHTML = `<section class="login"><h1>Falta configurar Firebase</h1>
    <p>Abre <b>index.html</b>, busca el bloque <b>firebaseConfig</b> y pega los datos de tu proyecto de Firebase. La guía paso a paso está en el archivo README.</p></section>`;
}
function renderLogin(msg){
  $('#topbar').hidden = true; $('#banner').innerHTML='';
  $('#app').innerHTML = `<section class="login">
    <h1>${esc(CFG.nombreApp)}</h1><p>Ingresa con la cuenta que te habilitaron.</p>
    <button class="btn primary" type="button" id="gBtn">Ingresar con Google</button>
    <div class="or">o con correo</div>
    <form id="eForm" style="display:flex;flex-direction:column;gap:10px">
      <label class="f">Correo<input type="text" name="email" autocomplete="username" inputmode="email" required></label>
      <label class="f">Contraseña<input type="password" name="pass" autocomplete="current-password" required style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 11px;min-height:40px"></label>
      <button class="btn" type="submit">Ingresar</button>
      <button class="btn ghost" type="button" id="resetBtn">Olvidé mi contraseña</button>
    </form>
    <div class="err" id="lErr">${esc(msg||'')}</div></section>`;
  const errMsg = e => ({'auth/invalid-credential':'Correo o contraseña incorrectos.','auth/popup-closed-by-user':'Se cerró la ventana de Google antes de terminar.','auth/unauthorized-domain':'Este dominio no está autorizado en Firebase (Authentication > Configuración > Dominios autorizados).','auth/too-many-requests':'Demasiados intentos. Espera unos minutos.'}[e.code] || 'No se pudo ingresar. Intenta de nuevo.');
  $('#gBtn').onclick = async () => { try{ await signInWithPopup(auth, new GoogleAuthProvider()); }catch(e){ console.error(e); $('#lErr').textContent=errMsg(e); } };
  $('#eForm').onsubmit = async e => { e.preventDefault(); const fd=new FormData(e.target);
    try{ await signInWithEmailAndPassword(auth, fd.get('email').trim(), fd.get('pass')); }catch(err){ console.error(err); $('#lErr').textContent=errMsg(err); } };
  $('#resetBtn').onclick = async () => { const em=$('#eForm').elements.email.value.trim();
    if(!em){ $('#lErr').textContent='Escribe tu correo primero.'; return; }
    try{ await sendPasswordResetEmail(auth, em); $('#lErr').textContent='Si el correo existe, te llegará un enlace para crear una nueva contraseña.'; }catch(e){ $('#lErr').textContent=errMsg(e); } };
}
function renderDenied(){
  $('#topbar').hidden = true;
  $('#app').innerHTML = `<section class="login"><h1>Sin acceso</h1>
    <p>La cuenta <b>${esc(S.user.email)}</b> aún no está habilitada. Pide al administrador que la agregue a la lista de permitidos.</p>
    <button class="btn" type="button" id="outBtn">Usar otra cuenta</button></section>`;
  $('#outBtn').onclick = () => signOut(auth);
}

/* =========================================================
   Render principal
   ========================================================= */
function render(){
  if(!S.user) return;
  $('#topbar').hidden = false;
  renderProjBar();
  const app = $('#app');
  if(!S.ready){ app.innerHTML='<p class="note">Cargando datos…</p>'; return; }
  if(!S.projects.length){
    app.innerHTML = `<section class="empty"><h2>Crea tu primer proyecto</h2>
      <p>Cada licitación adjudicada es un proyecto. Defines los documentos que pide el mandante, cargas la nómina y vas marcando lo que llega.</p>
      <button class="btn primary" type="button" data-act="newProject">Nuevo proyecto</button></section>`;
    return;
  }
  const p = curProject();
  if(!p){ S.current = S.projects[0].id; return render(); }
  const ws = projWorkers(p.id);
  const sems = ws.map(w=>({w, s:semaforo(w,p)}));
  const nV=sems.filter(x=>x.s.c==='v').length, nA=sems.filter(x=>x.s.c==='a').length, nR=sems.filter(x=>x.s.c==='r').length;

  let dl='';
  if(p.fecha){
    const days = Math.round((new Date(p.fecha+'T00:00:00') - new Date(today()+'T00:00:00'))/86400000);
    const cls = days<0?'late':days<=CFG.diasAvisoPlazo?'soon':'';
    const txt = days<0?`Vencido hace ${-days} d`:days===0?'Vence hoy':`${days} días`;
    dl = `<div class="deadline"><div class="d ${cls}">${txt}</div><small>para acreditar (${esc(fmtDate(p.fecha))})</small></div>`;
  }
  const strip = ws.length ? `<div class="strip" aria-hidden="true">${
      sems.slice().sort((a,b)=>b.s.rank-a.s.rank).map(x=>`<span class="${x.s.c}" title="${esc(x.w.nombre)}: ${esc(x.s.t)}"></span>`).join('')}</div>` : '';
  const folder = isUrl(p.carpeta) ? ` · <a class="folder" href="${esc(p.carpeta)}" target="_blank" rel="noopener">Abrir carpeta de documentos</a>` : '';

  const band = `<section class="band">
    <div class="band-head">
      <div><h1 class="pname">${esc(p.nombre)}</h1><div class="pmeta">${esc(p.mandante||'Sin mandante')} · ${p.docs.length} documentos por trabajador${folder}</div></div>
      ${dl}
    </div>
    ${ws.length ? `<div class="ready"><span class="n">${nV}</span><span class="of">de ${ws.length} trabajadores listos para acreditar</span></div>${strip}
    <div class="legend"><span><i class="dot v"></i><b>${nV}</b> listos</span><span><i class="dot a"></i><b>${nA}</b> en curso</span><span><i class="dot r"></i><b>${nR}</b> con observaciones o sin documentos</span></div>` : ''}
  </section>`;

  if(!ws.length){
    app.innerHTML = band + `<section class="empty"><h2>Carga la nómina</h2>
      <p>Pega las columnas RUT, nombre y cargo directamente desde Excel. Cada trabajador queda con sus ${p.docs.length} documentos en pendiente.</p>
      <button class="btn primary" type="button" data-act="import">Agregar trabajadores</button></section>`;
    return;
  }

  const q = S.q.trim().toLowerCase();
  let rows = sems.filter(x => S.filter==='todos' || x.s.c===S.filter);
  if(q) rows = rows.filter(x => (x.w.nombre+' '+x.w.rut+' '+(x.w.cargo||'')).toLowerCase().includes(q));
  rows.sort((a,b)=> a.s.rank-b.s.rank || a.w.nombre.localeCompare(b.w.nombre,'es'));

  const chip = (k,t,n) => `<button type="button" class="chip" data-act="filter" data-f="${k}" aria-pressed="${S.filter===k}">${t} (${n})</button>`;
  const tools = `<div class="tools">
    <div class="chips">${chip('todos','Todos',ws.length)}${chip('r','Con problemas',nR)}${chip('a','En curso',nA)}${chip('v','Listos',nV)}</div>
    <div class="row">
      <input type="search" id="q" placeholder="Buscar por nombre o RUT" value="${esc(S.q)}" aria-label="Buscar trabajador">
      <button class="btn" type="button" data-act="pend">Lista de pendientes</button>
      <button class="btn" type="button" data-act="import">Agregar trabajadores</button>
      <button class="btn" type="button" data-act="export">Exportar a Excel</button>
    </div></div>`;

  const heads = p.docs.map(d=>{
    const ap = ws.filter(w=>cellOf(w,d.key).estado==='aprobado').length;
    const pct = ws.length?Math.round(ap/ws.length*100):0;
    return `<th class="docth" scope="col">${esc(d.nombre)}<span class="cnt">${ap}/${ws.length} aprobados</span><div class="minibar"><i style="width:${pct}%"></i></div></th>`;
  }).join('');

  const body = rows.map(({w,s})=>{
    const badRut = !rutValido(w.rut);
    const cells = p.docs.map(d=>{
      const c = cellOf(w,d.key); const st = ESTADOS.find(e=>e.k===c.estado)||ESTADOS[0];
      return `<td><button type="button" class="cell s-${st.k}" data-act="cell" data-w="${w.id}" data-k="${esc(d.key)}" title="${esc(c.nota||st.t)}">
        <span class="ico" aria-hidden="true"></span><span>${st.t}</span>${isUrl(c.link)?'<span class="clip" aria-label="con archivo">📎</span>':''}</button></td>`;
    }).join('');
    return `<tr><td class="who"><button type="button" data-act="worker" data-w="${w.id}"><span class="nm">${esc(w.nombre)}</span>
      <span class="sub">${esc(w.rut)}${badRut?' <span class="warnrut">(RUT no válido)</span>':''}${w.cargo?' · '+esc(w.cargo):''}</span></button></td>
      ${cells}<td><div class="sem ${s.c}"><span class="lamp" aria-hidden="true"></span><span>${s.t}<small>${s.d}</small></span></div></td></tr>`;
  }).join('') || `<tr><td colspan="${p.docs.length+2}" class="note">Ningún trabajador coincide con el filtro.</td></tr>`;

  app.innerHTML = band + tools + `<div class="scroller"><table>
    <thead><tr><th scope="col">Trabajador</th>${heads}<th scope="col">Semáforo</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <p class="note">Toca una casilla para cambiar su estado, dejar una observación o pegar el link del escaneo.</p>`;

  const qi = $('#q');
  if(qi) qi.addEventListener('input', e=>{ S.q=e.target.value; const pos=e.target.selectionStart; render(); const n=$('#q'); n.focus(); n.setSelectionRange(pos,pos); });
}

function renderProjBar(){
  const bar = $('#projBar');
  const who = `<span class="userbox">${esc(S.user.email)}</span><button class="btn ghost" type="button" data-act="logout">Salir</button>`;
  if(!S.ready || !S.projects.length){ bar.innerHTML=who; return; }
  const opts = S.projects.slice().sort((a,b)=>(b.creado||'').localeCompare(a.creado||''))
    .map(p=>`<option value="${p.id}" ${p.id===S.current?'selected':''}>${esc(p.nombre)}</option>`).join('');
  bar.innerHTML = `<select id="projSel" aria-label="Proyecto">${opts}</select>
    <button class="btn" type="button" data-act="editProject">Editar</button>
    <button class="btn primary" type="button" data-act="newProject">Nuevo proyecto</button>${who}`;
  $('#projSel').onchange = e => { S.current=e.target.value; lsSet('cd-current',S.current); S.filter='todos'; S.q=''; render(); };
}

/* =========================================================
   Diálogo: proyecto
   ========================================================= */
function openProject(edit){
  const p = edit ? curProject() : null;
  const docs = p ? p.docs.map(d=>({...d})) : DOCS_DEFAULT.map((n,i)=>({key:'d'+(i+1), nombre:n}));
  const f = $('#formProject');
  const drawDocs = () => {
    $('#docList').innerHTML = docs.map((d,i)=>`<div class="r"><input type="text" value="${esc(d.nombre)}" data-i="${i}" aria-label="Documento ${i+1}" required>
      <button type="button" class="btn ghost" data-rm="${i}" aria-label="Quitar documento" ${docs.length<=1?'disabled':''}>Quitar</button></div>`).join('');
  };
  f.innerHTML = `<h3>${p?'Editar proyecto':'Nuevo proyecto'}</h3>
    <label class="f">Nombre de la licitación o servicio<input type="text" name="nombre" required value="${esc(p?.nombre||'')}" placeholder="Ej: Mantención planta"></label>
    <div class="grid2">
      <label class="f">Mandante<input type="text" name="mandante" value="${esc(p?.mandante||'')}" placeholder="Ej: nombre del cliente"></label>
      <label class="f">Fecha límite de acreditación<input type="date" name="fecha" value="${esc(p?.fecha||'')}"></label>
    </div>
    <label class="f">Carpeta de documentos (link de SharePoint o Drive, opcional)<input type="text" name="carpeta" inputmode="url" value="${esc(p?.carpeta||'')}" placeholder="https://…"></label>
    <div><div style="font-weight:500;margin-bottom:6px">Documentos que firma cada trabajador</div><div class="doclist" id="docList"></div>
      <button type="button" class="btn ghost" id="addDoc" style="margin-top:6px">+ Agregar documento</button></div>
    <div class="err" id="pErr"></div>
    <div class="acts">${p?'<button type="button" class="btn danger left" id="delProject">Eliminar proyecto</button>':''}
      <button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary">${p?'Guardar cambios':'Crear proyecto'}</button></div>`;
  drawDocs();
  $('#docList').oninput = e => { const i=e.target.dataset.i; if(i!==undefined) docs[i].nombre=e.target.value; };
  $('#docList').onclick = e => { const i=e.target.dataset.rm; if(i!==undefined){ docs.splice(+i,1); drawDocs(); } };
  $('#addDoc').onclick = () => { docs.push({key:uid('d'), nombre:''}); drawDocs(); $('#docList').lastElementChild.querySelector('input').focus(); };
  if(p) $('#delProject').onclick = async () => {
    if(!confirm(`¿Eliminar "${p.nombre}" y sus ${projWorkers(p.id).length} trabajadores? No se puede deshacer.`)) return;
    try{ await removeProject(p.id); $('#dlgProject').close(); toast('Proyecto eliminado'); }catch(e){ dbErr(e); }
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(f);
    const clean = docs.map(d=>({key:d.key, nombre:d.nombre.trim()})).filter(d=>d.nombre);
    if(!clean.length){ $('#pErr').textContent='Agrega al menos un documento.'; return; }
    const carpeta = fd.get('carpeta').trim();
    if(carpeta && !isUrl(carpeta)){ $('#pErr').textContent='El link de la carpeta debe comenzar con https://'; return; }
    const obj = { id: p?.id || uid('p'), nombre: fd.get('nombre').trim(), mandante: fd.get('mandante').trim(), fecha: fd.get('fecha')||'', carpeta, docs: clean, creado: p?.creado || new Date().toISOString() };
    try{ await putProject(obj); S.current=obj.id; lsSet('cd-current',obj.id); $('#dlgProject').close(); toast(p?'Cambios guardados':'Proyecto creado'); render(); }
    catch(err){ dbErr(err); }
  };
  $('#dlgProject').showModal();
}

/* =========================================================
   Diálogo: importar nómina
   ========================================================= */
function parseNomina(text, existentes){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const out=[]; let rep=0;
  const seen = new Set(existentes.map(w=>w.rut.replace(/[^0-9K]/gi,'').toUpperCase()));
  lines.forEach((l,i)=>{
    const sep = l.includes('\t')?'\t':l.includes(';')?';':',';
    const c = l.split(sep).map(x=>x.trim());
    if(i===0 && /rut/i.test(c[0])) return;
    if(!c[0] || !c[1]) return;
    const key = c[0].replace(/[^0-9K]/gi,'').toUpperCase();
    if(seen.has(key)){ rep++; return; }
    seen.add(key);
    out.push({rut:normRut(c[0]), nombre:c[1], cargo:c[2]||'', contacto:c[3]||''});
  });
  return {out, rep};
}
function openImport(){
  const p = curProject(); const f=$('#formImport');
  f.innerHTML = `<h3>Agregar trabajadores</h3><div class="sub">${esc(p.nombre)}</div>
    <label class="f">Pega desde Excel: RUT, Nombre, Cargo y (opcional) teléfono o correo
      <textarea name="txt" rows="8" placeholder="12.345.678-5	Juan Pérez Soto	Mecánico	+56 9 1234 5678"></textarea></label>
    <div class="hint" id="impPrev">Una fila por trabajador. Se omiten los RUT que ya están en el proyecto.</div>
    <div class="acts"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary" id="impGo" disabled>Agregar</button></div>`;
  const ta=f.elements.txt;
  ta.oninput = () => {
    const {out,rep}=parseNomina(ta.value, projWorkers(p.id));
    const inval = out.filter(r=>!rutValido(r.rut)).length;
    $('#impPrev').textContent = out.length ? `Se agregarán ${out.length} trabajadores${rep?`, ${rep} repetidos omitidos`:''}${inval?`. Ojo: ${inval} RUT no pasan la validación`:''}.` : 'Una fila por trabajador. Se omiten los RUT que ya están en el proyecto.';
    $('#impGo').disabled = !out.length;
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const {out}=parseNomina(ta.value, projWorkers(p.id));
    $('#impGo').disabled=true; $('#impGo').textContent='Agregando…';
    try{
      const b = writeBatch(db); const st = stamp();
      out.forEach(r => b.set(doc(db,'trabajadores',uid('w')), {proyectoId:p.id, ...r, docs:{}, creado:new Date().toISOString(), ...st}));
      await b.commit();
      $('#dlgImport').close(); toast(`${out.length} trabajadores agregados`);
    }catch(err){ dbErr(err); $('#impGo').disabled=false; $('#impGo').textContent='Agregar'; }
  };
  $('#dlgImport').showModal(); ta.focus();
}

/* =========================================================
   Diálogo: casilla (estado de un documento)
   ========================================================= */
function openCell(wid, key){
  const p=curProject(), w=S.workers.find(x=>x.id===wid), d=p.docs.find(x=>x.key===key);
  const c = cellOf(w,key); const f=$('#formCell');
  f.innerHTML = `<h3>${esc(d.nombre)}</h3><div class="sub">${esc(w.nombre)} · ${esc(w.rut)}</div>
    <div class="states" role="radiogroup" aria-label="Estado">${ESTADOS.map(e=>`<label><input type="radio" name="estado" value="${e.k}" ${c.estado===e.k?'checked':''}>
      <span class="cell s-${e.k}"><span class="ico" aria-hidden="true"></span><span>${e.t}</span></span></label>`).join('')}</div>
    <label class="f">Observación<textarea name="nota" rows="2" placeholder="Ej: falta firma en la página 2">${esc(c.nota||'')}</textarea></label>
    <label class="f">Link del escaneo (SharePoint, Drive u otro)<input type="text" name="link" inputmode="url" value="${esc(c.link||'')}" placeholder="https://…"></label>
    ${isUrl(c.link)?`<div class="attach"><a href="${esc(c.link)}" target="_blank" rel="noopener">Abrir escaneo</a></div>`:''}
    ${c.fecha?`<div class="hint">Último cambio: ${esc(fmtDate(c.fecha))}${c.por?` por ${esc(c.por)}`:''}</div>`:''}
    <div class="err" id="cErr"></div>
    <div class="acts"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary" id="cGo">Guardar</button></div>`;
  f.onsubmit = async e => {
    e.preventDefault();
    const fd=new FormData(f); let estado=fd.get('estado'); const nota=(fd.get('nota')||'').trim(); const link=(fd.get('link')||'').trim();
    if(link && !isUrl(link)){ $('#cErr').textContent='El link debe comenzar con https://'; return; }
    if(link && estado==='pendiente') estado='recibido';
    $('#cGo').disabled=true;
    try{ await patchCell(wid,key,{estado, nota, link, fecha:today()}); $('#dlgCell').close(); toast('Guardado'); }
    catch(err){ $('#cGo').disabled=false; dbErr(err); }
  };
  $('#dlgCell').showModal();
}

/* =========================================================
   Diálogo: trabajador
   ========================================================= */
function openWorker(wid){
  const w=S.workers.find(x=>x.id===wid); const f=$('#formWorker');
  f.innerHTML = `<h3>Datos del trabajador</h3>
    <div class="grid2"><label class="f">RUT<input type="text" name="rut" required value="${esc(w.rut)}"></label>
      <label class="f">Cargo<input type="text" name="cargo" value="${esc(w.cargo||'')}"></label></div>
    <label class="f">Nombre completo<input type="text" name="nombre" required value="${esc(w.nombre)}"></label>
    <label class="f">Teléfono o correo<input type="text" name="contacto" value="${esc(w.contacto||'')}"></label>
    <div class="acts"><button type="button" class="btn danger left" id="delW">Quitar del proyecto</button>
      <button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary">Guardar cambios</button></div>`;
  $('#delW').onclick = async () => { if(!confirm(`¿Quitar a ${w.nombre} del proyecto?`)) return; try{ await removeWorker(w.id); $('#dlgWorker').close(); toast('Trabajador quitado'); }catch(e){ dbErr(e); } };
  f.onsubmit = async e => {
    e.preventDefault(); const fd=new FormData(f);
    try{ await updateDoc(doc(db,'trabajadores',w.id), {rut:normRut(fd.get('rut')), nombre:fd.get('nombre').trim(), cargo:fd.get('cargo').trim(), contacto:fd.get('contacto').trim(), ...stamp()});
      $('#dlgWorker').close(); toast('Cambios guardados'); }
    catch(err){ dbErr(err); }
  };
  $('#dlgWorker').showModal();
}

/* =========================================================
   Lista de pendientes (para WhatsApp o correo)
   ========================================================= */
function openPend(){
  const p=curProject(); const ws=projWorkers(p.id).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
  const lines=[];
  ws.forEach(w=>{
    const falt = p.docs.map(d=>({d, c:cellOf(w,d.key)})).filter(x=>x.c.estado==='pendiente'||x.c.estado==='observado');
    if(falt.length) lines.push(`• ${w.nombre}: ${falt.map(x=>x.d.nombre + (x.c.estado==='observado'?` (corregir${x.c.nota?': '+x.c.nota:''})`:'')).join(', ')}`);
  });
  const txt = lines.length ? `Documentos pendientes · ${p.nombre}${p.fecha?` · plazo ${fmtDate(p.fecha)}`:''}\n\n${lines.join('\n')}` : 'Nadie tiene documentos pendientes ni observados.';
  const f=$('#formPend');
  f.innerHTML = `<h3>Lista de pendientes</h3><div class="sub">Incluye documentos pendientes y observados. Los recibidos por revisar no aparecen.</div>
    <textarea rows="12" id="pendTxt" readonly>${esc(txt)}</textarea>
    <div class="acts"><button type="button" class="btn" data-close>Cerrar</button><button type="button" class="btn primary" id="copyPend">Copiar texto</button></div>`;
  $('#copyPend').onclick = async () => {
    const ta=$('#pendTxt');
    try{ await navigator.clipboard.writeText(ta.value); toast('Texto copiado'); }
    catch(e){ ta.focus(); ta.select(); toast('Texto seleccionado: cópialo con Ctrl+C'); }
  };
  $('#dlgPend').showModal();
}

/* =========================================================
   Exportar a CSV (se abre en Excel)
   ========================================================= */
function exportCsv(){
  const p=curProject(); const ws=projWorkers(p.id);
  const q = v => `"${String(v??'').replace(/"/g,'""')}"`;
  const head = ['RUT','Nombre','Cargo','Contacto', ...p.docs.flatMap(d=>[d.nombre, d.nombre+' (link)']), 'Semáforo','Detalle'];
  const rows = ws.map(w=>{ const s=semaforo(w,p);
    return [w.rut,w.nombre,w.cargo,w.contacto, ...p.docs.flatMap(d=>{const c=cellOf(w,d.key); return [(ESTADOS.find(e=>e.k===c.estado)||ESTADOS[0]).t + (c.nota?` (${c.nota})`:''), c.link||''];}), s.t, s.d]; });
  const csv = '\ufeff' + [head,...rows].map(r=>r.map(q).join(';')).join('\r\n');
  const slug = p.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download = `control-documental-${slug||'proyecto'}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

/* =========================================================
   Eventos
   ========================================================= */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-close]'); if(!t) return;
  if(t.hasAttribute('data-close')){ t.closest('dialog').close(); return; }
  const a=t.dataset.act;
  if(a==='newProject') openProject(false);
  else if(a==='editProject') openProject(true);
  else if(a==='import') openImport();
  else if(a==='cell') openCell(t.dataset.w, t.dataset.k);
  else if(a==='worker') openWorker(t.dataset.w);
  else if(a==='filter'){ S.filter=t.dataset.f; render(); }
  else if(a==='pend') openPend();
  else if(a==='export') exportCsv();
  else if(a==='logout') signOut(auth);
});

/* =========================================================
   Arranque
   ========================================================= */
function stopSubs(){ unsubs.forEach(u=>u()); unsubs=[]; }
function subscribe(){
  let gotP=false, gotW=false;
  const done = () => { if(gotP && gotW){ S.ready=true; render(); } };
  const onErr = err => { console.error(err); $('#banner').innerHTML = `<div class="banner">No se pudieron leer los datos (${esc(err.code||'error')}). Revisa las reglas de Firestore y la lista de permitidos.</div>`; };
  unsubs.push(onSnapshot(collection(db,'proyectos'), snap=>{ S.projects=snap.docs.map(x=>({id:x.id, ...x.data()})); gotP=true; done(); }, onErr));
  unsubs.push(onSnapshot(collection(db,'trabajadores'), snap=>{ S.workers=snap.docs.map(x=>({id:x.id, ...x.data()})); gotW=true; done(); }, onErr));
}

document.title = CFG.nombreApp;
$('#brandName').textContent = CFG.nombreApp;

if(String(firebaseConfig.apiKey).startsWith('PEGAR')){ renderSetup(); }
else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app); db = getFirestore(app);
  onAuthStateChanged(auth, async user => {
    stopSubs(); S.ready=false; S.projects=[]; S.workers=[];
    S.user = user;
    if(!user){ renderLogin(); return; }
    // ¿Está el correo en la lista de permitidos?
    try{
      const ok = await getDoc(doc(db,'permitidos', (user.email||'').toLowerCase()));
      if(!ok.exists()){ renderDenied(); return; }
    }catch(e){ console.error(e); renderDenied(); return; }
    S.current = lsGet('cd-current', null);
    render(); subscribe();
  });
}
