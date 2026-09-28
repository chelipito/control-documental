/* =========================================================
   Funciones de apoyo: no tocan la página ni Firebase.
   Aquí están el formato de RUT, fechas y el cálculo del semáforo.
   ========================================================= */

/* Evita que un texto rompa el HTML (por ejemplo, un nombre con < o comillas) */
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* Genera un identificador único, por ejemplo "p1a2b3..." */
export const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* Fecha de hoy en formato AAAA-MM-DD */
export const today = () => new Date().toISOString().slice(0,10);

/* Convierte AAAA-MM-DD en DD-MM-AAAA */
export function fmtDate(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}-${m}-${y}`; }

/* ¿Es un link válido (https)? */
export const isUrl = v => /^https:\/\/\S+$/i.test(String(v||'').trim());

/* Guardar y leer preferencias simples en este navegador */
export function lsGet(k, d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch(e){ return d; } }
export function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }

/* RUT chileno: da formato 12.345.678-5 */
export function normRut(r){
  const c = String(r||'').replace(/[^0-9kK]/g,'').toUpperCase();
  if(c.length<2) return String(r||'').trim();
  return c.slice(0,-1).replace(/\B(?=(\d{3})+(?!\d))/g,'.') + '-' + c.slice(-1);
}

/* RUT chileno: valida el dígito verificador (módulo 11) */
export function rutValido(r){
  const c = String(r||'').replace(/[^0-9kK]/g,'').toUpperCase();
  if(c.length<2) return false;
  const body=c.slice(0,-1), dv=c.slice(-1);
  let s=0, m=2;
  for(let i=body.length-1;i>=0;i--){ s+= +body[i]*m; m = m===7?2:m+1; }
  const r11 = 11-(s%11), exp = r11===11?'0':r11===10?'K':String(r11);
  return exp===dv;
}

/* Estado de un documento de un trabajador (si no existe, está pendiente) */
export const cellOf = (w,k) => (w.docs && w.docs[k]) || {estado:'pendiente'};

/* Semáforo por trabajador
   verde:    todos los documentos aprobados
   rojo:     algún documento observado, o ninguno entregado
   amarillo: todo lo demás (en curso) */
export function semaforo(w, p){
  const cells = p.docs.map(d => cellOf(w,d.key));
  const tot=cells.length;
  const ap=cells.filter(c=>c.estado==='aprobado').length;
  const ob=cells.filter(c=>c.estado==='observado').length;
  const rc=cells.filter(c=>c.estado==='recibido').length;
  if(tot>0 && ap===tot) return {c:'v', t:'Listo', d:`${ap}/${tot} aprobados`, rank:2};
  if(ob>0) return {c:'r', t:'Con observaciones', d:`${ob} observado${ob>1?'s':''}`, rank:0};
  if(ap+rc===0) return {c:'r', t:'Sin documentos', d:`0/${tot} recibidos`, rank:0};
  return {c:'a', t:'En curso', d:`${ap}/${tot} aprobados${rc?`, ${rc} por revisar`:''}`, rank:1};
}
