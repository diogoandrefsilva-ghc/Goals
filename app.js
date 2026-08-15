const CORES=['#045c40','#1a237e','#4a148c','#b71c1c','#e65100','#006064','#33691e','#880e4f','#1565c0','#37474f','#f57f17','#3e2723','#004d40','#311b92','#bf360c'];

/* ── SESSÃO SUPABASE (mesmo projeto do FestasBV, schema `goals`) ───────────
   O padrão é o mesmo do FestasBV: sessão em localStorage, refresh automático
   do access token (expira em ~1h), Accept/Content-Profile a escolher o
   schema — NUNCA no URL. */
const SB_URL='https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const ADMIN_EMAIL='diogo.andre.f.silva@gmail.com';
const SESSION_KEY='goals_sb_session';
let _sbSession=null;
let MEU_AMIGO_NOME=null; // nome do amigo (goals.user_amigos) ligado a este login, se algum
let PUSH_COL=true; // tabela push_subscriptions existe? (verificado em pushCheckColuna, chamado por sbAposLogin)

// Par de chaves para notificações Web Push (não é a chave do Supabase) —
// o MESMO par já usado pelo SplitBill: os secrets de Edge Function no
// Supabase são por PROJETO, não por function, e este app vive no mesmo
// projeto. A privada vive só como secret do projeto (VAPID_PRIVATE_KEY),
// partilhada por todas as functions, nunca no repo.
const VAPID_PUBLIC_KEY='BFiwf_z5NJzkXFP6gzxS_naH9cNC2MfCEmejJf32MID8Y_1i49cb8sGINYhH-aFAZmFQLf3V__2ZyeotQIZYQ0U';

function sbHeaders(extra={}){
  return Object.assign({
    'Content-Type':'application/json',
    'apikey':SB_KEY,
    'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`,
    'Accept-Profile':'goals',
    'Content-Profile':'goals'
  },extra);
}
function sbSaveSession(s){
  _sbSession=s;
  localStorage.setItem(SESSION_KEY,JSON.stringify(s));
}
let _refreshing=null;
async function sbRefresh(){
  if(!_sbSession||!_sbSession.refresh_token)return false;
  if(_refreshing)return _refreshing;
  _refreshing=(async()=>{
    try{
      const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
        method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:_sbSession.refresh_token})
      });
      if(!r.ok)return false;
      const d=await r.json();
      sbSaveSession({
        access_token:d.access_token,
        refresh_token:d.refresh_token||_sbSession.refresh_token,
        expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
        user:d.user||_sbSession.user
      });
      return true;
    }catch(e){return false;}
  })();
  const ok=await _refreshing;
  _refreshing=null;
  return ok;
}
function tokenQuaseExpirado(){
  if(!_sbSession)return false;
  if(!_sbSession.expires_at)return true;
  return (_sbSession.expires_at-Date.now()/1000)<120;
}
async function sbEnsureFresh(){
  if(_sbSession&&_sbSession.refresh_token&&tokenQuaseExpirado())await sbRefresh();
}
async function sbFetch(url,opt){
  await sbEnsureFresh();
  opt=opt||{};
  opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`});
  let r=await fetch(url,opt);
  if(r.status===401&&_sbSession&&_sbSession.refresh_token){
    if(await sbRefresh()){
      opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession.access_token}`});
      r=await fetch(url,opt);
    }
  }
  return r;
}
// Uniformiza as chaves de um array antes de um POST em lote — o PostgREST
// recusa objetos com colunas diferentes na mesma inserção (mesmo padrão do
// FestasBV, usado pela migração e por criarNovaEpoca a copiar amigos).
function sbRowsUniformes(rows){
  const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
  if(!Array.isArray(rows)||rows.length<2||!rows.every(plain))return rows;
  const keys=[];rows.forEach(r=>Object.keys(r).forEach(k=>{if(!keys.includes(k))keys.push(k);}));
  if(rows.every(r=>Object.keys(r).length===keys.length))return rows;
  return rows.map(r=>{const o={};keys.forEach(k=>o[k]=r[k]!==undefined?r[k]:null);return o;});
}
async function sbReq(method,path,body,extra){
  const opt={method,headers:sbHeaders(extra||{})};
  if(method==='POST')body=sbRowsUniformes(body);
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await sbFetch(`${SB_URL}/rest/v1/${path}`,opt);
  if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();m=j.message||m;}catch(_){}throw new Error(m);}
  const tx=await r.text();
  return tx?JSON.parse(tx):null;
}

/* ── READ-ONLY CHECK (agora é "não és admin", não "sem token") ────────── */
let isReadOnly=true;
function isAdmin(){return !!(_sbSession&&_sbSession.user&&_sbSession.user.email===ADMIN_EMAIL);}
function checkReadOnly(){
  isReadOnly=!isAdmin();
  document.body.classList.toggle('readonly',isReadOnly);
}
function roGuard(action){
  if(!isReadOnly)return false;
  toast('🔒 Só o admin pode editar isto',1);
  return true;
}

/* ── DB ─────────────────────────────────────── */
// Multi-época: dbFull.epocas é montado a partir do Supabase em carregar().
// A FORMA fica igual à de sempre (era o JSON, é agora a mesma estrutura em
// memória) — só a origem dos dados e a escrita (por linha, não em bloco) mudam.
let dbFull={config:{valorPorGolo:1,epocaAtiva:'2025/26'},epocas:{}};
// db é o "atalho" para a época activa (amigos, jogos, pagosPorJogo)
let db={amigos:[],jogos:[],pagosPorJogo:{},estouros:[],estouroPagos:[],creditosExtra:[],poteHolder:null,pedidosPagamento:[]};
let epocaAtiva='2025/26';
const epocasOrdem=['2024/25','2025/26']; // ordem cronológica

// Carrega TODAS as épocas do schema `goals` de uma vez (dataset pequeno —
// não há razão para paginar por época) e remonta a mesma forma que o `db`
// sempre teve. Chamado depois do login (sbAposLogin) e depois da migração.
async function carregar(){
  const [epocasRows,amigosRows,jogosRows,pagosRows,estRows,estPartRows,estPagRows,credRows,cfgRows,pedPagRows]=await Promise.all([
    sbReq('GET','epocas?select=*'),
    sbReq('GET','amigos?select=*&order=epoca_nome.asc,ordem.asc,id.asc'),
    sbReq('GET','jogos?select=*&order=data.asc,id.asc'),
    sbReq('GET','pagos_jogo?select=*'),
    sbReq('GET','estouros?select=*'),
    sbReq('GET','estouro_participantes?select=*'),
    sbReq('GET','estouro_pagos?select=*'),
    sbReq('GET','creditos_extra?select=*'),
    sbReq('GET','config?select=*'),
    sbReq('GET','pedidos_pagamento?select=*&order=criado_em.desc')
  ]);

  const cfgMap={};(cfgRows||[]).forEach(c=>cfgMap[c.chave]=c.valor);
  dbFull={config:{valorPorGolo:parseFloat(cfgMap.valor_por_golo)||1,epocaAtiva},epocas:{}};

  (epocasRows||[]).forEach(e=>{
    dbFull.epocas[e.nome]={amigos:[],jogos:[],pagosPorJogo:{},estouros:[],estouroPagos:[],creditosExtra:[],poteHolder:e.pote_holder_amigo_id||null,pedidosPagamento:[]};
  });
  (amigosRows||[]).forEach(a=>{
    const ep=dbFull.epocas[a.epoca_nome];if(!ep)return;
    ep.amigos.push({id:a.id,nome:a.nome,cor:a.cor});
  });
  (jogosRows||[]).forEach(j=>{
    const ep=dbFull.epocas[j.epoca_nome];if(!ep)return;
    ep.jogos.push({id:j.id,data:j.data,adversario:j.adversario,competicao:j.competicao,jornada:j.jornada,local:j.local,golos:j.golos,resultado:j.resultado});
  });
  const jogoEpoca={};(jogosRows||[]).forEach(j=>jogoEpoca[j.id]=j.epoca_nome);
  (pagosRows||[]).forEach(p=>{
    const ep=dbFull.epocas[jogoEpoca[p.jogo_id]];if(!ep)return;
    const k=String(p.jogo_id);
    if(!ep.pagosPorJogo[k])ep.pagosPorJogo[k]=[];
    ep.pagosPorJogo[k].push(p.amigo_id);
  });
  (estRows||[]).forEach(e=>{
    const ep=dbFull.epocas[e.epoca_nome];if(!ep)return;
    ep.estouros.push({id:e.id,nome:e.nome,data:e.data,valor:Number(e.valor)||0,pagoPor:e.pago_por,participantes:[]});
  });
  const estouroEpoca={};(estRows||[]).forEach(e=>estouroEpoca[e.id]=e.epoca_nome);
  (estPartRows||[]).forEach(p=>{
    const ep=dbFull.epocas[estouroEpoca[p.estouro_id]];if(!ep)return;
    const ev=ep.estouros.find(e=>e.id===p.estouro_id);if(!ev)return;
    ev.participantes.push(p.amigo_id);
  });
  const amigoEpoca={};(amigosRows||[]).forEach(a=>amigoEpoca[a.id]=a.epoca_nome);
  (estPagRows||[]).forEach(p=>{
    const ep=dbFull.epocas[amigoEpoca[p.amigo_id]];if(!ep)return;
    ep.estouroPagos.push(p.amigo_id);
  });
  (credRows||[]).forEach(c=>{
    const ep=dbFull.epocas[c.epoca_nome];if(!ep)return;
    ep.creditosExtra.push({id:c.id,valor:Number(c.valor)||0,nome:c.nome,data:c.data});
  });
  (pedPagRows||[]).forEach(p=>{
    const ep=dbFull.epocas[p.epoca_nome];if(!ep)return;
    ep.pedidosPagamento.push({id:p.id,amigoId:p.amigo_id,jogoIds:p.jogo_ids||[],valor:Number(p.valor)||0,nota:p.nota,estado:p.estado,criadoPorEmail:p.criado_por_email,criadoEm:p.criado_em,decididoPor:p.decidido_por,decididoEm:p.decidido_em,motivo:p.motivo});
  });

  actualizarEpocasOrdem();
  epocaAtiva=epocaInicial();
  dbFull.config.epocaAtiva=epocaAtiva;
  sincEpoca();
}
function actualizarEpocasOrdem(){
  // Reconstruir a lista ordenada das épocas existentes
  const eps=Object.keys(dbFull.epocas||{});
  eps.sort(); // lexicographic: '2024/25' < '2025/26'
  // Garantir que epocasOrdem reflecte as épocas reais
  epocasOrdem.length=0;
  eps.forEach(e=>epocasOrdem.push(e));
  if(!epocasOrdem.length)epocasOrdem.push('2025/26');
}
// Estado de navegação persistido (sobrevive ao reload do PWA no iOS)
function epocaInicial(){
  let s=null;try{s=localStorage.getItem('sg_epoca');}catch(e){}
  if(s&&epocasOrdem.includes(s))return s;
  return epocasOrdem.length?epocasOrdem[epocasOrdem.length-1]:(dbFull.config.epocaAtiva||'2025/26');
}
function restaurarTab(){
  let t=null;try{t=localStorage.getItem('sg_tab');}catch(e){}
  const valid=['resumo','contas','previsao','jogos','estouro','cfg'];
  if(!valid.includes(t)||t==='resumo')return; // resumo é o default já renderizado
  const btn=[...document.querySelectorAll('#s-dash > .itabs .it')].find(b=>(b.getAttribute('onclick')||'').includes("itab('"+t+"'"));
  if(btn)itab(t,btn,'dash');
}
function sincEpoca(){
  try{localStorage.setItem('sg_epoca',epocaAtiva);}catch(e){}
  const ep=dbFull.epocas[epocaAtiva]||{amigos:[],jogos:[],pagosPorJogo:{},estouros:[]};
  db.amigos=ep.amigos||[];
  db.jogos=ep.jogos||[];
  db.pagosPorJogo=ep.pagosPorJogo||{};
  db.estouros=ep.estouros||[];
  db.estouroPagos=ep.estouroPagos||[];
  db.creditosExtra=ep.creditosExtra||[];
  db.poteHolder=ep.poteHolder||null;
  db.pedidosPagamento=ep.pedidosPagamento||[];
  db.jogos.forEach(j=>{if(j.golos===undefined)j.golos=null;});
  // actualizar config global para retrocompatibilidade de funções que usam db.config
  db.config={valorPorGolo:dbFull.config.valorPorGolo||1,epoca:epocaAtiva};
}

/* ── ÉPOCA NAV ───────────────────────────────── */
function atualizarLabelEpoca(){
  document.getElementById('epoca-label').textContent=`Época ${epocaAtiva}`;
  document.getElementById('epoca-prev').style.opacity=epocasOrdem.indexOf(epocaAtiva)<=0?'0.3':'1';
  document.getElementById('epoca-next').style.opacity=epocasOrdem.indexOf(epocaAtiva)>=epocasOrdem.length-1?'0.3':'1';
}
function mudarEpoca(dir){
  actualizarEpocasOrdem();
  const idx=epocasOrdem.indexOf(epocaAtiva);
  const nIdx=idx+dir;
  if(nIdx<0||nIdx>=epocasOrdem.length)return;
  epocaAtiva=epocasOrdem[nIdx];
  dbFull.config.epocaAtiva=epocaAtiva;
  sincEpoca();
  atualizarLabelEpoca();
  // As épocas já vêm todas carregadas do Supabase — mudar de época é só
  // trocar o ponteiro local, não há nada para escrever.
  rDash();
  // forçar re-render da secção activa
  const activeItab=document.querySelector('#s-dash .tp.on');
  if(activeItab){
    const id=activeItab.id.replace('t-','');
    const fn={resumo:rResumo,contas:rContas,previsao:rPrevisao,jogos:rJogos,estouro:rEstouro,cfg:rCfg};
    fn[id]?.();
  }
}

/* ── CÁLCULOS ────────────────────────────────── */
function gJ(j){return j.golos!==null&&j.golos!==undefined&&j.golos!==''?Number(j.golos):0;}
function totalGolos(){return db.jogos.reduce((a,j)=>a+gJ(j),0);}
function ini(n){return(n||'?').trim().split(/\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,2)||'?';}

// Quanto cada amigo deve NO TOTAL (todos os jogos com golos > 0)
function deveTotal(){return totalGolos()*db.config.valorPorGolo;}

// Quanto um amigo pagou (soma dos golos dos jogos onde está marcado como pago)
function pagouAmigo(amigoId){
  return db.jogos.reduce((acc,j)=>{
    const pag=db.pagosPorJogo[String(j.id)]||[];
    return acc+(pag.includes(amigoId)?gJ(j)*db.config.valorPorGolo:0);
  },0);
}

function dividaAmigo(amigoId){return deveTotal()-pagouAmigo(amigoId);}
function totalDividas(){return db.amigos.reduce((a,am)=>a+Math.max(0,dividaAmigo(am.id)),0);}
function totalPago(){return db.amigos.reduce((a,am)=>a+pagouAmigo(am.id),0);}

// Quanto está em dívida num jogo específico para um amigo (em €)
function valorJogoPorAmigo(jogo,amigoId){
  return (jogo.golos||0)*db.config.valorPorGolo;
}
function jogoAmigoPago(jogoId,amigoId){
  return (db.pagosPorJogo[String(jogoId)]||[]).includes(amigoId);
}
// Escreve/apaga UMA linha de pagos_jogo, com rollback local se a rede falhar.
async function pjSet(jogoId,amigoId,pago){
  const k=String(jogoId);
  if(!db.pagosPorJogo[k])db.pagosPorJogo[k]=[];
  const jaEstava=db.pagosPorJogo[k].includes(amigoId);
  if(pago===jaEstava)return;
  if(pago){
    db.pagosPorJogo[k].push(amigoId);
    try{await sbReq('POST','pagos_jogo',{jogo_id:jogoId,amigo_id:amigoId});}
    catch(e){db.pagosPorJogo[k]=db.pagosPorJogo[k].filter(id=>id!==amigoId);toast('Erro: '+e.message,1);}
  }else{
    db.pagosPorJogo[k]=db.pagosPorJogo[k].filter(id=>id!==amigoId);
    try{await sbReq('DELETE',`pagos_jogo?jogo_id=eq.${jogoId}&amigo_id=eq.${amigoId}`);}
    catch(e){db.pagosPorJogo[k].push(amigoId);toast('Erro: '+e.message,1);}
  }
}
async function togglePagamento(jogoId,amigoId){
  if(roGuard())return;
  await pjSet(jogoId,amigoId,!jogoAmigoPago(jogoId,amigoId));
}

function calcPrevisao(){
  const jf=db.jogos.length;if(!jf)return null;
  const gpp=totalGolos()/jf;
  const pg=Math.round(gpp*db.jogos.length);
  const pp=pg*db.config.valorPorGolo;
  return{pg,pp,pt:pp*db.amigos.length,gpp};
}
function acumulado(){
  return[...db.jogos].sort((a,b)=>new Date(a.data)-new Date(b.data))
    .reduce((acc,j,i)=>{const v=(acc[i-1]?.v||0)+(j.golos||0)*db.config.valorPorGolo*db.amigos.length;acc.push({v});return acc;},[]);
}

/* ── NAV ─────────────────────────────────────── */
function nav(id,btn){
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('on'));
  document.querySelectorAll('.hn').forEach(b=>b.classList.remove('on'));
  document.getElementById('s-'+id).classList.add('on');btn.classList.add('on');
  ({dash:rDash})[id]?.();
}
function itab(id,btn,parent){
  if(parent==='dash'){try{localStorage.setItem('sg_tab',id);}catch(e){}}
  const sec=document.getElementById('s-'+parent);
  sec.querySelectorAll(':scope > .tp').forEach(p=>p.classList.remove('on'));
  sec.querySelectorAll(':scope > .itabs .it').forEach(b=>b.classList.remove('on'));
  document.getElementById('t-'+id).classList.add('on');btn.classList.add('on');
  ({resumo:rResumo,contas:rContas,previsao:rPrevisao,jogos:rJogos,estouro:rEstouro,cfg:rCfg})[id]?.();
}



