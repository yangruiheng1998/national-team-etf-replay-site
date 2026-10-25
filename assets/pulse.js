/* Historical research: native controls, one canonical event payload, no remote UI deps. */
(function (global) {
  'use strict';
  const SIGNALS = {relative:'相对异常',large:'百亿份脉冲',official:'官方公告'};
  const SIDES = {creation:'净申购',redemption:'净赎回'};
  const PARTS = {history:'较早历史',recent:'末尾252日',purged:'分区边界排除',pending:'待观察'};
  const percent = value => value == null ? '—' : `${(value*100).toFixed(2)}%`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
  function quantile(xs,q) {
    if (!xs.length) return null;
    const a=xs.slice().sort((x,y)=>x-y), p=(a.length-1)*q;
    return a[Math.floor(p)]+(a[Math.ceil(p)]-a[Math.floor(p)])*(p-Math.floor(p));
  }
  function wilson(wins,n) {
    if (!n) return null;
    const z=1.959963984540054,p=wins/n,scale=1+z*z/n;
    const c=(p+z*z/(2*n))/scale,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/scale;
    return [Math.max(0,c-h),Math.min(1,c+h)];
  }
  function describe(values,direction) {
    const n=values.length,sign=direction==='redemption'?-1:1;
    const up=values.filter(r=>r>0).length,hits=values.filter(r=>sign*r>0).length;
    return {n,up_rate:n?up/n:null,up_ci:wilson(up,n),hit_rate:n?hits/n:null,hit_ci:wilson(hits,n),
      mean:mean(values),median:quantile(values,0.5),p05:quantile(values,0.05),p95:quantile(values,0.95),
      evidence:n<30?'insufficient':'descriptive_only'};
  }
  function normalizeState(params,report) {
    const one=(key,values,fallback)=>values.includes(params.get(key))?params.get(key):fallback;
    const day=(key,fallback)=>/^\d{4}-\d{2}-\d{2}$/.test(params.get(key)||'')?params.get(key):fallback;
    return {signal:one('signal',Object.keys(SIGNALS),'relative'),basis:one('basis',['known','event'],'known'),
      code:one('code',['',...report.etfs.map(e=>e.code)],''),index:one('index',['',...report.etfs.map(e=>e.index_name)],''),
      direction:one('direction',['','creation','redemption'],''),segment:one('segment',['','history','recent'],''),
      horizon:[1,5,10,20,60].includes(Number(params.get('horizon')))?Number(params.get('horizon')):20,
      start:day('start',report.start),end:day('end',report.end),page:Math.max(1,Number.parseInt(params.get('page'),10)||1),event:params.get('event')||''};
  }
  function filterEvents(report,state) {
    const source=state.signal==='official'?report.announcements:report.events;
    return source.filter(e=>state.start<=e.date&&e.date<=state.end&&
      (state.signal==='official'||(e.signals.includes(state.signal)&&(!state.code||e.code===state.code)&&
      (!state.index||e.index_name===state.index)&&(!state.direction||e.direction===state.direction)))&&
      (!state.segment||e.views[state.basis].partition===state.segment)).slice().sort((a,b)=>b.date.localeCompare(a.date)||(a.code||'').localeCompare(b.code||''));
  }
  function decluster(events) {
    let last=-1e9;
    return events.slice().sort((a,b)=>a.position-b.position||a.date?.localeCompare(b.date)).filter(e=>{
      if(e.position-last<20)return false;last=e.position;return true;
    });
  }
  function paginate(events,page) {
    const pages=Math.max(1,Math.ceil(events.length/25));page=Math.max(1,Math.min(pages,page));
    return {page,pages,items:events.slice((page-1)*25,page*25)};
  }
  function summarize(report,state) {
    const groups=[];
    for(const etf of report.etfs) {
      if((state.code&&state.code!==etf.code)||(state.index&&state.index!==etf.index_name))continue;
      const candidates=report.events.filter(e=>e.code===etf.code&&e.signals.includes(state.signal)&&state.start<=e.date&&e.date<=state.end&&e.views[state.basis].position!=null);
      const selected=decluster(candidates.map(e=>({...e,position:e.views[state.basis].position})));
      for(const side of state.direction?[state.direction]:['creation','redemption']) {
        const eligible=selected.filter(e=>e.direction===side&&e.views[state.basis].partition!=='purged'&&(!state.segment||e.views[state.basis].partition===state.segment));
        const completed=eligible.filter(e=>e.views[state.basis].metrics[String(state.horizon)]);
        const values=completed.map(e=>e.views[state.basis].metrics[String(state.horizon)].target.return);
        const strata=new Set(completed.map(e=>`${e.views[state.basis].start_date.slice(0,4)}:${e.views[state.basis].partition}`));
        const base=(report.baselines[etf.index_code]||[]).filter(r=>state.start<=r.date&&r.date<=state.end&&r.partition!=='purged'&&strata.has(`${r.date.slice(0,4)}:${r.partition}`)&&r.returns[String(state.horizon)]!=null).map(r=>r.returns[String(state.horizon)]);
        const stats=describe(values,side),sign=side==='redemption'?-1:1,bm=mean(base);
        groups.push({code:etf.code,name:etf.name,index_name:etf.index_name,direction:side,...stats,pending:eligible.length-completed.length,
          baseline_n:base.length,baseline_mean:bm,baseline_hit_rate:base.length?base.filter(r=>sign*r>0).length/base.length:null,
          signed_mean_difference:values.length&&bm!=null?sign*(stats.mean-bm):null});
      }
    }
    return groups;
  }
  function csvCell(value) {
    let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  const api={normalizeState,filterEvents,decluster,paginate,describe,summarize,csvCell};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.PulseResearch=api;
  if(typeof document==='undefined')return;

  async function init() {
    const section=document.getElementById('pulse-research');if(!section)return;
    const status=document.getElementById('pulse-status');
    let report;
    try {
      const response=await fetch('data/pulse/report.json',{cache:'no-store'});
      if(!response.ok)throw new Error('尚未生成研究结果');
      report=await response.json();
      if(report.schema_version!==1)throw new Error('研究文件版本不兼容');
    } catch(error) {
      status.textContent=`${error.message}。请运行本地更新命令，再点“重新读取”。`;
      status.classList.add('pulse-warning');
      document.getElementById('pulse-retry').hidden=false;
      document.getElementById('pulse-retry').onclick=()=>location.reload();
      return;
    }
    const stale=await fetch('data/pulse/status.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);
    status.textContent=`数据截至 ${report.as_of} · 14只ETF / 7类指数 · 主要检验期20个交易日 · 时间分区 ${report.split_date} · 方法 ${report.method_version}`;
    if(stale?.state==='error') {
      const warning=document.getElementById('pulse-warning');warning.hidden=false;
      warning.textContent=`最近刷新未完成，当前保留 ${report.as_of} 的完整报告。原因：${stale.error}`;
    } else if(report.pending_etfs?.length) {
      const warning=document.getElementById('pulse-warning');warning.hidden=false;
      warning.textContent=`已按14只全部齐备的 ${report.as_of} 生成报告；${report.requested_as_of} 尚缺 ${report.pending_etfs.join('、')} 的份额。`;
    } else if((Date.now()-Date.parse(`${report.as_of}T15:00:00+08:00`))/864e5>4) {
      const warning=document.getElementById('pulse-warning');warning.hidden=false;
      warning.textContent=`当前报告距今超过4天，请更新本地数据；所有统计仍截至 ${report.as_of}。`;
    }
    const form=document.getElementById('pulse-filters');
    const add=(key,items)=>{for(const [value,label] of items){const option=document.createElement('option');option.value=value;option.textContent=label;form.elements[key].append(option);}};
    add('code',report.etfs.map(e=>[e.code,`${e.code} ${e.name}`]));
    add('index',[...new Set(report.etfs.map(e=>e.index_name))].map(n=>[n,n]));
    let state=normalizeState(new URLSearchParams(location.search),report), filtered=[], chart=null, timeline=null;
    for(const el of form.elements)if(el.name&&state[el.name]!=null)el.value=state[el.name];
    document.getElementById('pulse-content').hidden=false;
    const allCoverage=report.coverage.reduce((n,c)=>n+c.missing_days.length,0);
    document.getElementById('pulse-coverage').textContent=`份额覆盖：${report.coverage.map(c=>`${c.code} ${c.rows}条／缺${c.missing_days.length}日`).join('；')}。${allCoverage?'缺失记录已排除，不作填补。':'请求区间内份额完整。'} 原始来源摘要保留于事件详情。`;
    function setUrl(push=false) {
      const p=new URLSearchParams();for(const[k,v]of Object.entries(state))if(v!==''&&v!=null)p.set(k,String(v));
      const url=`${location.pathname}?${p}#pulse-research`;
      if(url===`${location.pathname}${location.search}${location.hash}`)return;
      if(push)history.pushState(null,'',url);else history.replaceState(null,'',url);
    }
    function showEvent(event,focus=false) {
      if(!event)return;
      state.event=event.id;setUrl(focus);
      const view=event.views[state.basis], meta=document.getElementById('pulse-detail-meta');
      document.getElementById('pulse-detail-title').textContent=`${event.date} · ${event.name||'中央汇金公开公告'}${event.code?' '+event.code:''}`;
      const title=event.title?`<p>${escape(event.title)}</p>`:'';
      const assumed=event.published_at_assumed||view.available_at_assumed;
      meta.innerHTML=`${title}<p>观察起点：<strong>${escape(view.start_date||'待观察')}</strong> · ${escape(PARTS[view.partition])} · ${state.basis==='event'?'事后观察口径':assumed?'发布时间不详，采用保守延迟假设':'使用已记录的公开时间'}</p>`+
        (event.code?`<p>原始前值 ${Number(event.previous_shares).toLocaleString('zh-CN')}份 → 当日 ${Number(event.shares).toLocaleString('zh-CN')}份；可比前值 ${Number(event.comparable_previous_shares).toLocaleString('zh-CN')}份。净变化 <strong>${(event.delta_shares/1e8).toFixed(4)}亿份</strong>，变化率 ${percent(event.rate)}。</p><p>命中：${event.signals.map(s=>SIGNALS[s]).join('、')}；此前有效观测 ${event.lookback_valid}，95分位 ${percent(event.threshold_rate)}；当日份额调整系数 ${event.adjustment_factor}。</p>`:'<p>仅确认公开表态，不推断具体ETF成交日期或金额。</p>')+
        `<p>${event.source_url?`<a href="${escape(event.source_url)}" target="_blank" rel="noopener noreferrer">核对原始来源 ↗</a>`:''} ${event.fetched_at?'抓取：'+escape(event.fetched_at):''}</p>`+
        (event.raw_sha256?`<p class="pulse-hash">存档响应 SHA-256：${escape(event.raw_sha256)}</p><p>存档形式：${event.archive_format==='normalized_json'?'规范化JSON（数值与字段保留；初次抓取的HTTP原字节未保留）':'HTTP响应原字节'}。</p>`:'');
      const body=document.getElementById('pulse-outcomes');
      body.innerHTML=[1,5,10,20,60].map(h=>{const m=view.metrics[String(h)];return `<tr${h===20?' class="pulse-primary"':''}><th scope="row">${h}日${h===20?' · 主要':''}</th><td>${m?percent(m.target.return):'待观察／缺数据'}</td><td>${m?percent(m.benchmark.return):'—'}</td><td>${m?percent(m.target.max_adverse):'—'}</td><td>${m?percent(m.target.max_drawdown):'—'}</td></tr>`;}).join('');
      document.getElementById('pulse-detail').hidden=false;
      const pos=view.position, axis=[], target=[], benchmark=[];
      if(pos!=null)for(let j=0;j<=60&&pos+j<report.calendar.length;j++){
        const a=report.index_series[event.index_code]?.[pos+j],b=report.index_series['000300'][pos+j];
        const a0=report.index_series[event.index_code]?.[pos],b0=report.index_series['000300'][pos];
        axis.push(`+${j}日`);target.push(a!=null&&a0?a/a0*100:null);benchmark.push(b!=null&&b0?b/b0*100:null);
      }
      const chartNode=document.getElementById('pulse-event-chart');
      if(global.echarts){chart||=global.echarts.init(chartNode,null,{renderer:'svg'});
        chart.setOption({animation:false,aria:{enabled:true},tooltip:{trigger:'axis',confine:true},legend:{data:[event.index_name||'对应指数','沪深300'],bottom:0},grid:{left:54,right:25,top:25,bottom:55},
          xAxis:{type:'category',data:axis},yAxis:{type:'value',scale:true,name:'起点=100'},
          series:[{name:event.index_name||'对应指数',type:'line',showSymbol:false,connectNulls:false,data:target,lineStyle:{color:'#1f5fbf',width:2}},
            {name:'沪深300',type:'line',showSymbol:false,connectNulls:false,data:benchmark,lineStyle:{color:'#787672',type:'dashed'}}]},true);
        requestAnimationFrame(()=>chart.resize());}
      document.getElementById('pulse-curve-note').textContent=pos==null?'尚未到观察起点。':'指数收盘价归一至100；缺失处断线。此图包含全部可见走势，主要统计另排除跨分区的60日窗口。';
      if(focus)document.getElementById('pulse-detail-title').focus();
    }
    function render() {
      const invalid=state.start>state.end;
      document.getElementById('pulse-filter-error').textContent=invalid?'开始日期不能晚于结束日期，请调整日期。':'';
      filtered=invalid?[]:filterEvents(report,state);
      const page=paginate(filtered,state.page);state.page=page.page;
      const official=state.signal==='official';
      for(const name of ['code','index','direction'])form.elements[name].disabled=official;
      document.getElementById('pulse-count').textContent=`${SIGNALS[state.signal]} · ${filtered.length}次原始事件 · 第${page.page}/${page.pages}页`;
      document.getElementById('pulse-stat-note').textContent=official?'公告仅作独立参照，样本很少，不与份额信号合并计算胜率。':`${state.horizon}日${state.horizon===20?'主要检验':'探索结果'}；先按ETF及规则取间隔至少20日的首次事件，再区分方向。60日结果仍可能重叠。表格各行分别统计，不汇总为“国家队胜率”。`;
      const groups=official||invalid?[]:summarize(report,state);
      document.getElementById('pulse-summary').innerHTML=groups.filter(g=>g.n||g.pending).map(g=>`<tr><th scope="row">${escape(g.name)}<br><code>${g.code}</code> · ${SIDES[g.direction]}</th><td>${g.n}${g.pending?`<small>待观察${g.pending}</small>`:''}</td><td>${percent(g.up_rate)}</td><td>${percent(g.hit_rate)}<small>${g.hit_ci?g.hit_ci.map(percent).join(' ～ '):'—'}</small></td><td>${percent(g.mean)}<small>中位 ${percent(g.median)}</small></td><td>${percent(g.p05)} ～ ${percent(g.p95)}</td><td>${percent(g.baseline_mean)}<small>n=${g.baseline_n} · 方向命中 ${percent(g.baseline_hit_rate)}</small></td><td>${percent(g.signed_mean_difference)}</td><td><span class="pulse-badge">${g.n<30?'证据不足':'仅描述性比较'}</span></td></tr>`).join('')||`<tr><td colspan="9">${official?'官方公告不进入这张ETF统计表。':'当前筛选下无完整、通过分区检查的统计样本；请查看原始事件或扩大日期范围。'}</td></tr>`;
      document.getElementById('pulse-events').innerHTML=page.items.map(e=>{const v=e.views[state.basis],m=v.metrics[String(state.horizon)];return `<tr><td><button class="pulse-event-button" type="button" data-event="${escape(e.id)}">${e.date}<span>查看复盘 →</span></button></td><td>${escape(e.name||e.title)}${e.code?`<small><code>${e.code}</code> · ${e.index_name}</small>`:''}</td><td>${e.code?SIDES[e.direction]:'公告'}</td><td>${e.code?(e.delta_shares/1e8).toFixed(2)+'亿份':'—'}</td><td>${escape(v.start_date||'待观察')}</td><td>${m?percent(m.target.return):'待观察／缺数据'}</td><td>${escape(PARTS[v.partition])}</td></tr>`;}).join('')||'<tr><td colspan="7">没有符合条件的事件。可重置筛选或选择另一种信号。</td></tr>';
      document.getElementById('pulse-prev').disabled=page.page===1;document.getElementById('pulse-next').disabled=page.page===page.pages;
      document.getElementById('pulse-page').textContent=`第 ${page.page} / ${page.pages} 页 · 每页25条`;
      const existing=filtered.find(e=>e.id===state.event)||page.items[0];
      if(existing)showEvent(existing);else{state.event='';document.getElementById('pulse-detail').hidden=true;}
      const timelineNode=document.getElementById('pulse-timeline');
      if(global.echarts){timeline||=global.echarts.init(timelineNode,null,{renderer:'svg'});
        const categories=[...new Set(filtered.map(e=>e.date))].sort();
        const data=categories.map(d=>({value:filtered.filter(e=>e.date===d).length,date:d}));
        timeline.setOption({animation:false,aria:{enabled:true},tooltip:{trigger:'axis',confine:true},grid:{left:42,right:20,top:15,bottom:35},xAxis:{type:'category',data:categories},yAxis:{type:'value',minInterval:1,name:'事件数'},series:[{type:'bar',name:'事件数',data,itemStyle:{color:'#1f5fbf'}}]},true);
        timeline.off('click');timeline.on('click',p=>{const event=filtered.find(e=>e.date===p.name);if(event)showEvent(event,true);});}
      setUrl();
    }
    form.addEventListener('change',()=>{for(const el of form.elements)if(el.name)state[el.name]=el.name==='horizon'?Number(el.value):el.value;state.page=1;state.event='';setUrl(true);render();});
    form.addEventListener('submit',e=>e.preventDefault());
    document.getElementById('pulse-reset').onclick=()=>{state=normalizeState(new URLSearchParams(),report);for(const el of form.elements)if(el.name)el.value=state[el.name];setUrl(true);render();};
    document.getElementById('pulse-prev').onclick=()=>{state.page--;setUrl(true);render();};document.getElementById('pulse-next').onclick=()=>{state.page++;setUrl(true);render();};
    document.getElementById('pulse-events').onclick=e=>{const button=e.target.closest('[data-event]');if(button)showEvent(filtered.find(row=>row.id===button.dataset.event),true);};
    function download(type) {
      const rows=filtered.map(e=>{const v=e.views[state.basis],m=v.metrics[String(state.horizon)];return {id:e.id,date:e.date,code:e.code||'',name:e.name||e.title,signal:state.signal,direction:e.direction||'official',delta_shares:e.delta_shares??null,rate:e.rate??null,basis:state.basis,start_date:v.start_date,horizon:state.horizon,partition:v.partition,return:m?.target.return??null,benchmark_return:m?.benchmark.return??null,max_adverse:m?.target.max_adverse??null,max_drawdown:m?.target.max_drawdown??null,source_url:e.source_url||'',raw_sha256:e.raw_sha256||'',method_version:report.method_version,input_sha256:report.input_sha256};});
      const columns=Object.keys(rows[0]||{id:'',date:'',code:'',return:''});
      const body=type==='json'?JSON.stringify({filters:state,as_of:report.as_of,method_version:report.method_version,input_sha256:report.input_sha256,parameters:report.parameters,events:rows,summary:state.signal==='official'?[]:summarize(report,state)},null,2):'\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(row=>row.map(csvCell).join(',')).join('\r\n');
      const url=URL.createObjectURL(new Blob([body],{type:type==='json'?'application/json;charset=utf-8':'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=`ETF复盘-${state.signal}-${report.as_of}.${type}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      document.getElementById('pulse-export-status').textContent=`已导出${rows.length}条筛选事件（${type.toUpperCase()}）。`;
    }
    document.getElementById('pulse-csv').onclick=()=>download('csv');document.getElementById('pulse-json').onclick=()=>download('json');
    window.addEventListener('resize',()=>{chart?.resize();timeline?.resize();});
    window.addEventListener('popstate',()=>{state=normalizeState(new URLSearchParams(location.search),report);for(const el of form.elements)if(el.name)el.value=state[el.name];render();});
    render();
  }
  init();
})(typeof window==='undefined'?globalThis:window);
