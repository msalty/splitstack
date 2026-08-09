/* Builds demo.html — a single self-contained file with fake data and an
   in-memory store, so the app can be opened straight off disk with no setup. */
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
let app = fs.readFileSync('app.js', 'utf8');

/* swap the IndexedDB layer for an in-memory one (file:// blocks IDB) */
const A = app.indexOf('/* ─────────────────────────────────────────────────────────────── IndexedDB */');
const B = app.indexOf('/* ─────────────────────────────────────────────────────────────── crypto */');
const memDB = `/* demo: in-memory store */
const DB = (() => {
  const kv = {}, txns = {}, outbox = []; let seq = 1; const blobs = {};
  return {
    async get(k){ return kv[k]; },
    async set(k,v){ kv[k]=v; },
    async del(k){ delete kv[k]; },
    async putTxns(l,list){ txns[l]=list.map(x=>Object.assign({},x)); },
    async allTxns(l){ return (txns[l]||[]).map(x=>Object.assign({},x)); },
    async dropLedger(l){ delete txns[l]; },
    async queue(i){ outbox.push(Object.assign({seq:seq++},i)); },
    async outbox(){ return outbox.slice(); },
    async unqueue(s){ const i=outbox.findIndex(o=>o.seq===s); if(i>=0) outbox.splice(i,1); },
    async blobGet(k){ return blobs[k]; },
    async blobSet(k,v){ blobs[k]=v; },
    async wipe(){ for(const k in kv) delete kv[k]; for(const k in txns) delete txns[k]; outbox.length=0; }
  };
})();

`;
app = app.slice(0, A) + memDB + app.slice(B);