/* ── DASHBOARD ───────────────────────────────── */
function rDash(){
  const p=document.querySelector('#s-dash > .tp.on');
  const id=p?.id?.replace('t-','');
  if(id==='contas')rContas();
  else if(id==='previsao')rPrevisao();
  else if(id==='jogos')renderJogosList();
  else if(id==='estouro')rEstouro();
  else if(id==='cfg')rCfg();
  else rResumo();
}
function rResumo(){
  const g=totalGolos(),n=db.amigos.length,vt=deveTotal();
  const tp=totalPago()*db.amigos.length; // não — totalPago() já é por pessoa
  const potePago=db.amigos.reduce((a,am)=>a+pagouAmigo(am.id),0);
  const nJogosComRes=db.jogos.filter(j=>j.golos!==null&&j.golos!==undefined&&j.golos!=='').length;
  const nJogosTotal=db.jogos.length;
  const pct=nJogosTotal>0?Math.min(100,Math.round(nJogosComRes/nJogosTotal*100)):0;
  atualizarLabelEpoca();
  // Estouro cards for resumo
  const hasEstouros=(db.estouros||[]).length>0;
  const estTotalEv=hasEstouros?estTotalEventos():0;
  const estPorReceber=hasEstouros?db.amigos.reduce((a,am)=>{
    if((db.estouroPagos||[]).includes(am.id))return a;
    const s=estSaldoPessoa(am.id);return s>0?a+s:a;
  },0):0;

  document.getElementById('stat-cards').innerHTML=`
    <div class="sc cg"><div class="sc-l">Golos marcados</div><div class="sc-v">${g}</div><div class="sc-s">${nJogosComRes} jogos realizados</div></div>
    <div class="sc cb"><div class="sc-l">Média de golos</div><div class="sc-v">${nJogosComRes>0?(g/nJogosComRes).toFixed(2):'-'}</div><div class="sc-s">por jogo realizado</div></div>
    <div class="sc co"><div class="sc-l">Pote acumulado</div><div class="sc-v">${(g*n*db.config.valorPorGolo).toFixed(0)}€</div><div class="sc-s">${n} pessoas × ${vt.toFixed(0)}€</div></div>
    <div class="sc cr"><div class="sc-l">Por receber</div><div class="sc-v">${totalDividas().toFixed(0)}€</div><div class="sc-s">dívida total em aberto</div></div>
    ${hasEstouros?`<div class="sc cr"><div class="sc-l">Estouro</div><div class="sc-v">${estTotalEv.toFixed(0)}€</div><div class="sc-s">${db.estouros.length} evento${db.estouros.length!==1?'s':''}</div></div>`:''}
    ${hasEstouros&&estPorReceber>0.01?`<div class="sc" style="border-left:3px solid var(--ou)"><div class="sc-l">Por receber (estouro)</div><div class="sc-v">${estPorReceber.toFixed(0)}€</div><div class="sc-s">em falta para acertar</div></div>`:''}
  `;
  renderMeuPedidoBox();
  renderPedidosPagamentoAdmin();
  document.getElementById('pct-l').textContent=pct+'%';
  document.getElementById('prog-b').style.width=pct+'%';
  document.getElementById('pl-a').textContent=`${nJogosComRes} jogos realizados`;
  document.getElementById('pl-b').textContent=`Total: ${nJogosTotal} jogos`;
  const hoje=new Date().toISOString().split('T')[0];
  // Admin: todos os jogos com resultado que ainda têm alguma dívida em aberto (de qualquer amigo).
  // Não-admin ligado a um amigo: só os jogos que ELE deve.
  const meu=isAdmin()?null:meuAmigoNaEpoca();
  const jogoComResultado=j=>(j.golos!==null&&j.golos!==undefined&&j.golos!=='')&&(j.golos||0)>0;
  const pendentes=[...db.jogos]
    .filter(j=>jogoComResultado(j)&&(meu?!jogoAmigoPago(j.id,meu.id):jogoTemDivida(j)))
    .sort((a,b)=>new Date(b.data)-new Date(a.data))
    .slice(0,8);
  const ul=document.getElementById('ult-jogos');
  const tit=document.getElementById('ult-jogos-tit');
  if(pendentes.length){
    if(tit){tit.style.display='';tit.textContent=meu?`Jogos que ainda deves (${pendentes.length})`:`Jogos com pagamentos pendentes (${pendentes.length})`;}
    ul.innerHTML=pendentes.map(j=>jogoCardHTML(j,true)).join('');
  } else {
    if(tit)tit.style.display='none';
    ul.innerHTML='';
  }
}
function rContas(){
  renderMeuPedidoBox();
  // Jogos por liquidar por amigo
  const jogosOrdenados=[...db.jogos]
    .filter(j=>j.golos!==null&&j.golos!==undefined&&j.golos!=='')
    .sort((a,b)=>new Date(a.data)-new Date(b.data));
  const el=document.getElementById('divida-jogos');
  if(!db.amigos.length){el.innerHTML='<div class="empty"><em>👥</em>Sem amigos</div>';return;}

  el.innerHTML=db.amigos.map(am=>{
    const divida=dividaAmigo(am.id);
    if(divida<=0) return`<div class="fcard" style="margin-bottom:10px;padding:12px 16px"><div class="nc"><div class="av" style="background:${am.cor}">${ini(am.nome)}</div><span style="font-weight:600">${am.nome}</span><span class="badge bok" style="margin-left:8px">✓ Tudo pago</span></div></div>`;

    const jogosPorPagar=jogosOrdenados.filter(j=>{
      const pag=db.pagosPorJogo[String(j.id)]||[];
      return gJ(j)>0 && !pag.includes(am.id);
    });

    const linhas=jogosPorPagar.map(j=>{
      const dt=new Date(j.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short'});
      const val=(gJ(j)*db.config.valorPorGolo).toFixed(2);
      const jorn=j.jornada||(j.competicao||'').split(' ').slice(0,2).join(' ');
      // Mini result badge (like jogos cards, with Sporting goals colored)
      let resMini='';
      if(j.resultado){
        const parts=j.resultado.split('-').map(s=>parseInt(s.trim()));
        if(parts.length===2&&!isNaN(parts[0])&&!isNaN(parts[1])){
          const isFora=j.local==='Fora';
          const gS=isFora?parts[1]:parts[0];
          const gA=isFora?parts[0]:parts[1];
          let bgCor,numCorS,numCorA;
          if(gS>gA){bgCor='#045c40';numCorS='var(--ou)';numCorA='rgba(255,255,255,0.7)';}
          else if(gS===gA){bgCor='#e6a700';numCorS='var(--vd)';numCorA='rgba(255,255,255,0.85)';}
          else{bgCor='#c62828';numCorS='var(--ou)';numCorA='rgba(255,255,255,0.7)';}
          const leftNum=isFora?`<span style="color:${numCorA}">${gA}</span>`:`<span style="color:${numCorS}">${gS}</span>`;
          const rightNum=isFora?`<span style="color:${numCorS}">${gS}</span>`:`<span style="color:${numCorA}">${gA}</span>`;
          resMini=`<span style="background:${bgCor};border-radius:5px;padding:2px 5px;display:inline-flex;align-items:center;gap:1px;font-family:'Bebas Neue',sans-serif;font-size:13px;line-height:1;white-space:nowrap">${leftNum}<span style="color:rgba(255,255,255,0.5);font-size:10px">-</span>${rightNum}</span>`;
        } else {
          resMini=`<span style="font-family:'Bebas Neue',sans-serif;font-size:14px;color:var(--ou)">${gJ(j)}</span>`;
        }
      } else {
        resMini=`<span style="font-family:'Bebas Neue',sans-serif;font-size:14px;color:var(--ou)">${gJ(j)}</span>`;
      }
      return`<div class="divida-row" style="display:grid;grid-template-columns:44px 1fr 52px 40px 46px 48px;align-items:center;gap:4px;padding:7px 0;border-bottom:1px solid var(--bo)">
        <span style="font-size:11px;color:var(--mu)">${dt}</span>
        <span style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${j.adversario}</span>
        <span style="font-size:10px;color:var(--mu);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${jorn}</span>
        <span style="text-align:center;display:flex;align-items:center;justify-content:center">${resMini}</span>
        <span style="font-size:10px;font-weight:600;color:var(--mu);text-align:right">${val}€</span>
        <button class="bsm" style="font-size:11px;padding:3px 6px;justify-self:end" onclick="marcarPagoRapido(${j.id},${am.id})">✓</button>
      </div>`;
    }).join('');

    return`<div class="fcard" style="margin-bottom:10px;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--bo)">
        <div class="nc"><div class="av" style="background:${am.cor}">${ini(am.nome)}</div>
          <span style="font-weight:600">${am.nome}</span>
          <span class="badge bdiv" style="margin-left:8px">${divida.toFixed(2)}€</span>
        </div>
        <span style="font-size:11px;color:var(--mu)">${jogosPorPagar.length} jogo${jogosPorPagar.length!==1?'s':''}</span>
      </div>
      <div style="padding:0 16px 4px">${linhas}</div>
    </div>`;
  }).join('');
}

async function marcarPagoRapido(jogoId,amigoId){
  if(roGuard())return;
  await pjSet(jogoId,amigoId,true);
  rContas();
  const am=db.amigos.find(a=>a.id===amigoId);
  toast(`${am?.nome} marcado como pago ✓`);
}
function rPrevisao(){
  // Só contar jogos com resultado real (golos não nulo)
  const jogosOrd=[...db.jogos]
    .filter(j=>j.golos!==null&&j.golos!==undefined&&j.golos!=='')
    .sort((a,b)=>new Date(a.data)-new Date(b.data));
  const nJogosFeitos=jogosOrd.length;
  const nTotal=db.jogos.length;
  const nRestantes=Math.max(0,nTotal-nJogosFeitos);
  const n=db.amigos.length||1;
  const vg=db.config.valorPorGolo;

  if(!nJogosFeitos){
    document.getElementById('prev-cards').innerHTML='<div class="empty" style="grid-column:1/-1"><em>⚽</em>Adiciona jogos para calcular</div>';
    document.getElementById('evo-w').style.display='none';
    return;
  }

  // Média total dos jogos realizados
  const totalG=jogosOrd.reduce((a,j)=>a+(j.golos||0),0);
  const gppTotal=totalG/nJogosFeitos;
  // golos previstos = já marcados + restantes × média
  const prevGolTot=totalG+Math.round(nRestantes*gppTotal);
  const prevPoteTot=prevGolTot*vg*n;
  const potAtual=totalG*vg*n;

  // Média dos últimos 10 jogos realizados
  const ult10=jogosOrd.slice(-10);
  const gUlt10=ult10.reduce((a,j)=>a+(j.golos||0),0);
  const gppUlt10=gUlt10/ult10.length;
  const prevGolUlt=totalG+Math.round(nRestantes*gppUlt10);
  const prevPoteUlt=prevGolUlt*vg*n;

  document.getElementById('prev-cards').innerHTML=`
    <div class="sc cg">
      <div class="sc-l">Média total</div>
      <div class="sc-v">${prevPoteTot.toFixed(0)}€</div>
      <div class="sc-s">${prevGolTot} golos · ${gppTotal.toFixed(2)}/jogo · ${nRestantes} jogos restantes</div>
    </div>
    <div class="sc co">
      <div class="sc-l">Últimos 10 jogos</div>
      <div class="sc-v">${prevPoteUlt.toFixed(0)}€</div>
      <div class="sc-s">${prevGolUlt} golos · ${gppUlt10.toFixed(2)}/jogo · ${nRestantes} jogos restantes</div>
    </div>
  `;

  // Gráfico melhorado
  const ew=document.getElementById('evo-w');
  ew.style.display='block';
  const cv=document.getElementById('c-evo');
  const dpr=window.devicePixelRatio||1;
  const W=ew.clientWidth-40||660,H=260;
  cv.width=W*dpr;cv.height=H*dpr;
  cv.style.width=W+'px';cv.style.height=H+'px';
  const ctx=cv.getContext('2d');
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);

  const prevTotArr=[];
  const prevUlt10Arr=[];

  let accG=0;
  jogosOrd.forEach((j,i)=>{
    accG+=(j.golos||0);
    const jogosRestAqui=Math.max(0,nTotal-(i+1));
    const gppAqui=accG/(i+1);
    prevTotArr.push((accG+Math.round(jogosRestAqui*gppAqui))*vg*n);
    const slice=jogosOrd.slice(Math.max(0,i-9),i+1);
    const gSlice=slice.reduce((a,s)=>a+(s.golos||0),0);
    const gppSlice=gSlice/slice.length;
    prevUlt10Arr.push((accG+Math.round(jogosRestAqui*gppSlice))*vg*n);
  });

  const SKIP=5;
  const prevTotPlot=prevTotArr.slice(SKIP);
  const prevUlt10Plot=prevUlt10Arr.slice(SKIP);
  const jogosOrdPlot=jogosOrd.slice(SKIP);

  const allVals=[...prevTotPlot,...prevUlt10Plot];
  const minV=Math.min(...allVals)*0.90||0;
  const maxV=Math.max(...allVals)*1.06||1;

  const PAD_L=52,PAD_R=20,PAD_T=18,PAD_B=34;
  const W2=W-PAD_L-PAD_R,H2=H-PAD_T-PAD_B;
  const nP=prevTotPlot.length;
  if(nP<1){ew.style.display='none';return;}
  function px(i){return PAD_L+i/(nP-1||1)*W2;}
  function py(v){return PAD_T+H2-((v-minV)/((maxV-minV)||1))*H2;}

  // Fundo suave
  const bgGrad=ctx.createLinearGradient(0,PAD_T,0,H-PAD_B);
  bgGrad.addColorStop(0,'rgba(232,245,233,0.2)');
  bgGrad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=bgGrad;
  ctx.fillRect(PAD_L,PAD_T,W2,H2);

  // Grid Y — valores arredondados
  function niceStep(range,ticks){
    const raw=range/ticks;const mag=Math.pow(10,Math.floor(Math.log10(raw)));
    const res=raw/mag;let nice;
    if(res<=1.5)nice=1;else if(res<=3)nice=2;else if(res<=7)nice=5;else nice=10;
    return nice*mag;
  }
  const step=niceStep(maxV-minV,4);
  const gridStart=Math.ceil(minV/step)*step;
  ctx.textAlign='right';ctx.textBaseline='middle';
  for(let v=gridStart;v<=maxV;v+=step){
    const y=py(v);
    ctx.strokeStyle='#eae8e4';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(PAD_L,y);ctx.lineTo(W-PAD_R,y);ctx.stroke();
    ctx.fillStyle='#aaa';ctx.font='500 10px Inter,sans-serif';
    ctx.fillText(v>=1000?(v/1000).toFixed(v%1000===0?0:1)+'k':v.toFixed(0)+'€',PAD_L-6,y);
  }

  // Curva suave (Catmull-Rom)
  function smoothLine(arr,close){
    if(arr.length<2)return;
    ctx.beginPath();ctx.moveTo(px(0),py(arr[0]));
    if(arr.length===2){ctx.lineTo(px(1),py(arr[1]));if(!close)ctx.stroke();return;}
    for(let i=0;i<arr.length-1;i++){
      const p0=i>0?{x:px(i-1),y:py(arr[i-1])}:{x:px(i),y:py(arr[i])};
      const p1={x:px(i),y:py(arr[i])};
      const p2={x:px(i+1),y:py(arr[i+1])};
      const p3=i<arr.length-2?{x:px(i+2),y:py(arr[i+2])}:p2;
      const t=0.35;
      ctx.bezierCurveTo(p1.x+(p2.x-p0.x)*t/3,p1.y+(p2.y-p0.y)*t/3,p2.x-(p3.x-p1.x)*t/3,p2.y-(p3.y-p1.y)*t/3,p2.x,p2.y);
    }
    if(!close)ctx.stroke();
  }

  // Área sob a linha verde
  ctx.save();ctx.strokeStyle='transparent';ctx.lineWidth=0;
  smoothLine(prevTotPlot,true);
  ctx.lineTo(px(nP-1),H-PAD_B);ctx.lineTo(px(0),H-PAD_B);ctx.closePath();
  const areaGrad=ctx.createLinearGradient(0,PAD_T,0,H-PAD_B);
  areaGrad.addColorStop(0,'rgba(4,126,87,0.12)');areaGrad.addColorStop(1,'rgba(4,126,87,0.01)');
  ctx.fillStyle=areaGrad;ctx.fill();ctx.restore();

  // Linha verde — média total
  ctx.strokeStyle='#047e57';ctx.lineWidth=2.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([]);
  smoothLine(prevTotPlot);

  // Linha amarela — últimos 10
  ctx.strokeStyle='#e6a700';ctx.lineWidth=2;ctx.setLineDash([6,5]);
  smoothLine(prevUlt10Plot);
  ctx.setLineDash([]);

  // Pontos finais
  [['#047e57',prevTotPlot],['#e6a700',prevUlt10Plot]].forEach(([col,arr])=>{
    const last=arr[arr.length-1];
    ctx.beginPath();ctx.arc(px(nP-1),py(last),4,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
    ctx.beginPath();ctx.arc(px(nP-1),py(last),6.5,0,Math.PI*2);
    ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.globalAlpha=0.25;ctx.stroke();ctx.globalAlpha=1;
  });

  // Labels eixo X
  ctx.fillStyle='#aaa';ctx.font='500 10px Inter,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';
  const maxLabels=Math.floor(W2/50);
  const labelStep=Math.max(1,Math.ceil(nP/maxLabels));
  jogosOrdPlot.forEach((j,i)=>{
    const jNum=i+SKIP+1;
    if(i===0||i===nP-1||i%labelStep===0) ctx.fillText('J'+jNum,px(i),H-PAD_B+8);
  });

  // Tooltip interactivo
  const tooltip=document.getElementById('evo-tooltip');
  const crosshair=document.getElementById('evo-crosshair');

  function handleChartHover(e){
    e.preventDefault();
    const rect=cv.getBoundingClientRect();
    const clientX=e.touches?e.touches[0].clientX:e.clientX;
    const mx=(clientX-rect.left)*(W/rect.width);
    let closest=-1,minDist=Infinity;
    for(let i=0;i<nP;i++){const d=Math.abs(px(i)-mx);if(d<minDist){minDist=d;closest=i;}}
    if(closest<0||minDist>30){tooltip.style.display='none';crosshair.style.display='none';return;}
    const jNum=closest+SKIP+1;
    const adv=jogosOrdPlot[closest]?.adversario||'';
    const vTot=prevTotPlot[closest];
    const vUlt=prevUlt10Plot[closest];
    const diff=vUlt-vTot;const diffStr=diff>=0?'+'+diff.toFixed(0):diff.toFixed(0);
    tooltip.innerHTML=`<div style="font-weight:700;margin-bottom:3px">Jogo ${jNum}${adv?' · '+adv:''}</div>`+
      `<div style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:#047e57;border-radius:50%;flex-shrink:0"></span>Média total: <strong>${vTot.toFixed(0)}€</strong></div>`+
      `<div style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:#e6a700;border-radius:50%;flex-shrink:0"></span>Últ. 10: <strong>${vUlt.toFixed(0)}€</strong> <span style="opacity:.6">(${diffStr}€)</span></div>`;
    const pxPos=px(closest)*(rect.width/W);
    const tipW=tooltip.offsetWidth||160;
    let left=pxPos+12;if(left+tipW>rect.width-10)left=pxPos-tipW-12;
    tooltip.style.left=left+'px';tooltip.style.top='10px';tooltip.style.display='block';
    crosshair.style.left=pxPos+'px';
    crosshair.style.height=(H2*(rect.height/H))+'px';
    crosshair.style.top=(PAD_T*(rect.height/H))+'px';
    crosshair.style.display='block';
  }
  cv.onmousemove=handleChartHover;cv.ontouchmove=handleChartHover;
  cv.onmouseleave=function(){tooltip.style.display='none';crosshair.style.display='none';};

  // Gráfico comparativo com épocas anteriores
  rCompEpocas();
}

function rCompEpocas(){
  const cw=document.getElementById('comp-w');
  const idxAtual=epocasOrdem.indexOf(epocaAtiva);
  // Precisa de pelo menos uma época anterior
  if(idxAtual<=0){cw.style.display='none';return;}

  // Recolher até 3 épocas: actual + 2 anteriores
  const epocasComp=[];
  for(let i=Math.max(0,idxAtual-2);i<=idxAtual;i++){
    epocasComp.push(epocasOrdem[i]);
  }

  // Cores e estilos por posição (mais recente = mais destaque)
  const STYLES=[
    {cor:'#bbb',width:1.5,dash:[4,4],area:false},    // mais antiga
    {cor:'#7b5e00',width:2,dash:[6,4],area:false},    // intermédia
    {cor:'#047e57',width:2.5,dash:[],area:true}       // actual
  ];
  // Alinhar: se só 2 épocas, usar posições [0] e [2] (skip middle)
  const styleMap=epocasComp.length===2?[STYLES[0],STYLES[2]]
    :epocasComp.length===3?STYLES:[STYLES[2]];

  // Calcular golos acumulados por jogo para cada época
  const series=[];
  epocasComp.forEach((ep,si)=>{
    const epData=dbFull.epocas[ep];
    if(!epData)return;
    const jogos=[...(epData.jogos||[])]
      .filter(j=>j.golos!==null&&j.golos!==undefined&&j.golos!=='')
      .sort((a,b)=>new Date(a.data)-new Date(b.data));
    if(!jogos.length)return;
    let acc=0;
    const pontos=jogos.map((j,i)=>{acc+=(j.golos||0);return{golos:acc,adv:j.adversario||''};});
    series.push({ep,pontos,style:styleMap[si]});
  });

  if(series.length<2){cw.style.display='none';return;}

  cw.style.display='block';

  // Legenda
  const legend=document.getElementById('comp-legend');
  legend.innerHTML=series.map(s=>{
    const lineStyle=s.style.dash.length
      ?`width:22px;height:0;border-top:2.5px dashed ${s.style.cor}`
      :`width:22px;height:3px;background:${s.style.cor};border-radius:2px`;
    return`<span style="display:flex;align-items:center;gap:5px"><span style="${lineStyle}"></span>${s.ep}</span>`;
  }).join('');

  // Canvas
  const cv2=document.getElementById('c-comp');
  const dpr=window.devicePixelRatio||1;
  const W=cw.clientWidth-40||660,H=260;
  cv2.width=W*dpr;cv2.height=H*dpr;
  cv2.style.width=W+'px';cv2.style.height=H+'px';
  const ctx=cv2.getContext('2d');
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);

  const maxJogos=Math.max(...series.map(s=>s.pontos.length));
  const maxGolos=Math.max(...series.flatMap(s=>s.pontos.map(p=>p.golos)))*1.08||1;

  const PAD_L=42,PAD_R=20,PAD_T=18,PAD_B=34;
  const W2=W-PAD_L-PAD_R,H2=H-PAD_T-PAD_B;
  function cpx(i){return PAD_L+i/(maxJogos-1||1)*W2;}
  function cpy(v){return PAD_T+H2-(v/(maxGolos||1))*H2;}

  // Fundo
  const bgGrad=ctx.createLinearGradient(0,PAD_T,0,H-PAD_B);
  bgGrad.addColorStop(0,'rgba(232,245,233,0.15)');
  bgGrad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=bgGrad;
  ctx.fillRect(PAD_L,PAD_T,W2,H2);

  // Grid Y
  function niceStep2(range,ticks){
    const raw=range/ticks;const mag=Math.pow(10,Math.floor(Math.log10(raw)));
    const res=raw/mag;let nice;
    if(res<=1.5)nice=1;else if(res<=3)nice=2;else if(res<=7)nice=5;else nice=10;
    return nice*mag;
  }
  const step=niceStep2(maxGolos,4);
  const gridStart=Math.ceil(0/step)*step;
  ctx.textAlign='right';ctx.textBaseline='middle';
  for(let v=gridStart;v<=maxGolos;v+=step){
    const y=cpy(v);
    ctx.strokeStyle='#eae8e4';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(PAD_L,y);ctx.lineTo(W-PAD_R,y);ctx.stroke();
    ctx.fillStyle='#aaa';ctx.font='500 10px Inter,sans-serif';
    ctx.fillText(v.toFixed(0),PAD_L-6,y);
  }

  // Curva suave
  function smoothLine2(pts,close){
    const arr=pts.map(p=>p.golos);
    if(arr.length<2)return;
    ctx.beginPath();ctx.moveTo(cpx(0),cpy(arr[0]));
    if(arr.length===2){ctx.lineTo(cpx(1),cpy(arr[1]));if(!close)ctx.stroke();return;}
    for(let i=0;i<arr.length-1;i++){
      const p0=i>0?{x:cpx(i-1),y:cpy(arr[i-1])}:{x:cpx(i),y:cpy(arr[i])};
      const p1={x:cpx(i),y:cpy(arr[i])};
      const p2={x:cpx(i+1),y:cpy(arr[i+1])};
      const p3=i<arr.length-2?{x:cpx(i+2),y:cpy(arr[i+2])}:p2;
      const t=0.35;
      ctx.bezierCurveTo(p1.x+(p2.x-p0.x)*t/3,p1.y+(p2.y-p0.y)*t/3,p2.x-(p3.x-p1.x)*t/3,p2.y-(p3.y-p1.y)*t/3,p2.x,p2.y);
    }
    if(!close)ctx.stroke();
  }

  // Desenhar cada série
  series.forEach(s=>{
    const pts=s.pontos;const st=s.style;
    // Área (só para a época actual)
    if(st.area&&pts.length>1){
      ctx.save();ctx.strokeStyle='transparent';ctx.lineWidth=0;
      smoothLine2(pts,true);
      ctx.lineTo(cpx(pts.length-1),H-PAD_B);ctx.lineTo(cpx(0),H-PAD_B);ctx.closePath();
      const ag=ctx.createLinearGradient(0,PAD_T,0,H-PAD_B);
      ag.addColorStop(0,'rgba(4,126,87,0.10)');ag.addColorStop(1,'rgba(4,126,87,0.01)');
      ctx.fillStyle=ag;ctx.fill();ctx.restore();
    }
    // Linha
    ctx.strokeStyle=st.cor;ctx.lineWidth=st.width;ctx.lineJoin='round';ctx.lineCap='round';
    ctx.setLineDash(st.dash);
    smoothLine2(pts);
    ctx.setLineDash([]);
    // Ponto final
    const last=pts[pts.length-1];
    ctx.beginPath();ctx.arc(cpx(pts.length-1),cpy(last.golos),3.5,0,Math.PI*2);
    ctx.fillStyle=st.cor;ctx.fill();
  });

  // Labels eixo X
  ctx.fillStyle='#aaa';ctx.font='500 10px Inter,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';
  const maxLbl=Math.floor(W2/50);
  const lblStep=Math.max(1,Math.ceil(maxJogos/maxLbl));
  for(let i=0;i<maxJogos;i++){
    if(i===0||i===maxJogos-1||i%lblStep===0) ctx.fillText(''+(i+1),cpx(i),H-PAD_B+8);
  }
  // Eixo X title
  ctx.fillStyle='#bbb';ctx.font='500 9px Inter,sans-serif';
  ctx.fillText('Jogo nº',PAD_L+W2/2,H-4);

  // Tooltip
  const tooltip2=document.getElementById('comp-tooltip');
  const cross2=document.getElementById('comp-crosshair');
  function handleCompHover(e){
    e.preventDefault();
    const rect=cv2.getBoundingClientRect();
    const clientX=e.touches?e.touches[0].clientX:e.clientX;
    const mx=(clientX-rect.left)*(W/rect.width);
    let closest=-1,minDist=Infinity;
    for(let i=0;i<maxJogos;i++){const d=Math.abs(cpx(i)-mx);if(d<minDist){minDist=d;closest=i;}}
    if(closest<0||minDist>30){tooltip2.style.display='none';cross2.style.display='none';return;}
    let html=`<div style="font-weight:700;margin-bottom:3px">Jogo ${closest+1}</div>`;
    series.forEach(s=>{
      if(closest<s.pontos.length){
        const p=s.pontos[closest];
        const avg=(p.golos/(closest+1)).toFixed(2);
        html+=`<div style="display:flex;align-items:center;gap:5px"><span style="width:8px;height:8px;background:${s.style.cor};border-radius:50%;flex-shrink:0"></span>${s.ep}: <strong>${p.golos}</strong> golos <span style="opacity:.6">(${avg}/jogo)</span></div>`;
      }
    });
    tooltip2.innerHTML=html;
    const pxPos=cpx(closest)*(rect.width/W);
    const tipW=tooltip2.offsetWidth||160;
    let left=pxPos+12;if(left+tipW>rect.width-10)left=pxPos-tipW-12;
    tooltip2.style.left=left+'px';tooltip2.style.top='10px';tooltip2.style.display='block';
    cross2.style.left=pxPos+'px';
    cross2.style.height=(H2*(rect.height/H))+'px';
    cross2.style.top=(PAD_T*(rect.height/H))+'px';
    cross2.style.display='block';
  }
  cv2.onmousemove=handleCompHover;cv2.ontouchmove=handleCompHover;
  cv2.onmouseleave=function(){tooltip2.style.display='none';cross2.style.display='none';};
}

