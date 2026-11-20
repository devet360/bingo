export function renderProviderConsole(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Games Provider Dashboard</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#101411;color:#edf2ed}
    *{box-sizing:border-box}body{margin:0;padding:28px;max-width:1440px;margin-inline:auto}
    header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}
    h1{font-size:clamp(24px,4vw,36px);margin:0;letter-spacing:-.04em}
    h2{font-size:14px;margin:0 0 14px;letter-spacing:.01em}
    p{color:#9ba89d;margin:6px 0 0;font-size:13px}
    button{border:1px solid #3b4c3e;border-radius:10px;background:#d9b866;color:#17170f;padding:10px 14px;font-weight:700;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}
    #message{display:none;border:1px solid #744c42;border-radius:12px;background:#2c1c19;color:#ffb5a5;padding:12px;margin-bottom:16px}
    #cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;margin-bottom:16px}
    .card,.panel{background:#191f1b;border:1px solid #2c382f;border-radius:14px}
    .card{padding:16px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#9ba89d}
    .value{font-size:27px;font-weight:800;margin-top:8px;letter-spacing:-.04em}
    .hint{font-size:11px;color:#9ba89d;margin-top:4px}
    .panel{padding:16px;margin-top:14px;overflow:hidden}
    .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
    .table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;color:#9ba89d;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
    th,td{padding:10px 8px;border-bottom:1px solid #29322b;white-space:nowrap}
    td:last-child,th:last-child{white-space:normal}
    .badge{display:inline-flex;border:1px solid #3a493d;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:700}
    .good{color:#91e2ae;border-color:#37624a}.warn{color:#f5d274;border-color:#695b31}.bad{color:#ff9c8b;border-color:#6b3d34}
    .muted{color:#9ba89d}.empty{text-align:center;color:#9ba89d;padding:22px}
    #updated{font-size:11px;color:#9ba89d}
    @media(max-width:600px){body{padding:16px}header{align-items:flex-start}th,td{padding:9px 6px}}
  </style>
</head>
<body>
  <header>
    <div><h1>Games Provider Dashboard</h1><p>Live operator, game, round and wallet-settlement status.</p></div>
    <div><button id="refresh" type="button">Refresh</button><p id="updated"></p></div>
  </header>
  <div id="message" role="status"></div>
  <section id="cards" aria-label="Provider metrics"></section>
  <section class="panel">
    <div class="panel-head"><h2>Operators</h2><span class="muted">Scoped access</span></div>
    <div class="table-wrap"><table><thead><tr><th>Operator</th><th>Status</th><th>Games</th><th>Mode</th><th>Last probe</th></tr></thead><tbody id="operators"></tbody></table></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Recent rounds</h2><span class="muted">Latest 10</span></div>
    <div class="table-wrap"><table><thead><tr><th>Round</th><th>Game</th><th>Status</th><th>Result</th><th>Started</th></tr></thead><tbody id="rounds"></tbody></table></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Wallet outbox</h2><span class="muted">Latest 10 deliveries</span></div>
    <div class="table-wrap"><table><thead><tr><th>Movement</th><th>Status</th><th>Amount</th><th>Attempts</th><th>Updated</th></tr></thead><tbody id="outbox"></tbody></table></div>
  </section>
  <script>
    const token=${JSON.stringify(token)};
    const message=document.getElementById('message');
    const refreshButton=document.getElementById('refresh');
    const cards=document.getElementById('cards');
    const number=value=>Number(value||0).toLocaleString();
    const date=value=>value?new Date(value).toLocaleString():'—';
    const amount=value=>{try{const n=BigInt(value||'0');return (n/100n).toLocaleString()+'.'+String(n%100n).padStart(2,'0')}catch{return '—'}};
    function cell(row,value,className){const el=document.createElement('td');el.textContent=String(value??'—');if(className)el.className=className;row.appendChild(el);return el}
    function renderRows(id,rows,empty,render){const target=document.getElementById(id);target.replaceChildren();if(!rows.length){const row=document.createElement('tr');const td=document.createElement('td');td.className='empty';td.colSpan=8;td.textContent=empty;row.appendChild(td);target.appendChild(row);return}for(const item of rows){const row=document.createElement('tr');render(row,item);target.appendChild(row)}}
    function metric(label,value,hint,tone){const card=document.createElement('article');card.className='card';const title=document.createElement('div');title.className='label';title.textContent=label;const numberEl=document.createElement('div');numberEl.className='value'+(tone?' '+tone:'');numberEl.textContent=number(value);const detail=document.createElement('div');detail.className='hint';detail.textContent=hint;card.append(title,numberEl,detail);cards.appendChild(card)}
    async function load(){
      refreshButton.disabled=true;message.style.display='none';
      try{
        const response=await fetch('/api/admin/dashboard',{headers:{authorization:'Bearer '+token},cache:'no-store'});
        const payload=await response.json();
        if(!response.ok)throw new Error(response.status===401?'Console session expired. Reopen this dashboard from Bingo Admin.':(payload.error?.message||payload.error?.code||'Could not load dashboard.'));
        const data=payload.data, m=data.metrics;
        cards.replaceChildren();
        metric('Active operators',data.operators.filter(o=>o.status==='ACTIVE').length,data.operators.length+' configured');
        metric('Active sessions',m.sessions.active,m.sessions.total+' total sessions');
        metric('Rounds · 24 hours',m.rounds.last24Hours,m.rounds.total+' total rounds');
        metric('Unsettled bets',m.bets.unsettled,m.bets.total+' total bets',m.bets.unsettled?'warn':'');
        metric('Pending wallet outbox',m.outbox.pending,'Waiting for delivery',m.outbox.pending?'warn':'');
        metric('Failed / capped outbox',m.outbox.dead+m.outbox.capRejected,m.outbox.dead+' dead · '+m.outbox.capRejected+' capped',(m.outbox.dead+m.outbox.capRejected)?'bad':'');
        renderRows('operators',data.operators,'No operators are configured.',(row,o)=>{
          cell(row,o.name+' ('+o.code+')');
          cell(row,o.status);
          cell(row,(o.enabledGames||[]).join(', ')||'—');
          cell(row,o.maintenance?'Maintenance':'Normal',o.maintenance?'warn':'');
          cell(row,date(o.probeOkAt));
        });
        renderRows('rounds',m.rounds.recent,'No rounds have been recorded yet.',(row,r)=>{
          cell(row,'#'+r.id);cell(row,r.gameId);cell(row,r.status,r.status==='CRASHED'?'good':r.status==='ABANDONED'?'bad':'warn');
          cell(row,r.coinOutcome||(r.crashPoint===null?'—':Number(r.crashPoint).toFixed(2)+'×'));cell(row,date(r.startedAt));
        });
        renderRows('outbox',m.outbox.recent,'No wallet deliveries yet.',(row,item)=>{
          cell(row,item.type);cell(row,item.status,item.status==='SENT'?'good':item.status==='PENDING'?'warn':'bad');
          cell(row,amount(item.amount));cell(row,item.attempts);cell(row,date(item.updatedAt));
        });
        document.getElementById('updated').textContent='Updated '+new Date().toLocaleTimeString();
      }catch(error){message.textContent=error instanceof Error?error.message:String(error);message.style.display='block'}
      finally{refreshButton.disabled=false}
    }
    refreshButton.addEventListener('click',()=>void load());
    void load();
    setInterval(()=>void load(),30000);
  </script>
</body>
</html>`;
}