/* demo data + a fake backend, installed before the app boots */
const stub = `
<script>
(function(){
  /* in-memory localStorage: file:// origins are unreliable */
  const mem = { 'ss.api':'https://script.google.com/macros/s/DEMO/exec', 'ss.token':'demo' };
  try { Object.defineProperty(window,'localStorage',{configurable:true,value:{
    getItem:k=>(k in mem)?mem[k]:null, setItem:(k,v)=>{mem[k]=String(v);}, removeItem:k=>{delete mem[k];}
  }}); } catch(e){}

  /* no service worker in demo mode */
  try { Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:undefined}); } catch(e){}

  const U=(id,n,role,color,emoji)=>({id,username:n.toLowerCase(),name:n,email:'',role:role||'member',
    avatar:'',color,emoji:emoji||'',active:true,hasPassword:true});
  const users=[U('u1','Mike','admin','#6C5CE7','👑'),U('u2','Sam',null,'#00B894','🦊'),
               U('u3','Ada',null,'#E84393','🐙'),U('u4','Ben',null,'#0984E3','🐢')];
  const ledgers=[
    {id:'l1',name:'Beach House',emoji:'🏝️',color:'#00B894',invite:'demoinvite1',archived:false,createdAt:'2026-06-01T00:00:00Z'},
    {id:'l2',name:'Monthly Bills',emoji:'🏠',color:'#6C5CE7',invite:'demoinvite2',archived:false,createdAt:'2026-01-01T00:00:00Z'},
    {id:'l3',name:'Ski Trip',emoji:'🎿',color:'#0984E3',invite:'demoinvite3',archived:false,createdAt:'2026-02-01T00:00:00Z'}
  ];
  const members=[
    {ledgerId:'l1',userId:'u1'},{ledgerId:'l1',userId:'u2'},{ledgerId:'l1',userId:'u3'},{ledgerId:'l1',userId:'u4'},
    {ledgerId:'l2',userId:'u1'},{ledgerId:'l2',userId:'u2'},{ledgerId:'l2',userId:'u4'},
    {ledgerId:'l3',userId:'u1'},{ledgerId:'l3',userId:'u3'}
  ];
  const eq=ids=>{const e=Math.floor((100/ids.length)*100)/100,p={};ids.forEach(i=>p[i]=e);
    const d=Math.round((100-e*ids.length)*100)/100; if(Math.abs(d)>0.001)p[ids[0]]=Math.round((p[ids[0]]+d)*100)/100; return p;};
  let n=0; const T=(o)=>Object.assign({id:'d'+(++n),type:'expense',paidTo:'',notes:'',receiptId:'',
    deleted:false,createdAt:o.date+'T12:00:00Z',updatedAt:1000+n,
    reviewState:'',reviewBy:'',reviewNote:'',reviewDone:[],reviewWas:null},o);
  const ME='u1';
  const needFor=(t)=> t.reviewState==='flag'
    ? (t.type==='settlement'?[t.paidBy,t.paidTo].filter(Boolean):Object.keys(t.split||{}))
    : (t.enteredBy?[t.enteredBy]:[]);
  const noReview={reviewState:'',reviewBy:'',reviewNote:'',reviewDone:[],reviewWas:null};

  const data={
    l1:[
      T({date:'2026-08-07',name:'Beach house rental',category:'Lodging',amount:1840,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u2','u3','u4']),notes:'Three nights, ocean side.',
         reviewState:'edit',reviewBy:'u2',reviewNote:'Amount $1,760.00 → $1,840.00 · Added a note',
         reviewWas:{name:'Beach house rental',amount:1760,date:'2026-08-07',category:'Lodging',paidBy:'u1',paidTo:'',split:eq(['u1','u2','u3','u4']),notes:'',deleted:false}}),
      T({date:'2026-08-07',name:'Big grocery run',category:'Groceries',amount:213.47,paidBy:'u2',enteredBy:'u2',split:eq(['u1','u2','u3','u4'])}),
      T({date:'2026-08-07',name:'Firewood + s\\'mores',category:'Supplies',amount:38.20,paidBy:'u3',enteredBy:'u3',split:eq(['u1','u2','u3','u4'])}),
      T({date:'2026-08-06',name:'Kayak rental',category:'Fun',amount:120,paidBy:'u4',enteredBy:'u4',split:{u3:50,u4:50},notes:'Only Ada and Ben went out.'}),
      T({date:'2026-08-06',name:'Seafood dinner',category:'Food',amount:287.65,paidBy:'u1',enteredBy:'u2',split:{u1:30,u2:30,u3:20,u4:20},notes:'Ada and Ben skipped the lobster.',
         reviewState:'flag',reviewBy:'u2',reviewNote:'Rough split — check I got the lobster share right',reviewDone:['u2']}),
      T({date:'2026-08-05',name:'Gas for the drive',category:'Transport',amount:76.40,paidBy:'u2',enteredBy:'u2',split:eq(['u1','u2','u3','u4'])}),
      T({date:'2026-08-05',name:'Beer + ice',category:'Drinks',amount:54.10,paidBy:'u4',enteredBy:'u4',split:eq(['u1','u2','u4'])}),
      T({date:'2026-08-04',name:'Sam paid Mike back',type:'settlement',category:'',amount:200,paidBy:'u2',paidTo:'u1',enteredBy:'u2',split:{},notes:'Venmo'})
    ],
    l2:[
      T({date:'2026-08-01',name:'Rent',category:'Home',amount:3200,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u2','u4'])}),
      T({date:'2026-08-01',name:'Internet',category:'Internet',amount:79.99,paidBy:'u4',enteredBy:'u4',split:eq(['u1','u2','u4'])}),
      T({date:'2026-08-02',name:'Electricity',category:'Utilities',amount:141.22,paidBy:'u2',enteredBy:'u2',split:eq(['u1','u2','u4'])}),
      T({date:'2026-07-01',name:'Rent',category:'Home',amount:3200,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u2','u4'])}),
      T({date:'2026-07-03',name:'Electricity',category:'Utilities',amount:167.80,paidBy:'u2',enteredBy:'u2',split:eq(['u1','u2','u4'])}),
      T({date:'2026-07-04',name:'Cleaner',category:'Home',amount:180,paidBy:'u4',enteredBy:'u1',split:eq(['u1','u2','u4'])}),
      T({date:'2026-06-01',name:'Rent',category:'Home',amount:3200,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u2','u4'])}),
      T({date:'2026-06-05',name:'Plumber',category:'Home',amount:425,paidBy:'u2',enteredBy:'u2',split:eq(['u1','u2','u4']),notes:'Kitchen sink, again.'})
    ],
    l3:[
      T({date:'2026-02-14',name:'Lift tickets',category:'Fun',amount:640,paidBy:'u3',enteredBy:'u3',split:eq(['u1','u3'])}),
      T({date:'2026-02-14',name:'Cabin',category:'Lodging',amount:900,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u3'])}),
      T({date:'2026-02-15',name:'Ski rental',category:'Fun',amount:230,paidBy:'u1',enteredBy:'u1',split:eq(['u1','u3'])}),
      T({date:'2026-02-16',name:'Ada paid Mike',type:'settlement',category:'',amount:400,paidBy:'u3',paidTo:'u1',enteredBy:'u3',split:{},notes:'cash'})
    ]
  };
  const state={me:users[0],users,ledgers,members,
    config:{currency:'USD',symbol:'$',appName:'SplitStack'},serverTime:new Date().toISOString()};

  window.fetch = async function(url, opts){
    const {action,payload}=JSON.parse(opts.body);
    await new Promise(r=>setTimeout(r,180));      // a little latency, for realism
    let d;
    if(action==='ping') d={version:1,ready:true,appName:'SplitStack',iterations:210000};
    else if(action==='bootstrap') d=state;
    else if(action==='pull'){
      d={ledgers:{}};
      ledgers.forEach(l=>{ d.ledgers[l.id]={txns:data[l.id]||[],cursor:9999,full:!(payload.since||{})[l.id]}; });
    }
    else if(action==='push'){
      const arr=data[payload.ledgerId]||(data[payload.ledgerId]=[]);
      const out=[];
      (payload.txns||[]).forEach(t=>{
        const i=arr.findIndex(x=>x.id===t.id), prior=i>=0?arr[i]:null;
        const author=prior?(prior.enteredBy||t.enteredBy):t.enteredBy;
        let rv=noReview;
        if(prior && author && author!==ME){
          const collided=Number(t.baseRev||0)>0 && Number(prior.updatedAt||0)>Number(t.baseRev);
          rv={reviewState:collided?'conflict':'edit',reviewBy:ME,
              reviewNote:t.reviewNote||'',reviewDone:[],reviewWas:t.reviewWas||null};
        }
        const row=Object.assign({},t,rv,{updatedAt:Date.now()}); delete row.baseRev;
        if(i>=0) arr[i]=row; else arr.push(row);
        out.push(row);
      });
      d={applied:out.map(t=>t.id),txns:out,cursor:9999};
    }
    else if(action==='reviewTxn'){
      const t=(data[payload.ledgerId]||[]).find(x=>x.id===payload.txnId);
      if(t){
        const need=needFor(t);
        if(payload.op==='flag') Object.assign(t,{reviewState:'flag',reviewBy:ME,
          reviewNote:payload.note||'',reviewDone:[ME],reviewWas:null});
        else if(payload.op==='unflag') Object.assign(t,noReview);
        else if(payload.op==='ack'){
          const done=(t.reviewDone||[]).slice(); if(done.indexOf(ME)<0) done.push(ME);
          t.reviewDone=done;
          if(need.every(u=>done.indexOf(u)>=0)) Object.assign(t,noReview);
        }
        t.updatedAt=Date.now();
      }
      d={txn:t,cursor:9999};
    }
    else if(action==='adminSaveLedger'){
      const p=payload;
      if(p.id){ const l=ledgers.find(x=>x.id===p.id); Object.assign(l,{name:p.name||l.name,emoji:p.emoji||l.emoji,color:p.color||l.color,archived:!!p.archived});
        if(p.memberIds){ for(let i=members.length-1;i>=0;i--) if(members[i].ledgerId===p.id) members.splice(i,1);
          p.memberIds.forEach(u=>members.push({ledgerId:p.id,userId:u})); }
        d={ledger:l};
      } else { const l={id:'l'+(ledgers.length+1),name:p.name,emoji:p.emoji,color:p.color,invite:'demo'+Date.now(),archived:false,createdAt:new Date().toISOString()};
        ledgers.push(l); data[l.id]=[]; (p.memberIds||['u1']).forEach(u=>members.push({ledgerId:l.id,userId:u})); d={ledger:l}; }
    }
    else if(action==='adminSaveUser'){
      const p=payload;
      if(p.id){ const u=users.find(x=>x.id===p.id); Object.assign(u,{name:p.name,username:p.username,email:p.email,emoji:p.emoji,color:p.color,role:p.role,active:p.active!==false}); d={user:u}; }
      else { const u={id:'u'+(users.length+1),username:p.username,name:p.name,email:p.email||'',role:p.role,
        avatar:'',color:p.color,emoji:p.emoji||'',active:true,hasPassword:!!p.dk}; users.push(u); d={user:u}; }
    }
    else if(action==='adminDeleteUser'){ const i=users.findIndex(u=>u.id===payload.id); if(i>=0) users.splice(i,1); d={ok:true}; }
    else if(action==='adminDeleteLedger'){ const i=ledgers.findIndex(l=>l.id===payload.id); if(i>=0) ledgers.splice(i,1); d={ok:true}; }
    else if(action==='setAvatar'){ const u=users.find(x=>x.id===(payload.userId||'u1')); if(u) u.avatar=payload.avatar; d={ok:true,avatar:payload.avatar}; }
    else if(action==='adminSetConfig'){ Object.assign(state.config,{appName:payload.appName,currency:payload.currency,symbol:payload.currencySymbol}); d={ok:true}; }
    else d={ok:true};
    return { ok:true, json: async()=>({ok:true,data:d}) };
  };

  addEventListener('load', ()=> setTimeout(()=>{
    const b=document.createElement('div');
    b.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:200;background:#1B1435;color:#fff;'+
      'padding:6px 14px;border-radius:12px 12px 0 0;font:700 11px/1 ui-rounded,system-ui,sans-serif;'+
      'opacity:.75;cursor:pointer;transition:opacity .4s';
    b.textContent='DEMO MODE — tap to hide';
    b.title='Fake data. Nothing is saved.';
    b.onclick=()=>{ b.style.opacity='0'; setTimeout(()=>b.remove(),400); };
    document.body.appendChild(b);
    setTimeout(()=>{ b.style.opacity='.28'; }, 6000);   // fade back so it stops competing
  }, 1200));
})();
</script>
`;

/* NOTE: replacer functions, not strings — app.js is full of $ and $$ which
   would otherwise be interpreted as replacement patterns. */
const out = html
  .replace('<link rel="manifest" href="manifest.webmanifest">', () => '')
  .replace('<link rel="apple-touch-icon" href="icons/icon-192.png">', () => '')
  .replace('<title>SplitStack</title>', () => '<title>SplitStack — demo</title>')
  .replace('</head>', () => stub + '</head>')
  .replace('<script src="app.js"></script>', () => '<script>\n' + app + '\n</script>');

fs.writeFileSync('demo.html', out);
console.log('demo.html written —', (out.length/1024).toFixed(1), 'KB');