/* ── JOGOS ───────────────────────────────────── */

function jogoTemDivida(j){
  // jogos sem resultado (null) não têm dívida
  if(j.golos===null||j.golos===undefined||j.golos==='')return false;
  if(gJ(j)===0)return false;
  const pag=db.pagosPorJogo[String(j.id)]||[];
  return pag.length<db.amigos.length;
}

let filtPag='todos';
function setFiltPag(modo,btn){
  filtPag=modo;
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on','on-dv'));
  btn.classList.add(modo==='divida'?'on-dv':'on');
  renderJogosList();
}

function jogoCardHTML(j,mini=false){
  const d=new Date(j.data+'T12:00:00');
  const dia=d.getDate().toString().padStart(2,'0');
  const mes=d.toLocaleString('pt-PT',{month:'short'}).replace('.','').toUpperCase();
  const pagaram=db.pagosPorJogo[String(j.id)]||[];
  const nPag=pagaram.length,nTotal=db.amigos.length;
  const hoje=new Date().toISOString().split('T')[0];
  const golosJ=gJ(j);
  const isFuturo=(j.golos===null||j.golos===undefined||j.golos==='');

  let dotsHTML='';
  if(!isFuturo && golosJ>0){
    if(nTotal<=12){
      dotsHTML=db.amigos.map(am=>{
        const p=pagaram.includes(am.id);
        return`<div class="jpag-dot ${p?'pago':'nao'}" style="${p?'background:'+am.cor+';border-color:'+am.cor:''}" title="${am.nome}${p?' ✓':' ✗'}"></div>`;
      }).join('');
    } else {
      dotsHTML=`<span style="font-size:12px;font-weight:600;color:${nPag===nTotal?'var(--vd)':'var(--dg)'}">${nPag}/${nTotal}</span>`;
    }
  }

  const pot=(golosJ*db.config.valorPorGolo*nTotal).toFixed(0);
  const divVal=!isFuturo&&golosJ>0&&nPag<nTotal?(golosJ*db.config.valorPorGolo*(nTotal-nPag)).toFixed(0):null;
  const delBtn='';
  const editBtn='';

  // valor: +pote verde; se houver dívida, -divida vermelho; se pago, "Pago ✓"; se 0 golos, "N/A"
  let valHTML='';
  if(!isFuturo && golosJ===0){
    valHTML='<div class="jval"><span style="font-size:13px;font-weight:600;color:#999">N/A</span></div>';
  } else if(!isFuturo&&golosJ>0){
    if(nPag>=nTotal){
      valHTML=`<div class="jval"><span class="jval-total">+${pot}€</span><span style="font-size:11px;font-weight:600;color:var(--vd)">Pago ✓</span></div>`;
    } else {
      valHTML=`<div class="jval"><span class="jval-total">+${pot}€</span>${divVal?`<span class="jval-div">−${divVal}€</span>`:''}</div>`;
    }
  }

  // Local badge — SVG single-color icons
  const localSVG={
    'Casa':`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c8a415" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7.5L21 10"/><path d="M5 8.8V21h14V8.8"/><path d="M9.5 21v-6.5h5V21"/></svg>`,
    'Fora':`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e65100" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>`,
    'Neutro':`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1565c0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>`
  };
  const localIcon=localSVG[j.local]||'';
  const localBadge=localIcon?`<span class="jlocal-badge">${localIcon}</span>`:'';

  // Resultado no lugar do jgol — número do Sporting colorido
  let resDisplayHTML='';
  if(isFuturo){
    resDisplayHTML=`<div class="jgol"><div class="gn" style="color:#ccc">—</div><div class="gl"></div></div>`;
  } else if(!j.resultado){
    resDisplayHTML=`<div class="jgol"><div class="gn">${golosJ}</div><div class="gl">golo${golosJ!==1?'s':''}</div></div>`;
  } else {
    const parts=j.resultado.split('-').map(s=>parseInt(s.trim()));
    if(parts.length===2&&!isNaN(parts[0])&&!isNaN(parts[1])){
      const gS=j.local==='Fora'?parts[1]:parts[0];
      const gA=j.local==='Fora'?parts[0]:parts[1];
      let bgCor,numCorS,numCorA;
      if(gS>gA){bgCor='#045c40';numCorS='var(--ou)';numCorA='rgba(255,255,255,0.7)';}
      else if(gS===gA){bgCor='#e6a700';numCorS='var(--vd)';numCorA='rgba(255,255,255,0.85)';}
      else{bgCor='#c62828';numCorS='var(--ou)';numCorA='rgba(255,255,255,0.7)';}
      // Fora: adversário-Sporting; Casa/Neutro: Sporting-adversário
      const leftNum=j.local==='Fora'?`<span style="color:${numCorA}">${gA}</span>`:`<span style="color:${numCorS}">${gS}</span>`;
      const rightNum=j.local==='Fora'?`<span style="color:${numCorS}">${gS}</span>`:`<span style="color:${numCorA}">${gA}</span>`;
      resDisplayHTML=`<div class="jgol"><div style="background:${bgCor};border-radius:7px;padding:3px 7px;display:inline-flex;align-items:baseline;gap:2px;font-family:'Bebas Neue',sans-serif;font-size:20px;line-height:1">${leftNum}<span style="color:rgba(255,255,255,0.5);font-size:14px">-</span>${rightNum}</div></div>`;
    } else {
      resDisplayHTML=`<div class="jgol"><div class="gn">${golosJ}</div><div class="gl">golo${golosJ!==1?'s':''}</div></div>`;
    }
  }

  // resBadge já não é necessário no jadv
  const resBadge='';

  return`<div class="jcard" onclick="abrirDetalhe(${j.id})" style="${isFuturo?'opacity:.75':''}">
    ${localBadge}
    <div class="jdt"><strong>${dia}</strong><span>${mes}</span></div>
    <div class="jsep"></div>
    <span class="jlogo">${(l=>l?`<img src="${l}" alt="" loading="lazy" onerror="this.style.display='none'">`:'')(logoAdv(j.adversario))}</span>
    <div class="jinfo"><div class="jadv">${j.adversario}</div><div class="jcomp">${j.competicao}${j.jornada?' · '+j.jornada:''}</div></div>
    <div class="jpag-bar">${dotsHTML}</div>
    ${resDisplayHTML}
    ${valHTML}
    ${editBtn}
    ${delBtn}
  </div>`;
}

// 'desc' = mais recentes primeiro (defeito) · 'asc' = mais antigos primeiro
let ordemJogos='desc';
function setOrdemJogos(o){
  ordemJogos=o;
  document.getElementById('f-ord-desc')?.classList.toggle('on',o==='desc');
  document.getElementById('f-ord-asc')?.classList.toggle('on',o==='asc');
  renderJogosList();
}

function renderJogosList(){
  const filtro=document.getElementById('f-comp').value;
  const filtroLocal=document.getElementById('f-local').value;
  const hoje=new Date().toISOString().split('T')[0];
  let jogos=[...db.jogos].sort((a,b)=>ordemJogos==='asc'?new Date(a.data)-new Date(b.data):new Date(b.data)-new Date(a.data));
  if(filtro)jogos=jogos.filter(j=>j.competicao===filtro);
  if(filtroLocal)jogos=jogos.filter(j=>j.local===filtroLocal);
  if(filtPag==='divida') jogos=jogos.filter(j=>(j.golos!==null&&j.golos!==undefined&&j.golos!=='')&&(j.golos||0)>0&&jogoTemDivida(j));
  if(filtPag==='pago')   jogos=jogos.filter(j=>(j.golos!==null&&j.golos!==undefined&&j.golos!=='')&&(j.golos||0)>0&&!jogoTemDivida(j));
  document.getElementById('j-list').innerHTML=jogos.length?jogos.map(j=>jogoCardHTML(j)).join(''):'<div class="empty"><em>⚽</em>Sem jogos</div>';
}

let _lastViewedJogoId=null;

function abrirDetalhe(jogoId){
  const jogo=db.jogos.find(j=>j.id===jogoId);if(!jogo)return;
  _lastViewedJogoId=jogoId;
  const dashSec=document.getElementById('s-dash');
  dashSec.querySelectorAll(':scope > .tp').forEach(p=>p.classList.remove('on'));
  dashSec.querySelectorAll(':scope > .itabs .it').forEach(b=>b.classList.remove('on'));
  document.getElementById('t-jogos').classList.add('on');
  document.querySelector('#s-dash > .itabs .it:nth-child(4)').classList.add('on');
  // mostrar painel detalhe dentro da aba Jogos
  document.getElementById('t-jlista').style.display='none';
  document.getElementById('t-jdetalhe').style.display='block';
  renderDetalhe(jogo);
}

function voltarLista(){
  document.getElementById('t-jlista').style.display='block';
  document.getElementById('t-jdetalhe').style.display='none';
  renderJogosList();
  // Posicionar na lista no jogo que estávamos a ver
  if(_lastViewedJogoId){
    requestAnimationFrame(()=>{
      const cards=document.querySelectorAll('#j-list .jcard');
      for(const card of cards){
        if(card.getAttribute('onclick')&&card.getAttribute('onclick').includes(_lastViewedJogoId)){
          card.scrollIntoView({block:'center',behavior:'smooth'});
          // Piscar brevemente para destacar o jogo
          card.style.transition='box-shadow .2s,border-color .2s';
          card.style.borderColor='var(--vd)';
          card.style.boxShadow='0 0 0 2px rgba(4,126,87,.2)';
          setTimeout(()=>{card.style.borderColor='';card.style.boxShadow='';},900);
          break;
        }
      }
    });
  }
}

