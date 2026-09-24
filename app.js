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
      <p>Sube un Excel con las columnas RUT, Nombre y Cargo. Cada trabajador queda con sus ${p.docs.length} documentos en pendiente.</p>
      <button class="btn primary" type="button" data-act="import">Cargar trabajadores</button></section>`;
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
   Carga masiva de trabajadores (Excel, CSV o pegar)
   ========================================================= */

/* El lector de Excel (SheetJS) se descarga solo cuando se usa */
function cargarLectorExcel(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error('No se pudo cargar el lector de Excel'));
    document.head.appendChild(s);
  });
}

/* Quita mayúsculas y tildes para comparar encabezados: "Teléfono" -> "telefono" */
const normTxt = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();

/* Busca las columnas por su encabezado, sin importar el orden en el Excel */
function mapearColumnas(encabezado){
  const h = encabezado.map(normTxt);
  const buscar = prueba => h.findIndex(prueba);
  const iRut  = buscar(x => x.includes('rut') || x === 'run');
  const iNom  = buscar(x => (x.startsWith('nombre') && x !== 'nombres') || x === 'trabajador');
  const iNoms = buscar(x => x === 'nombres');
  const iApes = h.map((x,i) => x.includes('apellido') ? i : -1).filter(i => i >= 0);
  const iCar  = buscar(x => x.includes('cargo'));
  const iCon  = buscar(x => ['contacto','telefono','celular','correo','email','mail'].some(t => x.includes(t)));
  return {iRut, iNom, iNoms, iApes, iCar, iCon, ok: iRut >= 0 && (iNom >= 0 || iNoms >= 0)};
}

/* Convierte filas del Excel en trabajadores listos para guardar */
function procesarFilas(filas, existentes){
  filas = filas.map(r => r.map(c => String(c ?? '').trim())).filter(r => r.some(Boolean));
  if(!filas.length) return {out:[], rep:0, incompletas:0, inval:0, conEncabezado:false};
  let map = mapearColumnas(filas[0]); let datos;
  if(map.ok) datos = filas.slice(1);
  else { map = {iRut:0, iNom:1, iNoms:-1, iApes:[], iCar:2, iCon:3}; datos = filas; } // sin encabezado: orden RUT, Nombre, Cargo, Contacto
  const vistos = new Set(existentes.map(w => w.rut.replace(/[^0-9K]/gi,'').toUpperCase()));
  const out = []; let rep = 0, incompletas = 0;
  for(const r of datos){
    const rut = r[map.iRut] || '';
    let nombre = map.iNom >= 0 ? r[map.iNom] : [r[map.iNoms], ...map.iApes.map(i => r[i])].filter(Boolean).join(' ');
    nombre = (nombre || '').replace(/\s+/g,' ').trim();
    if(!/\d/.test(rut) || !nombre){ incompletas++; continue; }
    const clave = rut.replace(/[^0-9K]/gi,'').toUpperCase();
    if(vistos.has(clave)){ rep++; continue; }
    vistos.add(clave);
    out.push({rut: normRut(rut), nombre, cargo: map.iCar >= 0 ? (r[map.iCar] || '') : '', contacto: map.iCon >= 0 ? (r[map.iCon] || '') : ''});
  }
  return {out, rep, incompletas, inval: out.filter(x => !rutValido(x.rut)).length, conEncabezado: map.ok};
}

/* Texto pegado o CSV -> filas */
function textoAFilas(texto){
  return texto.split(/\r?\n/).filter(l => l.trim()).map(l => {
    const sep = l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',';
    return l.split(sep).map(c => c.replace(/^"|"$/g,'').trim());
  });
}

/* Lee la primera hoja de un Excel, o un CSV */
async function leerArchivo(file){
  const nombre = file.name.toLowerCase();
  if(nombre.endsWith('.csv')){
    const buf = await file.arrayBuffer();
    let txt = new TextDecoder('utf-8').decode(buf);
    if(txt.includes('\uFFFD')) txt = new TextDecoder('windows-1252').decode(buf); // CSV guardado desde Excel en Windows
    return textoAFilas(txt);
  }
  const XLSX = await cargarLectorExcel();
  const wb = XLSX.read(await file.arrayBuffer(), {type:'array'});
  const hoja = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(hoja, {header:1, raw:false, defval:''});
}

async function descargarPlantilla(){
  try{
    const XLSX = await cargarLectorExcel();
    const hoja = XLSX.utils.aoa_to_sheet([
      ['RUT','Nombre','Cargo','Contacto'],
      ['12.345.678-5','Juan Pérez Soto','Mecánico','+56 9 1234 5678']
    ]);
    hoja['!cols'] = [{wch:14},{wch:30},{wch:20},{wch:22}];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, hoja, 'Trabajadores');
    XLSX.writeFile(wb, 'plantilla-trabajadores.xlsx');
  }catch(e){ console.error(e); toast('No se pudo generar la plantilla.'); }
}

function openImport(){
  const p = curProject(); const f = $('#formImport');
  let resultado = null;
  f.innerHTML = `<h3>Cargar trabajadores</h3><div class="sub">${esc(p.nombre)}</div>
    <div class="drop" id="drop">
      <p><b>Arrastra aquí tu Excel</b> o</p>
      <label class="btn primary">Elegir archivo<input type="file" id="fileIn" accept=".xlsx,.xls,.csv" class="sr"></label>
      <p class="hint">Columnas: RUT, Nombre, Cargo y Contacto (opcional). Se lee la primera hoja.</p>
    </div>
    <div class="row">
      <button type="button" class="btn ghost" id="plantilla">Descargar plantilla Excel</button>
      <button type="button" class="btn ghost" id="togglePaste">Prefiero pegar desde Excel</button>
    </div>
    <div id="pasteBox" hidden><textarea rows="6" id="pasteTxt" placeholder="12.345.678-5	Juan Pérez Soto	Mecánico	+56 9 1234 5678"></textarea></div>
    <div id="preview"></div>
    <div class="err" id="iErr"></div>
    <div class="acts"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary" id="impGo" disabled>Agregar</button></div>`;

  const mostrar = (filas, origen) => {
    $('#iErr').textContent = '';
    resultado = procesarFilas(filas, projWorkers(p.id));
    const r = resultado;
    if(!r.out.length){
      $('#preview').innerHTML = '';
      $('#iErr').textContent = r.rep ? `Todos los trabajadores de ${origen} ya están en el proyecto.` : `No se encontraron trabajadores en ${origen}. Revisa que tenga las columnas RUT y Nombre.`;
      $('#impGo').disabled = true; return;
    }
    const extras = [r.rep && `${r.rep} ya estaban en el proyecto`, r.incompletas && `${r.incompletas} filas sin RUT o nombre`].filter(Boolean);
    const muestra = r.out.slice(0,8).map(x => `<tr><td>${esc(x.rut)}${rutValido(x.rut)?'':' <span class="warnrut">(no válido)</span>'}</td><td>${esc(x.nombre)}</td><td>${esc(x.cargo)}</td><td>${esc(x.contacto)}</td></tr>`).join('');
    $('#preview').innerHTML = `<p class="sum">Se agregarán <b>${r.out.length}</b> trabajadores${extras.length?` (se omiten ${extras.join(' y ')})`:''}.
      ${r.inval?`<span class="warnrut">${r.inval} RUT no pasan la validación; revísalos después de cargar.</span>`:''}</p>
      <div class="prev"><table><thead><tr><th>RUT</th><th>Nombre</th><th>Cargo</th><th>Contacto</th></tr></thead><tbody>${muestra}</tbody></table></div>
      ${r.out.length>8?`<p class="hint">…y ${r.out.length-8} más.</p>`:''}
      ${r.conEncabezado?'':'<p class="hint">No se encontraron encabezados: se asumió el orden RUT, Nombre, Cargo, Contacto.</p>'}`;
    $('#impGo').disabled = false; $('#impGo').textContent = `Agregar ${r.out.length}`;
  };

  const usarArchivo = async file => {
    if(!file) return;
    if(!/\.(xlsx|xls|csv)$/i.test(file.name)){ $('#iErr').textContent='Usa un archivo .xlsx, .xls o .csv.'; return; }
    $('#preview').innerHTML = '<p class="hint">Leyendo archivo…</p>';
    try{ mostrar(await leerArchivo(file), `"${file.name}"`); }
    catch(e){ console.error(e); $('#preview').innerHTML=''; $('#iErr').textContent='No se pudo leer el archivo. Revisa que no esté protegido con contraseña.'; }
  };

  $('#fileIn').onchange = e => usarArchivo(e.target.files[0]);
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); usarArchivo(e.dataTransfer.files[0]); };
  $('#plantilla').onclick = descargarPlantilla;
  $('#togglePaste').onclick = () => { const b=$('#pasteBox'); b.hidden=!b.hidden; if(!b.hidden) $('#pasteTxt').focus(); };
  $('#pasteTxt').oninput = e => e.target.value.trim() ? mostrar(textoAFilas(e.target.value), 'el texto pegado') : ($('#preview').innerHTML='', $('#impGo').disabled=true);

  f.onsubmit = async e => {
    e.preventDefault();
    if(!resultado || !resultado.out.length) return;
    const lista = resultado.out; const btn = $('#impGo'); btn.disabled = true;
    try{
      // Firestore acepta hasta 500 operaciones por lote: se guardan en grupos de 400
      for(let i=0; i<lista.length; i+=400){
        btn.textContent = `Guardando ${Math.min(i+400, lista.length)} de ${lista.length}…`;
        const b = writeBatch(db); const st = stamp();
        lista.slice(i, i+400).forEach(r => b.set(doc(db,'trabajadores',uid('w')), {proyectoId:p.id, ...r, docs:{}, creado:new Date().toISOString(), ...st}));
        await b.commit();
      }
      $('#dlgImport').close(); toast(`${lista.length} trabajadores agregados`);
    }catch(err){ dbErr(err); btn.disabled=false; btn.textContent=`Agregar ${lista.length}`; }
  };
  $('#dlgImport').showModal();
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