function renderDetalhe(jogo){
  const pagaram=db.pagosPorJogo[String(jogo.id)]||[];
  const d=new Date(jogo.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'long',year:'numeric'});
  const golosJogo=gJ(jogo);
  const valorPorPessoa=(golosJogo*db.config.valorPorGolo).toFixed(2);
  const nPag=pagaram.length,nTotal=db.amigos.length;
  const totalJogo=(golosJogo*db.config.valorPorGolo*nTotal).toFixed(0);
  const totalReceb=(golosJogo*db.config.valorPorGolo*nPag).toFixed(0);
  const isFuturo=(jogo.golos===null||jogo.golos===undefined||jogo.golos==='');

  // --- Cabeçalho: equipas na ordem certa (casa à esquerda) + resultado formatado ---
  // Casa/Neutro: Sporting (esq) vs Adversário (dir)
  // Fora: Adversário (esq) vs Sporting (dir)
  const isFora=jogo.local==='Fora';
  const nomeEsq=isFora?jogo.adversario:'Sporting';
  const nomeDir=isFora?'Sporting':jogo.adversario;

  // Resultado visual — mesma lógica do jogoCardHTML
  let resHeaderHTML='<span style="font-family:\'Bebas Neue\',sans-serif;font-size:28px;color:#ccc;padding:0 8px">—</span>';
  if(!isFuturo&&jogo.resultado){
    const parts=jogo.resultado.split('-').map(s=>parseInt(s.trim()));
    if(parts.length===2&&!isNaN(parts[0])&&!isNaN(parts[1])){
      const gS=isFora?parts[1]:parts[0];
      const gA=isFora?parts[0]:parts[1];
      let bgCor;
      if(gS>gA)bgCor='#045c40';
      else if(gS===gA)bgCor='#e6a700';
      else bgCor='#c62828';
      const leftNum=isFora?gA:gS;
      const rightNum=isFora?gS:gA;
      resHeaderHTML=`<div style="background:${bgCor};border-radius:8px;padding:4px 12px;display:inline-flex;align-items:baseline;gap:3px;font-family:'Bebas Neue',sans-serif;font-size:28px;line-height:1;color:#fff">
        <span>${leftNum}</span><span style="opacity:.5;font-size:20px">-</span><span>${rightNum}</span>
      </div>`;
    }
  } else if(!isFuturo&&!jogo.resultado&&golosJogo>=0){
    resHeaderHTML=`<span style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:var(--ou);padding:0 8px">${golosJogo}</span>`;
  }

  // Local icon inline
  const localSVGsm={'Casa':'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px"><polygon points="12,3 2,11 4,11 4,21 10,21 10,15 14,15 14,21 20,21 20,11 22,11" fill="#c8a415" opacity=".85"/><rect x="10" y="15" width="4" height="6" rx="1" fill="#a07800"/><polygon points="12,3 2,11 22,11" fill="#c8a415"/></svg>','Fora':'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="#e65100"/></svg>','Neutro':'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px"><path d="M3 17.5V20h18v-2.5c0-1.1-.4-2-1.2-2.5L12 11 4.2 15c-.8.5-1.2 1.4-1.2 2.5z" fill="#1565c0"/><ellipse cx="12" cy="8" rx="9" ry="4" fill="#1565c0" opacity=".5"/></svg>'};
  const localLabel=jogo.local?(localSVGsm[jogo.local]||'')+' '+jogo.local:'';

  // Lista de amigos em 2 colunas, sem siglas nem "pago/deve" — só nome + toggle
  const amigosGrid=db.amigos.length?`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
      ${db.amigos.map((am,i)=>{
        const pago=pagaram.includes(am.id);
        return`<div class="amigo-pag-row" style="border-bottom:${i<db.amigos.length-2&&i<db.amigos.length-(db.amigos.length%2===0?2:1)?'1px solid var(--bo)':'none'};padding:9px 6px 9px 0">
          <label class="toggle-pago" style="cursor:pointer;gap:9px" onclick="togglePagJogo(${jogo.id},${am.id},this)">
            <div class="toggle-check ${pago?'on':''}"><span>${pago?'✓':''}</span></div>
            <span style="font-size:13px;font-weight:500">${am.nome}</span>
          </label>
        </div>`;
      }).join('')}
    </div>`
  :'<div class="empty"><em>👥</em>Sem amigos configurados</div>';

  document.getElementById('jd-content').innerHTML=`
    <div class="jogo-detalhe" style="padding:0;overflow:hidden">

      <!-- CABEÇALHO: jogo + resultado -->
      <div style="background:linear-gradient(135deg,#f0faf2,#fff);border-bottom:1px solid var(--bo);padding:16px 20px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
          <!-- Equipa esquerda -->
          <div style="flex:1;min-width:0;text-align:center">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--vd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nomeEsq}</div>
          </div>
          <!-- Resultado central -->
          <div style="flex-shrink:0;text-align:center">
            ${resHeaderHTML}
          </div>
          <!-- Equipa direita -->
          <div style="flex:1;min-width:0;text-align:center">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;color:var(--vd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nomeDir}</div>
          </div>
        </div>
        <!-- Local centrado por baixo do resultado -->
        ${localLabel?`<div style="text-align:center;font-size:11px;color:var(--mu)">${localLabel}</div>`:''}
      </div>

      <!-- META + EDITAR/APAGAR -->
      <div style="padding:14px 20px;border-bottom:1px solid var(--bo);display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="font-size:12px;color:var(--mu)">${jogo.competicao}${jogo.jornada?' · '+jogo.jornada:''}</div>
          <div style="font-size:12px;color:var(--mu)">${d}</div>
          <div style="font-size:12px;color:var(--mu)">Pote do jogo: <strong style="color:var(--tx)">${totalJogo}€</strong></div>
          <div style="font-size:12px;color:var(--mu)">Valor recebido: <strong style="color:var(--vd)">${totalReceb}€</strong></div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="jdel" style="color:#1565c0;border:1px solid #ddd;border-radius:7px;padding:5px 9px;font-size:13px" onclick="abrirModalEditar(${jogo.id})" title="Editar">✏️ Editar</button>
          <button class="jdel" style="color:var(--dg);border:1px solid #ddd;border-radius:7px;padding:5px 9px;font-size:13px" onclick="if(confirm('Remover este jogo?'))remJogo(${jogo.id})" title="Remover">✕ Apagar</button>
        </div>
      </div>

      <!-- QUEM PAGOU -->
      <div style="padding:14px 20px 14px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--mu);margin-bottom:10px">
          Quem pagou este jogo (${nPag}/${nTotal})
        </div>
        ${amigosGrid}
      </div>
    </div>
  `;
}

async function togglePagJogo(jogoId,amigoId,labelEl){
  await togglePagamento(jogoId,amigoId);
  const jogo=db.jogos.find(j=>j.id===jogoId);
  renderDetalhe(jogo); // re-render para actualizar tudo
}
async function marcarTodos(jogoId){
  if(roGuard())return;
  const antes=db.pagosPorJogo[String(jogoId)]||[];
  db.pagosPorJogo[String(jogoId)]=db.amigos.map(a=>a.id);
  try{
    await sbReq('DELETE',`pagos_jogo?jogo_id=eq.${jogoId}`);
    if(db.amigos.length)await sbReq('POST','pagos_jogo',db.amigos.map(a=>({jogo_id:jogoId,amigo_id:a.id})));
  }catch(e){db.pagosPorJogo[String(jogoId)]=antes;toast('Erro: '+e.message,1);return;}
  const jogo=db.jogos.find(j=>j.id===jogoId);renderDetalhe(jogo);
  toast('Todos marcados como pagos ✓');
}
async function desmarcarTodos(jogoId){
  if(roGuard())return;
  const antes=db.pagosPorJogo[String(jogoId)]||[];
  db.pagosPorJogo[String(jogoId)]=[];
  try{await sbReq('DELETE',`pagos_jogo?jogo_id=eq.${jogoId}`);}
  catch(e){db.pagosPorJogo[String(jogoId)]=antes;toast('Erro: '+e.message,1);return;}
  const jogo=db.jogos.find(j=>j.id===jogoId);renderDetalhe(jogo);
  toast('Todos desmarcados');
}

function rJogos(){
  const hoje=new Date().toISOString().split('T')[0];
  if(document.getElementById('cal-data'))document.getElementById('cal-data').value=hoje;
  document.getElementById('t-jlista').style.display='block';
  document.getElementById('t-jdetalhe').style.display='none';
  renderJogosList();
}

/* ── PEDIDOS DE PAGAMENTO ("já paguei os jogos A, B, D") ──────────────────
   Um amigo (ligado a um login via goals.user_amigos) declara que já pagou
   um conjunto de jogos; fica 'pendente' em goals.pedidos_pagamento — NADA
   disto mexe em pagosPorJogo enquanto não for decidido, não é dinheiro,
   é só um aviso. O admin aprova (grava pagos_jogo) ou rejeita (com motivo).
   Mesmo padrão do pagamentos_pendentes do FestasBV. */

// ── Lado do admin: painel no Resumo, logo a seguir aos cards ──
function renderPedidosPagamentoAdmin(){
  const el=document.getElementById('pedidos-admin-box');
  if(!el)return;
  if(!isAdmin()){el.innerHTML='';return;}
  const pendentes=(db.pedidosPagamento||[]).filter(p=>p.estado==='pendente');
  if(!pendentes.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="pp-box"><h3>🕓 Pedidos de pagamento (${pendentes.length})</h3>`+
    pendentes.map(p=>{
      const am=db.amigos.find(a=>a.id===p.amigoId);
      const nomes=p.jogoIds.map(id=>{
        const j=db.jogos.find(x=>x.id===id);
        return j?`vs ${j.adversario} (${new Date(j.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short'})})`:null;
      }).filter(Boolean).join(', ');
      return`<div class="pp-card">
        <div class="pp-card-head"><span class="pp-card-nome">${am?am.nome:'?'}</span><span class="pp-card-val">${p.valor.toFixed(2)}€</span></div>
        <div class="pp-card-jogos">${nomes}${p.nota?`<br><em>"${p.nota}"</em>`:''}</div>
        <div class="pp-card-actions">
          <button class="pp-btn ok" onclick="aprovarPedidoPagamento(${p.id})">✓ Aprovar</button>
          <button class="pp-btn no" onclick="mostrarRejPedido(${p.id})">✕ Rejeitar</button>
        </div>
        <div class="pp-rej-box" id="pp-rej-${p.id}" style="display:none">
          <input type="text" id="pp-rej-motivo-${p.id}" placeholder="Motivo (opcional)">
          <button class="pp-btn no" onclick="rejeitarPedidoPagamento(${p.id})">Confirmar</button>
        </div>
      </div>`;
    }).join('')+`</div>`;
}
function mostrarRejPedido(id){
  const box=document.getElementById('pp-rej-'+id);
  if(box)box.style.display=box.style.display==='none'?'flex':'none';
}
async function aprovarPedidoPagamento(id){
  if(!isAdmin())return;
  const p=(db.pedidosPagamento||[]).find(x=>x.id===id);if(!p)return;
  try{
    // marca primeiro, lança depois — uma falha a meio deixa o pedido pendente,
    // nunca dinheiro lançado sem o pedido saber (mesma ordem do aprovarPagPend do FestasBV)
    const upd=await sbReq('PATCH',`pedidos_pagamento?id=eq.${id}&estado=eq.pendente`,
      {estado:'aprovado',decidido_por:_sbSession.user.email,decidido_em:new Date().toISOString()},
      {Prefer:'return=representation'});
    if(!upd||!upd.length){toast('Este pedido já tinha sido decidido.',1);renderPedidosPagamentoAdmin();return;}
    if(p.jogoIds.length)await sbReq('POST','pagos_jogo',p.jogoIds.map(jogo_id=>({jogo_id,amigo_id:p.amigoId})),{Prefer:'resolution=merge-duplicates'});
  }catch(e){toast('Erro ao aprovar: '+e.message,1);return;}
  p.estado='aprovado';
  p.jogoIds.forEach(jogoId=>{
    const k=String(jogoId);
    if(!db.pagosPorJogo[k])db.pagosPorJogo[k]=[];
    if(!db.pagosPorJogo[k].includes(p.amigoId))db.pagosPorJogo[k].push(p.amigoId);
  });
  renderPedidosPagamentoAdmin();rDash();renderJogosList();
  toast('Pedido aprovado ✓');
}
async function rejeitarPedidoPagamento(id){
  if(!isAdmin())return;
  const motivo=document.getElementById('pp-rej-motivo-'+id)?.value.trim()||'';
  try{
    const upd=await sbReq('PATCH',`pedidos_pagamento?id=eq.${id}&estado=eq.pendente`,
      {estado:'rejeitado',decidido_por:_sbSession.user.email,decidido_em:new Date().toISOString(),motivo},
      {Prefer:'return=representation'});
    if(!upd||!upd.length){toast('Este pedido já tinha sido decidido.',1);renderPedidosPagamentoAdmin();return;}
  }catch(e){toast('Erro ao rejeitar: '+e.message,1);return;}
  const p=(db.pedidosPagamento||[]).find(x=>x.id===id);
  if(p){p.estado='rejeitado';p.motivo=motivo;}
  renderPedidosPagamentoAdmin();renderMeuPedidoBox();
  toast('Pedido rejeitado');
}

// ── Lado do membro: bloco no Resumo (debaixo dos cards) e nas Contas ──
function renderMeuPedidoBox(){
  const els=document.querySelectorAll('.meu-pedido-mount');
  if(!els.length)return;
  const meu=isAdmin()?null:meuAmigoNaEpoca();
  if(!meu){els.forEach(el=>el.innerHTML='');return;}

  const golosVal=db.config.valorPorGolo;
  const jogosPorPagar=db.jogos.filter(j=>{
    if(j.golos===null||j.golos===undefined||j.golos==='')return false;
    if(gJ(j)<=0)return false;
    return !jogoAmigoPago(j.id,meu.id);
  }).sort((a,b)=>new Date(b.data)-new Date(a.data));

  const meusPedidos=(db.pedidosPagamento||[]).filter(p=>p.amigoId===meu.id)
    .sort((a,b)=>new Date(b.criadoEm||0)-new Date(a.criadoEm||0));

  let html='<div class="meu-pag-box"><h3>💳 Já pagaste algum jogo?</h3>';
  if(!jogosPorPagar.length){
    html+='<p>Estás em dia — sem jogos por pagar.</p>';
  }else{
    html+='<p>Marca os que já pagaste e pede confirmação ao admin.</p>';
    html+='<div class="mp-lista">'+jogosPorPagar.map(j=>{
      const d=new Date(j.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short'});
      const val=(gJ(j)*golosVal).toFixed(2);
      return`<label class="meu-pag-jogo">
        <input type="checkbox" value="${j.id}" class="mp-chk">
        <div class="meu-pag-jogo-info"><div class="meu-pag-jogo-adv">vs ${j.adversario}</div><div class="meu-pag-jogo-meta">${d} · ${j.competicao}</div></div>
        <div class="meu-pag-jogo-val">${val}€</div>
      </label>`;
    }).join('')+'</div>';
    html+='<button class="btn btn-g" style="margin-top:10px;width:100%" onclick="submeterPedidoPagamento()">Já paguei os selecionados</button>';
  }
  if(meusPedidos.length){
    html+='<div class="divi" style="margin:12px 0"></div><div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--mu);margin-bottom:6px">Os teus pedidos</div>';
    html+=meusPedidos.map(p=>{
      const nomes=p.jogoIds.map(id=>{const j=db.jogos.find(x=>x.id===id);return j?`vs ${j.adversario}`:null;}).filter(Boolean).join(', ');
      const stTxt=p.estado==='pendente'?'🕓 Pendente':p.estado==='aprovado'?'✓ Aprovado':'✕ Rejeitado';
      return`<div class="pp-card" style="background:#fff">
        <div class="pp-card-head"><span class="pp-status ${p.estado}">${stTxt}</span><span class="pp-card-val">${p.valor.toFixed(2)}€</span></div>
        <div class="pp-card-jogos">${nomes}${p.estado==='rejeitado'&&p.motivo?`<br><em>Motivo: ${p.motivo}</em>`:''}</div>
        ${p.estado==='pendente'?`<div class="pp-card-actions"><button class="pp-btn cancel" onclick="cancelarPedidoPagamento(${p.id})">Cancelar</button></div>`:''}
      </div>`;
    }).join('');
  }
  html+='</div>';
  els.forEach(el=>el.innerHTML=html);
}

async function submeterPedidoPagamento(){
  const meu=meuAmigoNaEpoca();if(!meu)return;
  const ids=[...document.querySelectorAll('.mp-lista .mp-chk:checked')].map(cb=>parseInt(cb.value));
  if(!ids.length)return toast('Seleciona pelo menos um jogo',1);
  const valor=ids.reduce((a,id)=>{const j=db.jogos.find(x=>x.id===id);return a+(j?gJ(j)*db.config.valorPorGolo:0);},0);
  try{
    await sbReq('POST','pedidos_pagamento',{epoca_nome:epocaAtiva,amigo_id:meu.id,jogo_ids:ids,valor});
  }catch(e){toast('Erro ao enviar pedido: '+e.message,1);return;}
  toast('Pedido enviado — aguarda confirmação do admin ✓');
  const nomes=ids.map(id=>{const j=db.jogos.find(x=>x.id===id);return j?`vs ${j.adversario}`:null;}).filter(Boolean).join(', ');
  sbNotificarPagamentoDeclarado(meu.nome,valor,nomes); // fire-and-forget, não bloqueia UI
  await recarregarPedidosPagamento();
}
async function cancelarPedidoPagamento(id){
  if(!confirm('Cancelar este pedido?'))return;
  try{await sbReq('DELETE',`pedidos_pagamento?id=eq.${id}`);}
  catch(e){toast('Erro: '+e.message,1);return;}
  db.pedidosPagamento=(db.pedidosPagamento||[]).filter(p=>p.id!==id);
  renderMeuPedidoBox();
  toast('Pedido cancelado');
}
// Vai buscar de novo só os pedidos desta época (para o novo pedido ganhar o
// id/criado_em reais da BD, sem recarregar tudo o resto).
async function recarregarPedidosPagamento(){
  try{
    const rows=await sbReq('GET',`pedidos_pagamento?epoca_nome=eq.${encodeURIComponent(epocaAtiva)}&select=*&order=criado_em.desc`);
    db.pedidosPagamento=(rows||[]).map(p=>({id:p.id,amigoId:p.amigo_id,jogoIds:p.jogo_ids||[],valor:Number(p.valor)||0,nota:p.nota,estado:p.estado,criadoPorEmail:p.criado_por_email,criadoEm:p.criado_em,decididoPor:p.decidido_por,decididoEm:p.decidido_em,motivo:p.motivo}));
    if(dbFull.epocas[epocaAtiva])dbFull.epocas[epocaAtiva].pedidosPagamento=db.pedidosPagamento;
  }catch(e){}
  renderMeuPedidoBox();
  renderPedidosPagamentoAdmin();
}

/* ── GOLOS COUNTER (add form) ── */
let _golosAdd=null;
function ajustarGolos(d){
  if(_golosAdd===null)_golosAdd=0;
  _golosAdd=Math.max(0,_golosAdd+d);
  document.getElementById('cal-golos').value=_golosAdd;
  document.getElementById('cal-golos-display').textContent=_golosAdd;
  document.getElementById('btn-clear-golos').style.display='';
}
function limparGolos(){
  _golosAdd=null;
  document.getElementById('cal-golos').value='';
  document.getElementById('cal-golos-display').textContent='—';
  document.getElementById('btn-clear-golos').style.display='none';
}
function selLocal(btn){
  document.querySelectorAll('#cal-local-btns .local-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('cal-local').value=btn.dataset.val;
}
function limparFormAdd(){
  document.getElementById('cal-adv').value='';
  document.getElementById('cal-jorn').value='';
  document.querySelectorAll('#cal-local-btns .local-btn').forEach(b=>b.classList.remove('on'));
  const btnCasa=document.querySelector('#cal-local-btns .local-btn[data-val="Casa"]');
  if(btnCasa)btnCasa.classList.add('on');
  document.getElementById('cal-local').value='Casa';
  limparGolos();
}

async function addJogoCal(){
  if(roGuard())return;
  const data=document.getElementById('cal-data').value;
  const adv=document.getElementById('cal-adv').value.trim();
  const comp=document.getElementById('cal-comp').value;
  const jorn=document.getElementById('cal-jorn').value.trim();
  const local=document.getElementById('cal-local').value||'Casa';
  if(!data||!adv)return toast('Preenche data e adversário!',1);
  let ins;
  try{
    ins=await sbReq('POST','jogos',{epoca_nome:epocaAtiva,data,adversario:adv,competicao:comp,jornada:jorn,local,golos:null,resultado:''},{Prefer:'return=representation'});
  }catch(e){toast('Erro ao criar jogo: '+e.message,1);return;}
  const novo=ins&&ins[0];if(!novo)return;
  db.jogos.push({id:novo.id,data,adversario:adv,golos:null,resultado:'',competicao:comp,jornada:jorn,local});
  db.pagosPorJogo[String(novo.id)]=[];
  limparFormAdd();
  toast(`Jogo vs ${adv} agendado ✓`);
}

/* ── MODAL EDITAR JOGO ── */
let _editId=null;
let _golosEd=null;

function selLocalEd(btn){
  document.querySelectorAll('#ed-local-btns .local-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('ed-local').value=btn.dataset.val;
  autoCalcGolosEd();
}

function autoCalcGolosEd(){
  const res=document.getElementById('ed-res').value.trim();
  if(!res)return;
  const parts=res.split('-').map(s=>parseInt(s.trim()));
  if(parts.length!==2||isNaN(parts[0])||isNaN(parts[1]))return;
  const local=document.getElementById('ed-local').value;
  const golosSporting=(local==='Fora')?parts[1]:parts[0];
  _golosEd=golosSporting;
  document.getElementById('ed-golos').value=_golosEd;
  document.getElementById('ed-golos-display').textContent=_golosEd;
  document.getElementById('btn-clear-golos-ed').style.display='';
}

function abrirModalEditar(jogoId){
  const j=db.jogos.find(x=>x.id===jogoId);if(!j)return;
  _editId=jogoId;
  document.getElementById('ed-adv').value=j.adversario||'';
  document.getElementById('ed-data').value=j.data||'';
  document.getElementById('ed-jorn').value=j.jornada||'';
  document.getElementById('ed-res').value=j.resultado||'';
  // Local
  const localVal=j.local||'Casa';
  document.getElementById('ed-local').value=localVal;
  document.querySelectorAll('#ed-local-btns .local-btn').forEach(b=>{b.classList.toggle('on',b.dataset.val===localVal);});
  // Competição
  const selComp=document.getElementById('ed-comp');
  [...selComp.options].forEach(o=>o.selected=o.value===j.competicao);
  // Golos
  if(j.golos!==null&&j.golos!==undefined&&j.golos!==''){
    _golosEd=Number(j.golos);
    document.getElementById('ed-golos').value=_golosEd;
    document.getElementById('ed-golos-display').textContent=_golosEd;
    document.getElementById('btn-clear-golos-ed').style.display='';
  } else {
    _golosEd=null;
    document.getElementById('ed-golos').value='';
    document.getElementById('ed-golos-display').textContent='—';
    document.getElementById('btn-clear-golos-ed').style.display='none';
  }
  document.getElementById('modal-editar').style.display='flex';
  document.body.style.overflow='hidden';
}
function fecharModalEditar(e){
  if(e&&e.target!==document.getElementById('modal-editar'))return;
  document.getElementById('modal-editar').style.display='none';
  document.body.style.overflow='';
  _editId=null;
}
function ajustarGolosEd(d){
  if(_golosEd===null)_golosEd=0;
  _golosEd=Math.max(0,_golosEd+d);
  document.getElementById('ed-golos').value=_golosEd;
  document.getElementById('ed-golos-display').textContent=_golosEd;
  document.getElementById('btn-clear-golos-ed').style.display='';
}
function limparGolosEd(){
  _golosEd=null;
  document.getElementById('ed-golos').value='';
  document.getElementById('ed-golos-display').textContent='—';
  document.getElementById('btn-clear-golos-ed').style.display='none';
}
async function guardarEdicao(){
  if(roGuard())return;
  if(_editId===null)return;
  const j=db.jogos.find(x=>x.id===_editId);if(!j)return;
  const novo={
    adversario:document.getElementById('ed-adv').value.trim()||j.adversario,
    data:document.getElementById('ed-data').value||j.data,
    competicao:document.getElementById('ed-comp').value,
    jornada:document.getElementById('ed-jorn').value.trim(),
    resultado:document.getElementById('ed-res').value.trim(),
    local:document.getElementById('ed-local').value||'Casa'
  };
  const gv=document.getElementById('ed-golos').value;
  novo.golos=gv===''?null:parseInt(gv);
  try{
    await sbReq('PATCH',`jogos?id=eq.${j.id}`,novo);
  }catch(e){toast('Erro ao guardar: '+e.message,1);return;}
  const fechouAgora=!j.resultado&&novo.resultado; // 1ª vez que este jogo fica com resultado
  Object.assign(j,novo);
  if(fechouAgora)sbNotificarResultadoJogo(j.adversario,j.resultado,j.golos); // fire-and-forget, não bloqueia UI
  fecharModalEditar();
  // re-render: verificar se estamos no detalhe do jogo (usa style.display, não classes)
  const tJdetalhe=document.getElementById('t-jdetalhe');
  if(tJdetalhe&&tJdetalhe.style.display!=='none'&&tJdetalhe.style.display!==''){renderDetalhe(j);}
  else{rDash();renderJogosList();}
  toast(`Jogo vs ${j.adversario} actualizado ✓`);
}
async function remJogo(id){
  if(roGuard())return;
  if(!confirm('Remover este jogo?'))return;
  const antesJogos=db.jogos.slice(),antesPag=db.pagosPorJogo[String(id)];
  db.jogos=db.jogos.filter(j=>j.id!==id);
  delete db.pagosPorJogo[String(id)];
  try{await sbReq('DELETE',`jogos?id=eq.${id}`);}
  catch(e){db.jogos=antesJogos;if(antesPag)db.pagosPorJogo[String(id)]=antesPag;toast('Erro ao remover: '+e.message,1);return;}
  renderJogosList();toast('Jogo removido');
}

/* ── AMIGOS ─────────────────────────────────── */
function rAmigos(){rAmCfg();}
function rAmCfg(){
  document.getElementById('a-cfg').innerHTML=db.amigos.map((am,i)=>`
    <div class="arow"><div class="cdot" style="background:${am.cor}"><input type="color" value="${am.cor}" oninput="db.amigos[${i}].cor=this.value;this.parentElement.style.background=this.value"></div>
    <input class="ni" type="text" value="${am.nome}" oninput="db.amigos[${i}].nome=this.value" placeholder="Nome">
    <button class="jdel" onclick="remAmigo(${am.id})">✕</button></div>`).join('');
}
// Amigos novos (ainda sem id real da BD) recebem um id temporário negativo,
// para se distinguir dos que já existem — guardarAmigos() é que faz a
// diferença entre POST (id<0) e PATCH (id>0), tudo de uma vez.
let _amigoTmpSeq=-1;
let _amigosRemovidosIds=[];
function addAmigo(){
  if(roGuard())return;
  db.amigos.push({id:_amigoTmpSeq--,nome:'Novo amigo',cor:CORES[db.amigos.length%CORES.length]});
  rAmCfg();setTimeout(()=>{const ins=document.querySelectorAll('.ni');ins[ins.length-1]?.select();},50);
}
function remAmigo(id){
  if(roGuard())return;
  if(db.amigos.length<=1)return toast('Tem de ficar pelo menos um!',1);
  if(!confirm('Remover?'))return;
  db.amigos=db.amigos.filter(a=>a.id!==id);
  if(id>0)_amigosRemovidosIds.push(id); // só apaga na BD o que já lá estava
  rAmCfg();
}
async function guardarAmigos(){
  if(roGuard())return;
  try{
    if(_amigosRemovidosIds.length){
      await sbReq('DELETE',`amigos?id=in.(${_amigosRemovidosIds.join(',')})`);
      _amigosRemovidosIds=[];
    }
    const existentes=db.amigos.filter(a=>a.id>0);
    for(const a of existentes)await sbReq('PATCH',`amigos?id=eq.${a.id}`,{nome:a.nome,cor:a.cor});
    const novos=db.amigos.filter(a=>a.id<0);
    if(novos.length){
      const ins=await sbReq('POST','amigos',novos.map((a,i)=>({epoca_nome:epocaAtiva,nome:a.nome,cor:a.cor,ordem:existentes.length+i})),{Prefer:'return=representation'});
      novos.forEach((a,i)=>{if(ins&&ins[i])a.id=ins[i].id;});
    }
  }catch(e){toast('Erro ao guardar amigos: '+e.message,1);return;}
  toast('Amigos guardados ✓');
}

// Histórico: lista todos os jogos com quem pagou/não pagou
function rHistPag(){
  const el=document.getElementById('h-pag');
  const jogos=[...db.jogos].sort((a,b)=>new Date(b.data)-new Date(a.data));
  if(!jogos.length){el.innerHTML='<div class="empty"><em>⚽</em>Sem jogos</div>';return;}
  el.innerHTML=jogos.map(j=>{
    const pag=db.pagosPorJogo[String(j.id)]||[];
    const nd=new Date(j.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short'});
    return`<div class="pi" style="flex-wrap:wrap;gap:8px;cursor:pointer" onclick="abrirDetalhe(${j.id})">
      <div class="pi-info" style="min-width:160px"><div class="pi-nome">${j.adversario}</div><div class="pi-meta">${nd} · ${j.jornada||j.competicao} · ${j.golos||0} golos</div></div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;flex:1">
        ${db.amigos.map(am=>{const p=pag.includes(am.id);return`<span style="font-size:11px;padding:2px 8px;border-radius:99px;background:${p?am.cor:'#eee'};color:${p?'#fff':'var(--mu)'};font-weight:600">${ini(am.nome)}</span>`;}).join('')}
      </div>
      <div class="pi-val">${pag.length}/${db.amigos.length}</div>
    </div>`;
  }).join('');
}

async function criarNovaEpoca(){
  if(roGuard())return;
  // Sugerir o nome seguinte automaticamente (ex: se temos 2025/26, sugere 2026/27)
  let sugestao='';
  if(epocasOrdem.length){
    const ultima=epocasOrdem[epocasOrdem.length-1];
    const m=ultima.match(/^(\d{4})\/(\d{2})$/);
    if(m){
      const a1=parseInt(m[1])+1;
      const a2=(parseInt(m[2])+1).toString().padStart(2,'0');
      sugestao=`${a1}/${a2}`;
    }
  }
  const nome=prompt('Nome da nova época (ex: 2026/27):',sugestao);
  if(!nome||!nome.trim())return;
  const nomeF=nome.trim();
  if(dbFull.epocas[nomeF]){toast(`A época "${nomeF}" já existe!`,1);return;}
  // Perguntar se copia amigos da época actual
  const copiar=db.amigos.length&&confirm(`Copiar os ${db.amigos.length} amigos da época actual para a nova época?`);
  try{await sbReq('POST','epocas',{nome:nomeF});}
  catch(e){toast('Erro ao criar época: '+e.message,1);return;}
  let amigosIniciais=[];
  if(copiar){
    try{
      const ins=await sbReq('POST','amigos',db.amigos.map((a,i)=>({epoca_nome:nomeF,nome:a.nome,cor:a.cor,ordem:i})),{Prefer:'return=representation'});
      amigosIniciais=(ins||[]).map(a=>({id:a.id,nome:a.nome,cor:a.cor}));
    }catch(e){toast('Época criada, mas falhou copiar os amigos: '+e.message,1);}
  }
  dbFull.epocas[nomeF]={amigos:amigosIniciais,jogos:[],pagosPorJogo:{},estouros:[],estouroPagos:[],creditosExtra:[],poteHolder:null};
  actualizarEpocasOrdem();
  // Navegar para a nova época
  epocaAtiva=nomeF;
  dbFull.config.epocaAtiva=epocaAtiva;
  sincEpoca();
  atualizarLabelEpoca();
  rCfg();rDash();renderJogosList();
  toast(`Época "${nomeF}" criada ✓`);
}


function rCfg(){
  document.getElementById('c-ep').value=epocaAtiva;
  document.getElementById('c-vg').value=dbFull.config.valorPorGolo||1;
  rAmCfg();
  const mb=document.getElementById('migracao-box');
  if(mb)mb.style.display=Object.keys(dbFull.epocas||{}).length?'none':'block';
  // Refresca pedidos/ligações/contas sempre que se entra em Definições — antes só
  // era feito uma vez, logo após o login, e ficava desatualizado sem recarregar a app.
  if(isAdmin()){sbRenderPedidos();sbRenderLigacoes();sbRenderPassTemp();}
}
async function guardarCfg(){
  if(roGuard())return;
  const novoValor=parseFloat(document.getElementById('c-vg').value)||1;
  try{await sbReq('PATCH','config?chave=eq.valor_por_golo',{valor:String(novoValor)});}
  catch(e){toast('Erro ao guardar: '+e.message,1);return;}
  dbFull.config.valorPorGolo=novoValor;
  db.config={valorPorGolo:novoValor,epoca:epocaAtiva};
  await guardarAmigos();
  toast('Configurações guardadas ✓');
}
// Cópia de segurança local (só leitura) — os dados vivem no Supabase.
function expJSON(){
  const b=new Blob([JSON.stringify(dbFull,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='golos-backup.json';a.click();
  toast('Cópia local descarregada ✓');
}


/* ── EXPORTAR DÍVIDAS ─────────────────────────────────── */
function exportarDividas(){
  const amigosComDivida=db.amigos.filter(am=>dividaAmigo(am.id)>0);
  if(!amigosComDivida.length){toast('Sem dívidas para exportar!');return;}

  const jogosOrdenados=[...db.jogos]
    .filter(j=>j.golos!==null&&j.golos!==undefined&&j.golos!=='')
    .sort((a,b)=>new Date(a.data)-new Date(b.data));

  const dataHoje=new Date().toLocaleDateString('pt-PT',{day:'2-digit',month:'long',year:'numeric'});
  const epoca=db.config.epoca||'';

  const rows=amigosComDivida.map(am=>{
    const divida=dividaAmigo(am.id);
    const jogosPorPagar=jogosOrdenados.filter(j=>{
      const pag=db.pagosPorJogo[String(j.id)]||[];
      return gJ(j)>0 && !pag.includes(am.id);
    });
    const linhas=jogosPorPagar.map(j=>{
      const dt=new Date(j.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'});
      const val=(gJ(j)*db.config.valorPorGolo).toFixed(2);
      return `<tr><td>${dt}</td><td>Sporting vs ${j.adversario}</td><td>${j.competicao}${j.jornada?' · '+j.jornada:''}</td><td class="num">${gJ(j)} golo${gJ(j)!==1?'s':''}</td><td class="num money">${val}€</td></tr>`;
    }).join('');
    return `
      <div class="amigo-block">
        <div class="amigo-header">
          <div class="amigo-avatar" style="background:${am.cor}">${ini(am.nome)}</div>
          <div class="amigo-info">
            <div class="amigo-nome">${am.nome}</div>
            <div class="amigo-sub">${jogosPorPagar.length} jogo${jogosPorPagar.length!==1?'s':''} por pagar</div>
          </div>
          <div class="amigo-total">${divida.toFixed(2)}€</div>
        </div>
        <table class="jogos-table">
          <thead><tr><th>Data</th><th>Jogo</th><th>Competição</th><th class="num">Golos</th><th class="num">Valor</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>`;
  }).join('');

  const html=`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<title>Dívidas Sporting ${epoca}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#f4f4f0;color:#1a1a1a;padding:32px 24px;max-width:800px;margin:0 auto}
  @media print{body{background:#fff;padding:16px}}
  .doc-header{background:#047e57;color:#fff;border-radius:16px;padding:28px 32px;margin-bottom:28px;display:flex;align-items:center;gap:20px}
  .doc-icon{font-size:48px;line-height:1}
  .doc-title{font-size:28px;font-weight:800;letter-spacing:-.3px}
  .doc-sub{font-size:14px;opacity:.75;margin-top:4px}
  .doc-meta{margin-left:auto;text-align:right;font-size:13px;opacity:.8}
  .amigo-block{background:#fff;border-radius:14px;border:1px solid #e0deda;overflow:hidden;margin-bottom:18px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
  .amigo-header{display:flex;align-items:center;gap:16px;padding:18px 22px;border-bottom:2px solid #f4f4f0;background:linear-gradient(135deg,#f9fffe,#fff)}
  .amigo-avatar{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff;flex-shrink:0}
  .amigo-info{flex:1}
  .amigo-nome{font-size:18px;font-weight:700}
  .amigo-sub{font-size:12px;color:#888;margin-top:2px}
  .amigo-total{font-size:26px;font-weight:800;color:#c62828;font-variant-numeric:tabular-nums}
  .jogos-table{width:100%;border-collapse:collapse;font-size:13px}
  .jogos-table thead th{background:#f8f8f6;padding:9px 14px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#888;border-bottom:1px solid #ece9e4}
  .jogos-table tbody td{padding:10px 14px;border-bottom:1px solid #f0ede8;vertical-align:middle}
  .jogos-table tbody tr:last-child td{border-bottom:none}
  .jogos-table tbody tr:hover{background:#fafaf7}
  .jogos-table tfoot td{padding:10px 14px;background:#fafaf7;border-top:2px solid #e0deda}
  .num{text-align:right}
  .money{font-weight:700;color:#047e57;font-variant-numeric:tabular-nums}
  .total-row{color:#c62828 !important;font-size:15px}
  .footer{text-align:center;font-size:11px;color:#aaa;margin-top:28px;padding-top:16px;border-top:1px solid #e8e8e4}
</style>
</head>
<body>
  <div class="doc-header">
    <div class="doc-icon">🦁</div>
    <div>
      <div class="doc-title">Dívidas do Pote</div>
      <div class="doc-sub">Sporting CP · Época ${epoca} · ${db.config.valorPorGolo}€ por golo</div>
    </div>
    <div class="doc-meta">Gerado em<br><strong>${dataHoje}</strong></div>
  </div>
  ${rows}
  <div class="footer">Gerado pela app Golos do Sporting 🦁 · ${dataHoje}</div>
</body>
</html>`;

  const w=window.open('','_blank');
  w.document.write(html);
  w.document.close();
  setTimeout(()=>w.print(),400);
}

/* ── COLLAPSIBLE SECTIONS ───────────────────── */
function toggleSection(id,hdr){
  const body=document.getElementById(id);
  const arrow=document.getElementById(id+'-arrow');
  const open=body.style.display==='none'||body.style.display==='';
  body.style.display=open?'block':'none';
  if(arrow)arrow.style.transform=open?'rotate(0deg)':'rotate(-90deg)';
}

/* ── TOAST ─────────────────────────────────── */
let ttm;
function toast(msg,err){
  clearTimeout(ttm);const t=document.getElementById('toast');
  t.textContent=msg;t.style.background=err?'var(--dg)':'var(--vd)';
  t.classList.add('on');ttm=setTimeout(()=>t.classList.remove('on'),3000);
}

/* ── ESTOURO DOS GOLOS ────────────────────────── */

function estSharePorPessoa(amigoId){
  return (db.estouros||[]).reduce((acc,ev)=>{
    if((ev.participantes||[]).includes(amigoId)){
      const nP=(ev.participantes||[]).length||1;
      return acc+((ev.valor||0)/nP);
    }
    return acc;
  },0);
}

function estPagouEventos(amigoId){
  return (db.estouros||[]).reduce((a,ev)=>a+(ev.pagoPor===amigoId?(ev.valor||0):0),0);
}

function estTotalEventos(){
  return (db.estouros||[]).reduce((a,ev)=>a+(ev.valor||0),0);
}

function estSaldoPessoa(amigoId){
  const share=estSharePorPessoa(amigoId);
  const potePago=pagouAmigo(amigoId);
  const eventosPagos=estPagouEventos(amigoId);
  const totalCreditos=(db.creditosExtra||[]).reduce((a,c)=>a+(c.valor||0),0);
  const creditShare=totalCreditos/(db.amigos.length||1);
  // Pote holder: recolheu o dinheiro de todos + créditos extra
  let poteRecolhido=0;
  if(db.poteHolder&&db.poteHolder===amigoId){
    const totalPotePago=db.amigos.reduce((a,am)=>a+pagouAmigo(am.id),0);
    poteRecolhido=totalPotePago+totalCreditos;
  }
  return share-potePago-eventosPagos-creditShare+poteRecolhido;
}

function estDeveAQuem(amigoId){
  const devidas={};
  (db.estouros||[]).forEach(ev=>{
    if(!(ev.participantes||[]).includes(amigoId))return;
    if(ev.pagoPor===amigoId)return;
    if(!ev.pagoPor)return;
    const nP=(ev.participantes||[]).length||1;
    const quota=(ev.valor||0)/nP;
    devidas[ev.pagoPor]=(devidas[ev.pagoPor]||0)+quota;
  });
  return devidas;
}

function rEstouro(){
  if(!db.estouros)db.estouros=[];
  if(!db.estouroPagos)db.estouroPagos=[];
  if(!db.creditosExtra)db.creditosExtra=[];
  const n=db.amigos.length||1;
  const vg=db.config.valorPorGolo;
  const poteBruto=totalGolos()*vg*n;
  const totalCreditos=(db.creditosExtra||[]).reduce((a,c)=>a+(c.valor||0),0);
  const poteTotal=poteBruto+totalCreditos;
  const totalEv=estTotalEventos();
  const excedente=Math.max(0,totalEv-poteTotal);
  const sobra=Math.max(0,poteTotal-totalEv);

  // Helper: valor arredondado + exacto pequenino se diferente
  function scVal(v){
    const r=Math.round(v);
    const exact=v.toFixed(2);
    const diff=Math.abs(v-r)>0.004;
    return`${r}€${diff?`<span style="font-family:'Inter',sans-serif;font-size:11px;color:#aaa;font-weight:400;margin-left:4px">${exact}€</span>`:''}`;
  }

  let cardsHTML=`
    <div class="sc cg"><div class="sc-l">Pote total</div><div class="sc-v">${scVal(poteBruto)}</div><div class="sc-s">${totalGolos()} golos × ${n} amigos × ${vg}€</div></div>`;
  if(totalCreditos>0){
    cardsHTML+=`<div class="sc cb"><div class="sc-l">Créditos extra</div><div class="sc-v">${scVal(totalCreditos)}</div><div class="sc-s">${db.creditosExtra.length} crédito${db.creditosExtra.length!==1?'s':''} · Pote final: ${scVal(poteTotal)}</div></div>`;
  }
  cardsHTML+=`
    <div class="sc cr"><div class="sc-l">Gasto em eventos</div><div class="sc-v">${scVal(totalEv)}</div><div class="sc-s">${db.estouros.length} evento${db.estouros.length!==1?'s':''}</div></div>
    <div class="sc ${excedente>0?'co':'cb'}"><div class="sc-l">${excedente>0?'Excedente':'Sobra no pote'}</div><div class="sc-v">${scVal(excedente>0?excedente:sobra)}</div><div class="sc-s">${excedente>0?'eventos custaram mais que o pote':'ainda por gastar'}</div></div>
  `;
  document.getElementById('estouro-stat-cards').innerHTML=cardsHTML;

  // Pote holder
  const phEl=document.getElementById('estouro-pote-holder');
  const holderAm=db.poteHolder?db.amigos.find(a=>a.id===db.poteHolder):null;
  const holderOpts=db.amigos.map(am=>`<option value="${am.id}"${am.id===db.poteHolder?' selected':''}>${am.nome}</option>`).join('');
  phEl.innerHTML=`<div style="background:var(--oup);border:1px solid #ffe082;border-radius:var(--r);padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-size:13px;font-weight:600;color:#7b5e00">💰 Quem levantou o pote?</span>
    <select class="pote-holder-select ro-hide" onchange="setPoteHolder(parseInt(this.value)||null)">
      <option value="">— Ninguém —</option>${holderOpts}
    </select>
    ${isReadOnly&&holderAm?`<span style="font-size:12px;color:#5d4037;font-weight:500">${holderAm.nome}</span>`:''}
  </div>`;

  // Créditos extra section
  rCreditosExtra();

  rEstouroEventos();

  const balEl=document.getElementById('estouro-balanco');
  if(!db.estouros.length){balEl.innerHTML='';return;}

  // Verificar se todos os devedores estão acertados → credores ficam auto-acertados
  const allDebtorsSettled=db.amigos.every(am=>{
    const s=estSaldoPessoa(am.id);
    if(s>0.01) return (db.estouroPagos||[]).includes(am.id);
    return true;
  });

  // Dívida pendente (devedores ainda não acertados) e crédito total
  const totalPendingDebt=db.amigos.reduce((a,am)=>{
    const s=estSaldoPessoa(am.id);
    return(s>0.01&&!(db.estouroPagos||[]).includes(am.id))?a+s:a;
  },0);
  const totalCreditAbs=db.amigos.reduce((a,am)=>{
    const s=estSaldoPessoa(am.id);
    return s<-0.01?a+Math.abs(s):a;
  },0);

  const blocks=db.amigos.map(am=>{
    const share=estSharePorPessoa(am.id);
    const potePago=pagouAmigo(am.id);
    const eventosPagos=estPagouEventos(am.id);
    const creditShare=totalCreditos/(db.amigos.length||1);
    // Pote holder: recolheu o dinheiro de todos + créditos extra
    let poteRecolhido=0;
    if(db.poteHolder&&db.poteHolder===am.id){
      const totalPotePago=db.amigos.reduce((a,a2)=>a+pagouAmigo(a2.id),0);
      poteRecolhido=totalPotePago+totalCreditos;
    }
    const saldo=share-potePago-eventosPagos-creditShare+poteRecolhido;
    const estPagoFlag=(db.estouroPagos||[]).includes(am.id);
    // Credor auto-acertado: se todos os devedores já pagaram
    const autoSettled=(saldo<-0.01&&allDebtorsSettled);
    const isSettled=estPagoFlag||autoSettled;

    // Para credores: valor a receber diminui à medida que devedores pagam
    const receivable=(saldo<-0.01&&totalCreditAbs>0.01)?totalPendingDebt*(Math.abs(saldo)/totalCreditAbs):0;

    const evRows=(db.estouros||[]).map(ev=>{
      const participa=(ev.participantes||[]).includes(am.id);
      if(!participa)return'';
      const nP=(ev.participantes||[]).length||1;
      const quota=(ev.valor||0)/nP;
      const pagador=ev.pagoPor?db.amigos.find(a=>a.id===ev.pagoPor):null;
      const pagadorLabel=pagador?(ev.pagoPor===am.id?'(tu pagaste)':'→ '+pagador.nome):'';
      return`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;color:var(--mu)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ev.nome}</span>
        ${pagadorLabel?`<span style="font-size:10px;margin:0 6px;opacity:.7">${pagadorLabel}</span>`:''}
        <span style="font-weight:600;color:var(--tx);flex-shrink:0">${quota.toFixed(2)}€</span>
      </div>`;
    }).filter(Boolean).join('');

    let statusLabel,statusCls;
    if(isSettled){
      statusLabel='✓ Acertado';statusCls='est-bal-zero';
    } else if(saldo>0.01){
      const devidas=estDeveAQuem(am.id);
      const credores=Object.entries(devidas).map(([cId])=>{
        const cr=db.amigos.find(a=>a.id===parseInt(cId));
        return cr?cr.nome:'?';
      });
      statusLabel=`deve ${saldo.toFixed(2)}€`;statusCls='est-bal-pos';
      if(credores.length)statusLabel+=` a ${credores.join(', ')}`;
    } else if(saldo<-0.01){
      statusLabel=`a receber ${receivable.toFixed(2)}€`;statusCls='est-bal-neg';
    } else {
      statusLabel='✓ Acertado';statusCls='est-bal-zero';
    }

    // Só mostra botão "Marcar acertado" para quem DEVE (saldo positivo)
    // Quem tem dinheiro a receber (saldo negativo) fica acertado à medida que os outros pagam
    const btnHTML=(saldo>0.01&&!isSettled)?
      `<button class="est-paid-btn unpaid ro-hide" onclick="event.stopPropagation();toggleEstouroPago(${am.id})">Marcar acertado</button>`:
      (estPagoFlag?`<button class="est-paid-btn paid ro-hide" onclick="event.stopPropagation();toggleEstouroPago(${am.id})">Acertado ✓</button>`:'');

    // Linhas de detalhe com espaçamento uniforme
    const detailLineStyle='display:flex;justify-content:space-between;padding:4px 0;font-size:12px;font-weight:600';

    // Display saldo: negate (negative=owes, positive=owed)
    const displaySaldo=-saldo;

    return`<div class="est-person-block${isSettled?' est-settled':''}">
      <div class="est-person-head" onclick="this.parentElement.classList.toggle('open')">
        <div class="av" style="background:${am.cor};width:30px;height:30px;font-size:10px;flex-shrink:0">${ini(am.nome)}</div>
        <div style="flex:1;min-width:0">
          <span style="font-weight:600;font-size:14px">${am.nome}</span>
          <div style="font-size:10px;color:var(--mu);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${statusLabel}</div>
        </div>
        <div class="est-bal-val ${statusCls}">${isSettled?'0.00':(saldo<-0.01?receivable.toFixed(2):saldo.toFixed(2))}€</div>
      </div>
      <div class="est-person-body">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--mu);margin-bottom:6px">Detalhe</div>
        ${evRows}
        <div style="${detailLineStyle};margin-top:4px;border-top:1px solid var(--bo);padding-top:6px">
          <span>Total eventos</span><span style="color:var(--dg)">−${share.toFixed(2)}€</span>
        </div>
        <div style="${detailLineStyle};color:var(--vd)">
          <span>Pago do pote</span><span>+${potePago.toFixed(2)}€</span>
        </div>
        ${creditShare>0?`<div style="${detailLineStyle};color:var(--in)">
          <span>Créditos extra</span><span>+${creditShare.toFixed(2)}€</span>
        </div>`:''}
        ${eventosPagos>0?`<div style="${detailLineStyle};color:var(--vd)">
          <span>Eventos pagos por ti</span><span>+${eventosPagos.toFixed(2)}€</span>
        </div>`:''}
        ${poteRecolhido>0?`<div style="${detailLineStyle};color:var(--ou)">
          <span>Recolha do pote</span><span>−${poteRecolhido.toFixed(2)}€</span>
        </div>`:''}
        <div style="display:flex;justify-content:space-between;padding:6px 0 0;margin-top:4px;border-top:2px solid var(--bo);font-size:13px;font-weight:700">
          <span>Saldo</span><span class="${statusCls}">${displaySaldo>0.01?'+':''}${displaySaldo.toFixed(2)}€</span>
        </div>
        <div style="margin-top:10px;text-align:right">${btnHTML}</div>
      </div>
    </div>`;
  }).join('');

  const totalDevem=db.amigos.reduce((a,am)=>{
    if((db.estouroPagos||[]).includes(am.id))return a;
    const s=estSaldoPessoa(am.id);return s>0?a+s:a;
  },0);

  balEl.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 10px">
      <h2 class="stit" style="margin:0">Balanço por pessoa</h2>
    </div>
    ${blocks}
  `;
}

function rEstouroEventos(){
  const el=document.getElementById('estouro-eventos-list');
  if(!db.estouros||!db.estouros.length){
    el.innerHTML='<div style="text-align:center;padding:20px;color:var(--mu);font-size:12px">Nenhum evento adicionado. Carrega no <strong style="color:var(--vd)">＋</strong> para criar.</div>';
    return;
  }
  const evs=[...db.estouros].sort((a,b)=>new Date(b.data||0)-new Date(a.data||0));
  el.innerHTML=evs.map(ev=>{
    const d=ev.data?new Date(ev.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'}):'';
    const parts=(ev.participantes||[]).map(pid=>{
      const am=db.amigos.find(a=>a.id===pid);
      return am?`<div class="est-ev-dot" style="background:${am.cor}" title="${am.nome}">${ini(am.nome)}</div>`:'';
    }).join('');
    const nP=(ev.participantes||[]).length;
    const perPerson=nP>0?((ev.valor||0)/nP).toFixed(2):'0.00';
    const pagador=ev.pagoPor?db.amigos.find(a=>a.id===ev.pagoPor):null;
    const pagadorLabel=pagador?`pago por ${pagador.nome}`:'';
    const clickable=!isReadOnly;
    return`<div class="est-ev" onclick="${clickable?'abrirModalEstouro('+ev.id+')':''}" style="${clickable?'cursor:pointer':''}">
      <div class="est-ev-head">
        <div style="flex:1;min-width:0">
          <div class="est-ev-name">${ev.nome||'Evento'}</div>
          <div class="est-ev-meta">${d}${d&&pagadorLabel?' · ':''}${pagadorLabel}${(d||pagadorLabel)?' · ':''}${nP} pessoa${nP!==1?'s':''} · ${perPerson}€/pessoa</div>
        </div>
        <div class="est-ev-val">${(ev.valor||0).toFixed(2)}€</div>
      </div>
      <div class="est-ev-parts">${parts}</div>
    </div>`;
  }).join('');
}

async function toggleEstouroPago(amigoId){
  if(roGuard())return;
  if(!db.estouroPagos)db.estouroPagos=[];
  const jaEstava=db.estouroPagos.includes(amigoId);
  if(jaEstava)db.estouroPagos=db.estouroPagos.filter(id=>id!==amigoId);
  else db.estouroPagos.push(amigoId);
  try{
    if(jaEstava)await sbReq('DELETE',`estouro_pagos?amigo_id=eq.${amigoId}`);
    else await sbReq('POST','estouro_pagos',{amigo_id:amigoId},{Prefer:'resolution=merge-duplicates'});
  }catch(e){
    if(jaEstava)db.estouroPagos.push(amigoId);else db.estouroPagos=db.estouroPagos.filter(id=>id!==amigoId);
    toast('Erro: '+e.message,1);return;
  }
  rEstouro();
  const am=db.amigos.find(a=>a.id===amigoId);
  toast(`${am?.nome} ${db.estouroPagos.includes(amigoId)?'marcado como acertado ✓':'reaberto'}`);
}

async function remEstouroFromModal(){
  if(roGuard())return;
  if(_estEditId===null)return;
  if(!confirm('Remover este evento?'))return;
  const antes=db.estouros;
  db.estouros=(db.estouros||[]).filter(e=>e.id!==_estEditId);
  try{await sbReq('DELETE',`estouros?id=eq.${_estEditId}`);}
  catch(e){db.estouros=antes;toast('Erro ao remover: '+e.message,1);return;}
  fecharModalEstouro();rEstouro();
  toast('Evento removido');
}

/* ── MODAL ADD/EDIT ESTOURO ── */
let _estEditId=null;
let _estIsNew=false;

function _fillPagoporSelect(selectedId){
  const sel=document.getElementById('ested-pagopor');
  sel.innerHTML='<option value="">— Selecionar —</option>'+
    db.amigos.map(am=>`<option value="${am.id}"${am.id===selectedId?' selected':''}>${am.nome}</option>`).join('');
}

function abrirModalAddEstouro(){
  if(roGuard())return;
  _estEditId=null;_estIsNew=true;
  document.getElementById('modal-estouro-title').textContent='🎉 Novo evento';
  document.getElementById('modal-estouro-save').textContent='Criar evento';
  document.getElementById('modal-estouro-save').onclick=criarEstouroFromModal;
  document.getElementById('modal-estouro-del').style.display='none';
  document.getElementById('ested-nome').value='';
  document.getElementById('ested-data').value=new Date().toISOString().split('T')[0];
  document.getElementById('ested-valor').value='';
  _fillPagoporSelect(null);
  const el=document.getElementById('ested-participantes');
  el.innerHTML=db.amigos.map(am=>`<label class="est-pchk">
    <input type="checkbox" value="${am.id}" checked>
    <div class="av" style="background:${am.cor};width:22px;height:22px;font-size:8px;flex-shrink:0">${ini(am.nome)}</div>
    <span style="font-size:13px">${am.nome}</span>
  </label>`).join('');
  document.getElementById('modal-estouro').style.display='flex';
  document.body.style.overflow='hidden';
}

async function criarEstouroFromModal(){
  if(roGuard())return;
  const nome=document.getElementById('ested-nome').value.trim();
  const data=document.getElementById('ested-data').value;
  const valor=parseFloat(document.getElementById('ested-valor').value)||0;
  const pagoPor=parseInt(document.getElementById('ested-pagopor').value)||null;
  if(!nome)return toast('Dá um nome ao evento!',1);
  if(valor<=0)return toast('O custo tem de ser superior a 0€!',1);
  if(!pagoPor)return toast('Indica quem pagou o evento!',1);
  const participantes=[];
  document.querySelectorAll('#ested-participantes input[type=checkbox]:checked').forEach(cb=>{
    participantes.push(parseInt(cb.value));
  });
  if(!participantes.length)return toast('Seleciona pelo menos um participante!',1);
  let ins;
  try{
    ins=await sbReq('POST','estouros',{epoca_nome:epocaAtiva,nome,data,valor,pago_por:pagoPor},{Prefer:'return=representation'});
    const evId=ins&&ins[0]&&ins[0].id;
    if(evId)await sbReq('POST','estouro_participantes',participantes.map(amigo_id=>({estouro_id:evId,amigo_id})));
  }catch(e){toast('Erro ao criar evento: '+e.message,1);return;}
  const novo=ins&&ins[0];if(!novo)return;
  if(!db.estouros)db.estouros=[];
  db.estouros.push({id:novo.id,nome,data,valor,participantes,pagoPor});
  fecharModalEstouro();
  toast(`Evento "${nome}" adicionado ✓`);
  rEstouro();
}

function abrirModalEstouro(id){
  const ev=(db.estouros||[]).find(e=>e.id===id);if(!ev)return;
  _estEditId=id;_estIsNew=false;
  document.getElementById('modal-estouro-title').textContent='✏️ Editar evento';
  document.getElementById('modal-estouro-save').textContent='Guardar alterações';
  document.getElementById('modal-estouro-save').onclick=guardarEstouroEdicao;
  document.getElementById('modal-estouro-del').style.display='';
  document.getElementById('ested-nome').value=ev.nome||'';
  document.getElementById('ested-data').value=ev.data||'';
  document.getElementById('ested-valor').value=ev.valor||'';
  _fillPagoporSelect(ev.pagoPor||null);
  const el=document.getElementById('ested-participantes');
  el.innerHTML=db.amigos.map(am=>{
    const checked=(ev.participantes||[]).includes(am.id)?'checked':'';
    return`<label class="est-pchk">
      <input type="checkbox" value="${am.id}" ${checked}>
      <div class="av" style="background:${am.cor};width:22px;height:22px;font-size:8px;flex-shrink:0">${ini(am.nome)}</div>
      <span style="font-size:13px">${am.nome}</span>
    </label>`;
  }).join('');
  document.getElementById('modal-estouro').style.display='flex';
  document.body.style.overflow='hidden';
}

function fecharModalEstouro(e){
  if(e&&e.target!==document.getElementById('modal-estouro'))return;
  document.getElementById('modal-estouro').style.display='none';
  document.body.style.overflow='';
  _estEditId=null;_estIsNew=false;
}
function estedToggleAll(on){
  document.querySelectorAll('#ested-participantes input[type=checkbox]').forEach(cb=>cb.checked=on);
}
async function guardarEstouroEdicao(){
  if(roGuard())return;
  if(_estEditId===null)return;
  const ev=(db.estouros||[]).find(e=>e.id===_estEditId);if(!ev)return;
  const novo={
    nome:document.getElementById('ested-nome').value.trim()||ev.nome,
    data:document.getElementById('ested-data').value||ev.data,
    valor:parseFloat(document.getElementById('ested-valor').value)||ev.valor,
    pagoPor:parseInt(document.getElementById('ested-pagopor').value)||ev.pagoPor
  };
  const parts=[];
  document.querySelectorAll('#ested-participantes input[type=checkbox]:checked').forEach(cb=>{
    parts.push(parseInt(cb.value));
  });
  if(!parts.length){toast('Seleciona pelo menos um participante!',1);return;}
  try{
    await sbReq('PATCH',`estouros?id=eq.${ev.id}`,{nome:novo.nome,data:novo.data,valor:novo.valor,pago_por:novo.pagoPor});
    await sbReq('DELETE',`estouro_participantes?estouro_id=eq.${ev.id}`);
    await sbReq('POST','estouro_participantes',parts.map(amigo_id=>({estouro_id:ev.id,amigo_id})));
  }catch(e){toast('Erro ao guardar: '+e.message,1);return;}
  Object.assign(ev,novo);
  ev.participantes=parts;
  fecharModalEstouro();rEstouro();
  toast(`Evento "${ev.nome}" actualizado ✓`);
}

/* ── FAB MENU ── */
function toggleFabMenu(){
  const menu=document.getElementById('est-fab-menu');
  const backdrop=document.getElementById('est-fab-backdrop');
  const btn=document.getElementById('est-fab-btn');
  const isOpen=menu.classList.contains('open');
  menu.classList.toggle('open',!isOpen);
  backdrop.classList.toggle('open',!isOpen);
  btn.style.transform=isOpen?'':'rotate(45deg)';
}
function fecharFabMenu(){
  document.getElementById('est-fab-menu').classList.remove('open');
  document.getElementById('est-fab-backdrop').classList.remove('open');
  document.getElementById('est-fab-btn').style.transform='';
}

/* ── POTE HOLDER ── */
async function setPoteHolder(id){
  if(roGuard())return;
  const antes=db.poteHolder;
  db.poteHolder=id||null;
  try{await sbReq('PATCH',`epocas?nome=eq.${encodeURIComponent(epocaAtiva)}`,{pote_holder_amigo_id:db.poteHolder});}
  catch(e){db.poteHolder=antes;toast('Erro: '+e.message,1);return;}
  rEstouro();
  const am=id?db.amigos.find(a=>a.id===id):null;
  toast(am?`${am.nome} levantou o pote 💰`:'Pote sem responsável');
}

/* ── CRÉDITOS EXTRA ── */
function estTotalCreditos(){return (db.creditosExtra||[]).reduce((a,c)=>a+(c.valor||0),0);}

function rCreditosExtra(){
  const el=document.getElementById('estouro-creditos-section');
  if(!db.creditosExtra||!db.creditosExtra.length){el.innerHTML='';return;}
  const creds=[...db.creditosExtra].sort((a,b)=>new Date(b.data||0)-new Date(a.data||0));
  el.innerHTML=`<h2 class="stit" style="margin-bottom:8px">Créditos extra</h2>`+
    creds.map(c=>{
      const d=c.data?new Date(c.data+'T12:00:00').toLocaleDateString('pt-PT',{day:'2-digit',month:'short',year:'numeric'}):'';
      const clickable=!isReadOnly;
      return`<div class="est-credit-card" onclick="${clickable?'abrirModalEditCredito('+c.id+')':''}" style="${clickable?'cursor:pointer':''}">
        <div style="width:32px;height:32px;border-radius:50%;background:var(--in);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;color:#fff">💰</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${c.nome||'Crédito'}</div>
          <div style="font-size:11px;color:var(--mu)">${d}</div>
        </div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:var(--in);flex-shrink:0">+${(c.valor||0).toFixed(2)}€</div>
      </div>`;
    }).join('')+`<div style="margin-bottom:16px"></div>`;
}

let _credEditId=null;

function abrirModalAddCredito(){
  if(roGuard())return;
  _credEditId=null;
  document.getElementById('modal-credito-title').textContent='💰 Novo crédito extra';
  const saveBtn=document.getElementById('modal-credito-save');
  saveBtn.textContent='Criar crédito';
  saveBtn.onclick=criarCreditoFromModal;
  document.getElementById('modal-credito-del').style.display='none';
  document.getElementById('cred-nome').value='';
  document.getElementById('cred-data').value=new Date().toISOString().split('T')[0];
  document.getElementById('cred-valor').value='';
  document.getElementById('modal-credito').style.display='flex';
  document.body.style.overflow='hidden';
}

function abrirModalEditCredito(id){
  const c=(db.creditosExtra||[]).find(cr=>cr.id===id);if(!c)return;
  _credEditId=id;
  document.getElementById('modal-credito-title').textContent='✏️ Editar crédito';
  const saveBtn=document.getElementById('modal-credito-save');
  saveBtn.textContent='Guardar alterações';
  saveBtn.onclick=guardarCreditoEdicao;
  document.getElementById('modal-credito-del').style.display='';
  document.getElementById('cred-nome').value=c.nome||'';
  document.getElementById('cred-data').value=c.data||'';
  document.getElementById('cred-valor').value=c.valor||'';
  document.getElementById('modal-credito').style.display='flex';
  document.body.style.overflow='hidden';
}

function fecharModalCredito(e){
  if(e&&e.target!==document.getElementById('modal-credito'))return;
  document.getElementById('modal-credito').style.display='none';
  document.body.style.overflow='';
  _credEditId=null;
}

async function criarCreditoFromModal(){
  if(roGuard())return;
  const nome=document.getElementById('cred-nome').value.trim();
  const data=document.getElementById('cred-data').value;
  const valor=parseFloat(document.getElementById('cred-valor').value)||0;
  if(!nome)return toast('Dá um nome ao crédito!',1);
  if(valor<=0)return toast('O valor tem de ser superior a 0€!',1);
  let ins;
  try{ins=await sbReq('POST','creditos_extra',{epoca_nome:epocaAtiva,nome,data,valor},{Prefer:'return=representation'});}
  catch(e){toast('Erro ao criar crédito: '+e.message,1);return;}
  const novo=ins&&ins[0];if(!novo)return;
  if(!db.creditosExtra)db.creditosExtra=[];
  db.creditosExtra.push({id:novo.id,nome,data,valor});
  fecharModalCredito();rEstouro();
  toast(`Crédito "${nome}" adicionado ✓`);
}

async function guardarCreditoEdicao(){
  if(roGuard())return;
  if(_credEditId===null)return;
  const c=(db.creditosExtra||[]).find(cr=>cr.id===_credEditId);if(!c)return;
  const novo={
    nome:document.getElementById('cred-nome').value.trim()||c.nome,
    data:document.getElementById('cred-data').value||c.data,
    valor:parseFloat(document.getElementById('cred-valor').value)||c.valor
  };
  try{await sbReq('PATCH',`creditos_extra?id=eq.${c.id}`,novo);}
  catch(e){toast('Erro ao guardar: '+e.message,1);return;}
  Object.assign(c,novo);
  fecharModalCredito();rEstouro();
  toast(`Crédito "${c.nome}" actualizado ✓`);
}

async function remCreditoFromModal(){
  if(roGuard())return;
  if(_credEditId===null)return;
  if(!confirm('Remover este crédito?'))return;
  const antes=db.creditosExtra;
  db.creditosExtra=(db.creditosExtra||[]).filter(c=>c.id!==_credEditId);
  try{await sbReq('DELETE',`creditos_extra?id=eq.${_credEditId}`);}
  catch(e){db.creditosExtra=antes;toast('Erro ao remover: '+e.message,1);return;}
  fecharModalCredito();rEstouro();
  toast('Crédito removido');
}

/* ── AUTH (Supabase — mesmo padrão do FestasBV, sem conceito de cônjuge) ── */
function sbRedirectUrl(){return window.location.href.split('#')[0].split('?')[0];}
function sbLimparHash(){window.history.replaceState({},document.title,window.location.pathname);}
function sbAuthStatus(id,txt,cor){
  const s=document.getElementById(id);if(!s)return;
  s.style.display='block';s.textContent=txt;s.style.color=cor||'var(--mu)';
}
function sbLinkFalhou(motivo){
  sbLimparHash();sbMostrarLogin();
  sbAuthStatus('login-status','O link já expirou ou já tinha sido aberto'+(motivo?' ('+motivo+')':'')+'. Escreve antes o código de 6 dígitos que vem no mesmo email.','var(--dg)');
  sbMostrarCaixaCodigo();
}

// Trata o que o email/redirect do Supabase devolve, ANTES da sessão guardada
// — quem clica no link de recuperação já costuma ter sessão neste aparelho.
async function sbTratarHashAuth(){
  const hs=new URLSearchParams((window.location.hash||'').substring(1));
  const qs=new URLSearchParams(window.location.search||'');
  const g=k=>hs.get(k)||qs.get(k);
  const recovery=g('type')==='recovery';

  if(g('error')||g('error_code')){
    const cod=(g('error_code')||'')+' '+(g('error_description')||'');
    if(/expired|invalid|used/i.test(cod)){sbLinkFalhou(g('error_code')||'');return true;}
    sbLimparHash();sbMostrarLogin();
    sbAuthStatus('login-status',g('error_description')||'Não foi possível concluir a autenticação.','var(--dg)');
    return true;
  }

  const token_hash=g('token_hash');
  if(token_hash){
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:g('type')||'recovery',token_hash})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbLinkFalhou(d.error_code||d.msg||('HTTP '+r.status));return true;
    }
    const d=await r.json();
    sbGuardarSessaoDeVerify(d);
    sbLimparHash();
    if(recovery){sbMostrarNovaPass();return true;}
    await sbAposLogin();
    return true;
  }

  const access_token=g('access_token');
  if(!access_token)return false;
  const refresh_token=g('refresh_token');
  const expires_at=parseInt(g('expires_at'))||Math.floor(Date.now()/1000)+(parseInt(g('expires_in'))||3600);
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${access_token}`}});
  if(!r.ok){sbLinkFalhou('HTTP '+r.status);return true;}
  const u=await r.json();
  sbSaveSession({access_token,refresh_token,expires_at,user:u});
  sbLimparHash();
  if(recovery){sbMostrarNovaPass();return true;}
  await sbAposLogin();
  return true;
}

function sbGuardarSessaoDeVerify(d){
  sbSaveSession({
    access_token:d.access_token,
    refresh_token:d.refresh_token,
    expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
    user:d.user
  });
}

async function sbInit(){
  try{
    if(await sbTratarHashAuth())return;
  }catch(e){
    if(window.location.hash.length>1||window.location.search.length>1){
      sbLimparHash();sbMostrarLogin();
      sbAuthStatus('login-status','Não foi possível validar o link — sem ligação. Tenta outra vez.','var(--dg)');
      return;
    }
  }
  const stored=localStorage.getItem(SESSION_KEY);
  if(stored){
    try{
      const s=JSON.parse(stored);
      _sbSession=s;
      if(tokenQuaseExpirado())await sbRefresh();
      let r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      if(!r.ok&&_sbSession.refresh_token){
        if(await sbRefresh())
          r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      }
      if(r.ok){const u=await r.json();sbSaveSession({..._sbSession,user:u});await sbAposLogin();return;}
    }catch(e){}
    _sbSession=null;
    localStorage.removeItem(SESSION_KEY);
  }
  sbMostrarLogin();
}

function sbMostrarLogin(){
  document.getElementById('page-login').style.display='flex';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  if(window.glEsconderSplash)window.glEsconderSplash();
}

async function sbAposLogin(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-nova-pass').style.display='none';
  const email=_sbSession.user.email;
  let data=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,{headers:sbHeaders()});
    if(r.ok)data=await r.json();
  }catch(e){}
  if(!Array.isArray(data)||data.length===0){
    document.getElementById('page-sem-acesso').style.display='flex';
    document.getElementById('sem-acesso-email').textContent=`Sessão iniciada como ${email}. Esta conta não tem acesso à app.`;
    if(window.glEsconderSplash)window.glEsconderSplash();
    return;
  }
  document.getElementById('page-sem-acesso').style.display='none';
  const contaEmailEl=document.getElementById('conta-email');
  if(contaEmailEl)contaEmailEl.textContent=`Sessão iniciada como ${email}`;
  checkReadOnly();
  document.getElementById('fcard-utilizadores')?.classList.toggle('ro-hide',!isAdmin());
  try{
    await carregar();
    await sbCarregarMinhaLigacao();
  }catch(e){toast('Erro a carregar dados: '+e.message,1);}
  rDash();rCfg();renderJogosList();restaurarTab();
  if(isAdmin()){sbRenderPedidos();sbRenderLigacoes();sbRenderPassTemp();}
  if(window.glEsconderSplash)window.glEsconderSplash();
  await pushCheckColuna();
  pushRenderStatus();
  pushSugerirAtivacao();
}

async function sbLoginGoogle(){
  window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(sbRedirectUrl())}`;
}

async function sbRecuperarPassword(){
  const email=document.getElementById('login-email').value.trim();
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve primeiro o teu email aqui em cima e volta a tocar.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  sbAuthStatus('login-status','A enviar email…');
  try{
    const r=await fetch(`${SB_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(sbRedirectUrl())}`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email})
    });
    if(r.status===429){sbAuthStatus('login-status','Já foi pedido um email há pouco. Espera uns minutos e tenta outra vez.','var(--dg)');return;}
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      sbAuthStatus('login-status',d.error_description||d.msg||d.message||'Não foi possível enviar o email.','var(--dg)');return;
    }
    sbAuthStatus('login-status','Se houver conta com esse email, chega já o link e o código para definires uma password nova. Vê também o spam.','var(--vd)');
    sbMostrarCaixaCodigo();
  }catch(e){sbAuthStatus('login-status','Erro de ligação.','var(--dg)');}
}

function sbMostrarCaixaCodigo(){
  const box=document.getElementById('login-codigo');
  if(box)box.style.display='';
}
async function sbVerificarCodigo(){
  const email=document.getElementById('login-email').value.trim();
  const token=document.getElementById('login-cod').value.replace(/\s/g,'');
  if(!email||!email.includes('@')){
    sbAuthStatus('login-status','Escreve também o teu email aqui em cima — o código é confirmado com ele.','var(--dg)');
    document.getElementById('login-email').focus();return;
  }
  if(!token){sbAuthStatus('login-status','Escreve o código que veio no email.','var(--dg)');return;}
  const btn=document.getElementById('btn-login-cod');
  btn.disabled=true;btn.textContent='A confirmar…';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/verify`,{
      method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({type:'recovery',email,token})
    });
    if(!r.ok){
      let d={};try{d=await r.json();}catch(_){}
      const msg=d.error_description||d.msg||d.message||'';
      sbAuthStatus('login-status',(!msg||/expired|invalid|token/i.test(msg))
        ?'Código errado ou já expirado. Confirma os dígitos ou pede outro email.':msg,'var(--dg)');
      btn.disabled=false;btn.textContent='Confirmar código';return;
    }
    sbGuardarSessaoDeVerify(await r.json());
    document.getElementById('login-cod').value='';
    btn.disabled=false;btn.textContent='Confirmar código';
    sbMostrarNovaPass();
  }catch(e){
    sbAuthStatus('login-status','Erro de ligação.','var(--dg)');
    btn.disabled=false;btn.textContent='Confirmar código';
  }
}

function sbMostrarNovaPass(){
  document.getElementById('page-login').style.display='none';
  document.getElementById('page-sem-acesso').style.display='none';
  document.getElementById('page-nova-pass').style.display='flex';
  const sub=document.getElementById('nova-pass-sub');
  if(sub&&_sbSession&&_sbSession.user)sub.textContent=`Escolhe uma password nova para ${_sbSession.user.email}.`;
  if(window.glEsconderSplash)window.glEsconderSplash();
}

function sbValidarPass(p1,p2){
  if(p1.length<6)return 'A password tem de ter pelo menos 6 caracteres.';
  if(p1!==p2)return 'As duas passwords não são iguais.';
  return '';
}
async function sbTrocarPassword(password){
  let r;
  try{
    r=await sbFetch(`${SB_URL}/auth/v1/user`,{
      method:'PUT',
      headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({password})
    });
  }catch(e){return 'Erro de ligação — tenta outra vez.';}
  if(r.ok)return '';
  let d={};try{d=await r.json();}catch(_){}
  const msg=d.error_description||d.msg||d.message||('HTTP '+r.status);
  if(/should be different/i.test(msg))return 'Essa já é a password atual — escolhe outra.';
  if(r.status===401||r.status===403)return 'A sessão do link já expirou. Pede outro email de recuperação.';
  return msg;
}

async function sbDefinirNovaPassword(){
  const p1=document.getElementById('nova-pass-1').value;
  const p2=document.getElementById('nova-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){sbAuthStatus('nova-pass-status',erro,'var(--dg)');return;}
  const btn=document.getElementById('btn-nova-pass');
  btn.disabled=true;btn.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){
    sbAuthStatus('nova-pass-status',falha,'var(--dg)');
    btn.disabled=false;btn.textContent='Guardar password';return;
  }
  document.getElementById('nova-pass-1').value='';
  document.getElementById('nova-pass-2').value='';
  document.getElementById('nova-pass-campos').style.display='none';
  document.getElementById('btn-nova-pass-entrar').style.display='';
  sbAuthStatus('nova-pass-status','Password alterada ✓ Se abriste este link fora da app, volta a abrir a app instalada e entra com o email e a password nova.','var(--vd)');
}

// Definições › Conta — trocar a password já com sessão iniciada (partilha
// sbTrocarPassword/sbValidarPass com o ecrã de recuperação).
function toggleAdmPass(){
  const box=document.getElementById('adm-pass-box');
  if(!box)return;
  box.style.display=box.style.display==='none'?'':'none';
  const st=document.getElementById('adm-pass-status');
  if(st)st.textContent='';
}
async function sbAlterarPassword(){
  const st=document.getElementById('adm-pass-status');
  const p1=document.getElementById('adm-pass-1').value;
  const p2=document.getElementById('adm-pass-2').value;
  const erro=sbValidarPass(p1,p2);
  if(erro){st.style.color='var(--dg)';st.textContent=erro;return;}
  st.style.color='var(--mu)';st.textContent='A guardar…';
  const falha=await sbTrocarPassword(p1);
  if(falha){st.style.color='var(--dg)';st.textContent=falha;return;}
  document.getElementById('adm-pass-1').value='';
  document.getElementById('adm-pass-2').value='';
  st.style.color='var(--vd)';st.textContent='Password alterada ✓';
  toast('Password alterada ✓');
}

async function sbLoginEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A entrar…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao entrar.';return;}
    sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
    await sbAposLogin();
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}

async function sbRegistarEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A criar conta…';status.style.color='var(--mu)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--dg)';status.textContent=d.error_description||d.msg||'Erro ao criar conta.';return;}
    // Login (auth.users) é partilhado por todo o projeto Supabase — FestasBV, SplitBill e Goals.
    // Email já registado noutra app: o GoTrue devolve 200 sem enviar confirmação, mas com identities:[].
    if(d.user&&Array.isArray(d.user.identities)&&d.user.identities.length===0){
      status.style.color='var(--dg)';status.textContent='Esta conta já existe (ex.: já criaste login no SplitBill ou noutra app). Não é preciso criar de novo — carrega em "Entrar" com o mesmo email e password.';
      return;
    }
    status.style.color='var(--vd)';status.textContent='Conta criada! Confirma o email e volta a entrar.';
  }catch(e){status.style.color='var(--dg)';status.textContent='Erro de ligação.';}
}

async function sbSolicitarAcesso(){
  if(!_sbSession)return;
  const btn=document.getElementById('btn-solicitar');
  const btnV=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A enviar…';
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/access_requests`,{
      method:'POST',
      headers:sbHeaders({'Prefer':'return=minimal'}),
      body:JSON.stringify({email:_sbSession.user.email})
    });
    if(r.ok||r.status===409){
      status.style.display='block';status.style.color='var(--vd)';
      status.textContent=r.status===409?'✓ O pedido já estava registado. Aguarda aprovação.':'✓ Pedido enviado! Aguarda aprovação.';
      btn.style.display='none';
      btnV.style.display='';
      if(r.ok)sbNotificarPedidoAcesso(_sbSession.user.email); // só em pedidos novos, não em repetidos
      return;
    }
    let msg='HTTP '+r.status;
    try{const j=await r.json();msg=j.message||msg;}catch(_){}
    if(r.status===401)msg='Sessão expirada — sai e volta a entrar.';
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro ao enviar pedido: '+msg;
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }catch(e){
    status.style.display='block';status.style.color='var(--dg)';
    status.textContent='Erro de ligação — tenta novamente.';
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }
}

async function sbVerificarAcesso(){
  const btn=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A verificar…';
  await sbAposLogin();
  btn.disabled=false;btn.textContent='🔄 Verificar acesso';
  status.style.display='block';status.style.color='var(--mu)';
  status.textContent='Acesso ainda não aprovado. Tenta mais tarde.';
}

function sbLogout(){
  localStorage.removeItem(SESSION_KEY);
  _sbSession=null;
  window.location.reload();
}

async function sbRenderPedidos(){
  const box=document.getElementById('adm-pedidos-list');
  if(!box)return;
  try{
    const reqs=await sbReq('GET','access_requests?select=email,requested_at&order=requested_at.asc');
    if(!reqs||!reqs.length){box.innerHTML='<div class="note" style="font-size:12px;color:var(--mu)">Sem pedidos pendentes.</div>';return;}
    box.innerHTML=reqs.map(r=>`
      <div class="ua-row">
        <span>${r.email}</span>
        <button class="jdel" style="color:var(--vd)" title="Aprovar" onclick="sbAprovarAcesso('${r.email.replace(/'/g,"\\'")}')">✓</button>
        <button class="jdel" title="Recusar" onclick="sbRecusarAcesso('${r.email.replace(/'/g,"\\'")}')">✕</button>
      </div>`).join('');
  }catch(e){box.innerHTML='<div class="note" style="font-size:12px;color:var(--mu)">Erro a carregar pedidos.</div>';}
}

async function sbAprovarAcesso(email){
  try{
    await sbReq('POST','allowed_users',{email},{Prefer:'resolution=merge-duplicates'});
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Acesso aprovado ✓');
    sbRenderPedidos();
  }catch(e){toast('Erro: '+e.message,1);}
}

async function sbRecusarAcesso(email){
  try{
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Pedido removido');
    sbRenderPedidos();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ── UTILIZADORES ↔ AMIGOS (admin) — liga um login a um nome de amigo ──── */
async function sbCarregarMinhaLigacao(){
  MEU_AMIGO_NOME=null;
  if(!_sbSession)return;
  try{
    const rows=await sbReq('GET',`user_amigos?email=eq.${encodeURIComponent(_sbSession.user.email)}&select=amigo`);
    if(rows&&rows[0])MEU_AMIGO_NOME=rows[0].amigo;
  }catch(e){}
}
// O amigo (da época ativa) a que este login está ligado, se algum
function meuAmigoNaEpoca(){
  if(!MEU_AMIGO_NOME)return null;
  return db.amigos.find(a=>a.nome===MEU_AMIGO_NOME)||null;
}

// Nomes de amigo estáveis (união de todas as épocas) para o combobox de ligação.
function nomesAmigosGlobal(){
  const vistos=new Set();
  Object.values(dbFull.epocas||{}).forEach(ep=>(ep.amigos||[]).forEach(a=>{if(a&&a.nome)vistos.add(a.nome);}));
  return[...vistos].sort((a,b)=>a.localeCompare(b,'pt'));
}
// Preenche os dois combobox do formulário "Ligar" (contas com acesso + amigos conhecidos)
async function sbPreencherFormLigar(){
  const selEmail=document.getElementById('ua-email');
  const selAmigo=document.getElementById('ua-amigo');
  if(!selEmail||!selAmigo)return;
  try{
    const rows=await sbReq('GET','allowed_users?select=email&order=email.asc');
    const prev=selEmail.value;
    const opts=(rows||[]).filter(r=>r.email!==ADMIN_EMAIL);
    selEmail.innerHTML=opts.length
      ?opts.map(r=>`<option value="${r.email}"${prev===r.email?' selected':''}>${r.email}</option>`).join('')
      :'<option value="">— sem contas —</option>';
  }catch(e){}
  const prevA=selAmigo.value;
  const nomes=nomesAmigosGlobal();
  selAmigo.innerHTML=nomes.length
    ?nomes.map(n=>`<option value="${n}"${prevA===n?' selected':''}>${n}</option>`).join('')
    :'<option value="">— sem amigos —</option>';
}

async function sbRenderLigacoes(){
  if(!isAdmin())return;
  const box=document.getElementById('adm-ligacoes-list');
  if(box){
    try{
      const rows=await sbReq('GET','user_amigos?select=email,amigo&order=amigo.asc');
      if(!rows||!rows.length){box.innerHTML='<div class="note" style="font-size:12px;color:var(--mu)">Nenhum utilizador ligado ainda.</div>';}
      else box.innerHTML=rows.map(r=>`
        <div class="ua-row">
          <span>${r.email} → <strong>${r.amigo}</strong></span>
          <button class="jdel" title="Desligar" onclick="sbApagarLigacao('${r.email.replace(/'/g,"\\'")}')">✕</button>
        </div>`).join('');
    }catch(e){box.innerHTML='<div class="note" style="font-size:12px;color:var(--mu)">Erro a carregar ligações.</div>';}
  }
  sbPreencherFormLigar();
}

async function sbLigarAmigo(){
  if(!isAdmin())return;
  const email=document.getElementById('ua-email').value.trim();
  const amigo=document.getElementById('ua-amigo').value.trim();
  if(!email||!email.includes('@')||!amigo)return toast('Escolhe email e amigo',1);
  try{
    await sbReq('POST','user_amigos',{email,amigo},{Prefer:'resolution=merge-duplicates'});
    toast('Ligação criada ✓');
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,1);}
}
async function sbApagarLigacao(email){
  if(!isAdmin())return;
  try{
    await sbReq('DELETE',`user_amigos?email=eq.${encodeURIComponent(email)}`);
    toast('Ligação removida');
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,1);}
}

/* ── Password temporária dada pelo admin ──
   Rede de segurança para quando a recuperação por email não serve — o
   projeto não tem SMTP próprio configurado, o que trava tanto o serviço
   de defeito do Supabase (poucos emails/hora) como a edição do template
   "Reset Password". O admin gera aqui uma password, dita-a pelo telefone,
   e a pessoa troca-a em Definições › Conta (sbAlterarPassword). A app
   nunca escreve em auth.users — quem faz o trabalho é goals.admin_pass_temp
   (SECURITY DEFINER), que verifica do lado do servidor que quem chama é
   o admin. Ver db/admin_pass_temp.sql. Mesmo padrão do FestasBV. */
function gerarPassTemp(){
  // Legível ao telefone de propósito: sem maiúsculas, sem símbolos, sem
  // caracteres que se confundam a ditar. Serve para uma vez.
  const pal=['leao','alvalade','escudo','sporting','estadio','plantel','epoca','pote','golo','verde'];
  return pal[Math.floor(Math.random()*pal.length)]+'-'+String(Math.floor(Math.random()*9000)+1000);
}
function copiarPassTemp(pass){
  const done=()=>toast('Password copiada ✓');
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(pass).then(done).catch(()=>toast(pass));
  else toast(pass);
}
async function sbRenderPassTemp(){
  if(!isAdmin())return;
  const sel=document.getElementById('adm-pt-email');
  if(!sel)return;
  try{
    const rows=await sbReq('GET','allowed_users?select=email&order=email.asc');
    const prev=sel.value;
    const opts=(rows||[]).filter(r=>r.email!==ADMIN_EMAIL);
    sel.innerHTML=opts.length
      ?opts.map(r=>`<option value="${r.email}"${prev===r.email?' selected':''}>${r.email}</option>`).join('')
      :'<option value="">— sem contas —</option>';
  }catch(e){}
}
async function admGerarPassTemp(){
  if(!isAdmin())return;
  const sel=document.getElementById('adm-pt-email');
  const out=document.getElementById('adm-pt-out');
  const btn=document.getElementById('adm-pt-btn');
  const email=sel?sel.value:'';
  if(!email)return toast('Escolhe primeiro a conta',1);
  const pass=gerarPassTemp();
  const txt=btn.textContent;btn.disabled=true;btn.textContent='A gerar…';
  try{
    await sbReq('POST','rpc/admin_pass_temp',{p_email:email,p_password:pass});
    out.innerHTML=`<div style="margin-top:10px;padding:12px;background:#fafaf8;border:1px solid var(--vd);border-radius:10px">
      <div style="font-size:11px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px;font-weight:700;margin-bottom:6px">Password de ${email}</div>
      <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;font-weight:700;color:var(--tx);letter-spacing:1px;word-break:break-all">${pass}</div>
      <div style="font-size:11px;color:var(--mu);margin-top:8px">Dita-lha pelo telefone: entra com o email e esta password. A password antiga deixou de funcionar. Isto só aparece aqui uma vez.</div>
      <button class="btn btn-n" style="margin-top:8px;font-size:12px" onclick="copiarPassTemp('${pass}')">📋 Copiar</button>
    </div>`;
    toast('Password gerada ✓');
  }catch(e){
    const m=String(e&&e.message||e);
    out.innerHTML='<div style="font-size:12px;color:var(--dg);margin-top:8px">'+
      (/PGRST202|could not find|not exist|404/i.test(m)?'Falta correr o db/admin_pass_temp.sql no SQL Editor do Supabase.':('Não deu: '+m))+'</div>';
  }
  btn.disabled=false;btn.textContent=txt;
}

/* ── MIGRAÇÃO DOS DADOS ANTIGOS (JSON → Supabase, uma vez) ─────────────────
   Botão admin-only em Definições, só visível enquanto goals.epocas estiver
   vazio (rCfg sonda isto). Lê o JSON tal como ele já vivia (localStorage
   'sg_v5' deste browser, ou o goals-data.json público que o GitHub sync
   escrevia) e recria a mesma estrutura no Supabase, linha a linha. */
async function migrarDadosAntigos(){
  if(!isAdmin())return;
  if(Object.keys(dbFull.epocas||{}).length){
    toast('Já há épocas no Supabase — a migração não corre para não duplicar.',1);return;
  }
  let origem=null,texto=null;
  try{texto=localStorage.getItem('sg_v5');}catch(e){}
  if(texto)origem='localStorage (este aparelho)';
  if(!texto){
    try{
      const r=await fetch('https://raw.githubusercontent.com/diogoandrefsilva-ghc/AppDataJSON/main/goals-data.json?t='+Date.now());
      if(r.ok){texto=await r.text();origem='GitHub (goals-data.json)';}
    }catch(e){}
  }
  if(!texto)return toast('Não encontrei dados antigos (nem localStorage, nem GitHub).',1);
  let velho;
  try{velho=JSON.parse(texto);}catch(e){return toast('JSON inválido.',1);}

  let epocasVelhas={};
  let valorPorGoloVelho=1;
  if(velho.epocas){epocasVelhas=velho.epocas;valorPorGoloVelho=(velho.config&&velho.config.valorPorGolo)||1;}
  else if(velho.amigos&&velho.jogos){epocasVelhas={[epocaAtiva||'2025/26']:velho};}
  else return toast('Formato de dados antigo não reconhecido.',1);

  const nomes=Object.keys(epocasVelhas);
  if(!nomes.length)return toast('Não há épocas para migrar.',1);
  if(!confirm(`Migrar ${nomes.length} época(s) de ${origem} para o Supabase?`))return;

  try{
    await sbReq('PATCH','config?chave=eq.valor_por_golo',{valor:String(valorPorGoloVelho)});
    for(const nome of nomes){
      const ep=epocasVelhas[nome]||{};
      await sbReq('POST','epocas',{nome});

      const amigosVelhos=ep.amigos||[];
      const amigoIdMap={};
      if(amigosVelhos.length){
        const ins=await sbReq('POST','amigos',amigosVelhos.map((a,i)=>({epoca_nome:nome,nome:a.nome,cor:a.cor,ordem:i})),{Prefer:'return=representation'});
        amigosVelhos.forEach((a,i)=>{if(ins&&ins[i])amigoIdMap[a.id]=ins[i].id;});
      }

      const jogosVelhos=ep.jogos||[];
      const jogoIdMap={};
      if(jogosVelhos.length){
        const ins=await sbReq('POST','jogos',jogosVelhos.map(j=>({epoca_nome:nome,data:j.data,adversario:j.adversario,competicao:j.competicao||'',jornada:j.jornada||'',local:j.local||null,golos:(j.golos===undefined||j.golos==='')?null:j.golos,resultado:j.resultado||''})),{Prefer:'return=representation'});
        jogosVelhos.forEach((j,i)=>{if(ins&&ins[i])jogoIdMap[j.id]=ins[i].id;});
      }

      const pagosVelhos=ep.pagosPorJogo||{};
      const pagosRows=[];
      Object.keys(pagosVelhos).forEach(oldJogoId=>{
        const novoJogoId=jogoIdMap[oldJogoId]||jogoIdMap[parseInt(oldJogoId)];
        if(!novoJogoId)return;
        (pagosVelhos[oldJogoId]||[]).forEach(oldAmigoId=>{
          const novoAmigoId=amigoIdMap[oldAmigoId];
          if(novoAmigoId)pagosRows.push({jogo_id:novoJogoId,amigo_id:novoAmigoId});
        });
      });
      if(pagosRows.length)await sbReq('POST','pagos_jogo',pagosRows);

      const estourosVelhos=ep.estouros||[];
      for(const ev of estourosVelhos){
        const ins=await sbReq('POST','estouros',{epoca_nome:nome,nome:ev.nome||'Evento',data:ev.data||null,valor:ev.valor||0,pago_por:ev.pagoPor?(amigoIdMap[ev.pagoPor]||null):null},{Prefer:'return=representation'});
        const novoEvId=ins&&ins[0]&&ins[0].id;
        if(!novoEvId)continue;
        const parts=(ev.participantes||[]).map(oldId=>amigoIdMap[oldId]).filter(Boolean);
        if(parts.length)await sbReq('POST','estouro_participantes',parts.map(amigo_id=>({estouro_id:novoEvId,amigo_id})));
      }

      const estouroPagosVelhos=ep.estouroPagos||[];
      const epRows=estouroPagosVelhos.map(oldId=>amigoIdMap[oldId]).filter(Boolean).map(amigo_id=>({amigo_id}));
      if(epRows.length)await sbReq('POST','estouro_pagos',epRows,{Prefer:'resolution=merge-duplicates'});

      const creditosVelhos=ep.creditosExtra||[];
      if(creditosVelhos.length)await sbReq('POST','creditos_extra',creditosVelhos.map(c=>({epoca_nome:nome,nome:c.nome||'Crédito',data:c.data||null,valor:c.valor||0})));

      if(ep.poteHolder&&amigoIdMap[ep.poteHolder]){
        await sbReq('PATCH',`epocas?nome=eq.${encodeURIComponent(nome)}`,{pote_holder_amigo_id:amigoIdMap[ep.poteHolder]});
      }
    }
  }catch(e){
    toast('Erro a meio da migração: '+e.message+' — o que já foi escrito fica; corrige e não repitas as épocas já criadas.',1);
    return;
  }
  toast('Migração concluída ✓ A recarregar…');
  await carregar();
  await sbCarregarMinhaLigacao();
  rDash();rCfg();renderJogosList();
}

/* ── NOTIFICAÇÕES PUSH (Web Push, sem Telegram) ──────────────────────────
   Ativado por conta+dispositivo em Definições (pushAtivar/pushDesativar,
   tabela push_subscriptions — migração db/push-subscriptions.sql). Três
   momentos avisam a Edge Function push-notificar-goals: pedido de acesso
   (admin), pagamento declarado (admin) e resultado de jogo fechado (todos).
   Sem a migração (PUSH_COL=false) os controlos escondem-se e a chamada não
   sai. */

function pushSuportado(){
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function _urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function pushCheckColuna(){
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/push_subscriptions?select=endpoint&limit=1`,{headers:sbHeaders({'Accept':'application/json'})});
    PUSH_COL=r.ok;
  }catch(e){PUSH_COL=false;}
  if(!PUSH_COL)console.warn('[Goals] tabela push_subscriptions ausente — corre db/push-subscriptions.sql para ativar notificações push');
}

async function pushSubscricaoAtual(){
  if(!pushSuportado())return null;
  try{
    const reg=await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  }catch(e){return null;}
}

// Atualiza os controlos na caixa .push-toggle-box de Definições › Conta.
async function pushRenderStatus(){
  const els=document.querySelectorAll('.push-toggle-box');
  if(!els.length)return;
  const suportado=pushSuportado();
  const email=_sbSession&&_sbSession.user&&_sbSession.user.email;
  const sub=suportado?await pushSubscricaoAtual():null;
  const ativo=!!sub;
  els.forEach(box=>{
    if(!PUSH_COL||!suportado||!email){box.style.display='none';return;}
    box.style.display='';
    const btn=box.querySelector('.push-toggle-btn');
    const msg=box.querySelector('.push-toggle-msg');
    if(btn){
      btn.textContent=ativo?'🔕 Desativar notificações':'🔔 Ativar notificações';
      btn.onclick=ativo?pushDesativar:pushAtivar;
    }
    if(msg)msg.textContent=ativo
      ?'Notificações ativas neste dispositivo.'
      :'Avisamos-te de pedidos de acesso, pagamentos declarados e resultados fechados.';
  });
}

async function pushAtivar(){
  if(!pushSuportado()){toast('⚠️ Este browser não suporta notificações push',1);return;}
  const email=_sbSession&&_sbSession.user&&_sbSession.user.email;
  if(!email)return;
  try{
    const permissao=await Notification.requestPermission();
    if(permissao!=='granted'){toast('⚠️ Permissão de notificações recusada',1);return;}
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:_urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const json=sub.toJSON();
    const r=await sbFetch(`${SB_URL}/rest/v1/push_subscriptions`,{
      method:'POST',
      headers:sbHeaders({'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body:JSON.stringify({endpoint:sub.endpoint,email,p256dh:json.keys.p256dh,auth_key:json.keys.auth})
    });
    if(!r.ok)throw new Error('HTTP '+r.status);
    toast('✓ Notificações ativadas neste dispositivo');
  }catch(e){
    console.error('Erro ao ativar notificações:',e);
    toast('⚠️ Não foi possível ativar notificações: '+e.message,1);
  }
  pushRenderStatus();
}

/* Sugestão automática logo a seguir ao login — para ninguém ter de descobrir
   o botão em Definições. Se a permissão já foi concedida antes, subscreve
   logo sem mostrar nada; se já foi recusada, não insiste (o browser nem
   deixava). */
async function pushSugerirAtivacao(){
  if(!PUSH_COL||!pushSuportado())return;
  if(Notification.permission==='denied')return;
  if(Notification.permission==='granted'){
    const sub=await pushSubscricaoAtual();
    if(!sub)await pushAtivar();
    return;
  }
  const overlay=document.getElementById('push-prompt-overlay');
  if(overlay)overlay.style.display='flex';
}

function pushPromptAdiar(){
  const overlay=document.getElementById('push-prompt-overlay');
  if(overlay)overlay.style.display='none';
}

async function pushPromptAtivar(){
  const overlay=document.getElementById('push-prompt-overlay');
  if(overlay)overlay.style.display='none';
  await pushAtivar();
}

async function pushDesativar(){
  try{
    const sub=await pushSubscricaoAtual();
    if(sub){
      await sbFetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,{method:'DELETE',headers:sbHeaders()});
      await sub.unsubscribe();
    }
    toast('Notificações desativadas neste dispositivo');
  }catch(e){
    console.error('Erro ao desativar notificações:',e);
  }
  pushRenderStatus();
}

// Base comum aos 3 momentos — chama a Edge Function push-notificar-goals,
// que decide o texto pelo `tipo` (nunca vem livre do cliente). Fire-and-
// forget: nunca bloqueia nem incomoda o utilizador com erro.
async function sbEnviarPush(body){
  if(!PUSH_COL||!_sbSession)return null;
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/push-notificar-goals`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify(body),
      signal:ctrl.signal
    });
    return await r.json().catch(()=>null);
  }catch(e){
    console.warn('[Goals] notificação push não enviada:',e.message);
    return null;
  }finally{clearTimeout(timer);}
}

// 1) Avisa o admin quando alguém pede acesso à app pela primeira vez. Corre
// mesmo para quem AINDA não está em allowed_users — é precisamente essa
// pessoa que dispara o aviso (a Edge Function só exige sessão válida para
// este tipo, não pertencer a allowed_users).
function sbNotificarPedidoAcesso(email){
  sbEnviarPush({tipo:'pedido_acesso',email});
}

// 2) Avisa o admin quando um amigo diz que já pagou um conjunto de jogos.
function sbNotificarPagamentoDeclarado(amigo,valor,jogos){
  sbEnviarPush({tipo:'pagamento_declarado',amigo,valor,jogos});
}

// 3) Avisa TODOS os subscritos quando o resultado de um jogo fecha pela
// primeira vez. Só o admin dispara isto (guardarEdicao() já é admin-only
// via roGuard) — a Edge Function confirma isso do lado do servidor também.
function sbNotificarResultadoJogo(adversario,resultado,golos){
  sbEnviarPush({tipo:'resultado_jogo',adversario,resultado,golos});
}

/* ── LOGOS DOS ADVERSÁRIOS ─────────────────── */
// Lê logos.json do repo AppDataJSON (mesma fonte dos dados) e indexa por nome
// normalizado (sem acentos/maiúsculas/pontuação), para casar com o texto livre
// que escreves no adversário. Logo em falta ou que não carregue: fica sem logo.
let LOGOS={};
function normNome(s){return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');}
function logoAdv(nome){return LOGOS[normNome(nome)]||'';}
async function carregarLogos(){
  try{
    const r=await fetch('https://raw.githubusercontent.com/diogoandrefsilva-ghc/AppDataJSON/main/logos.json?t='+Date.now());
    if(!r.ok)return;
    const d=await r.json();
    const m={};for(const k in d)m[normNome(k)]=d[k];
    LOGOS=m;renderJogosList();
  }catch(e){/* offline ou ficheiro em falta: segue sem logos */}
}

/* ── INIT ──────────────────────────────────── */
carregarLogos();
sbInit();
