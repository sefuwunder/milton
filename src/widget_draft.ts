// widget_draft.ts — the natural flow for widget making.
//
// The user asks in chat ("build a widget that shows stalled deals"). Milton
// drafts a manifest + JS/CSS and files it as a Phase 3 proposal through
// crm.proposeWidget(). The proposal lands in exec-crm's proposal inbox;
// preview runs sandboxed on demo data; the user's approve tap is the
// permission grant — nothing installs from chat alone.
//
// Two drafting paths:
//   1. Deterministic templates (no LLM needed): hand-written widget JS with
//      only scalar parameters injected (stage, day thresholds). The code is
//      fixed; the chat text only picks the template and its parameters.
//   2. LLM drafting (MILTON_LLM_URL or the embedded sidecar): the model gets
//      a strict system prompt documenting the bridge and manifest rules, and
//      the result is validated here before it ever reaches exec-crm.

export const WIDGET_PERMISSIONS = [
  "deals:read", "deals:write",
  "contacts:read", "contacts:write",
  "companies:read", "companies:write",
  "tasks:read", "tasks:write",
  "outreach:read", "outreach:write",
  "feed:read",
] as const;

export const WIDGET_MAX_JS = 256 * 1024;
export const WIDGET_MAX_CSS = 64 * 1024;

export interface WidgetDraftSpec {
  title: string;
  rationale?: string;
  manifest: any;
  js: string;
  css?: string;
}

/** Draft-time validation mirroring exec-crm's rules, plus LLM-output safety:
 *  no `</script` sequences (the bundle is inlined into HTML) and no raw
 *  network primitives (a widget can only talk through the bridge — CSP
 *  connect-src 'none' would block them anyway, so a draft asking for them
 *  is either confused or hostile). */
export function validateWidgetDraft(spec: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, errors: ["spec must be an object"] };
  const m = spec.manifest;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    errors.push("manifest must be an object");
  } else {
    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(String(m.name || "")))
      errors.push("manifest.name must be a slug: lowercase letters, digits, - and _, 2-48 chars");
    const title = String(m.title || "").trim();
    if (!title || title.length > 80) errors.push("manifest.title is required (max 80 chars)");
    if (!/^\d+\.\d+\.\d+$/.test(String(m.version || "")))
      errors.push("manifest.version must be semver (e.g. 1.0.0)");
    if (String(m.mount || "") !== "dashboard")
      errors.push("manifest.mount must be \"dashboard\"");
    const perms = m.permissions;
    if (!Array.isArray(perms) || !perms.length || perms.length > 12) {
      errors.push("manifest.permissions must be a non-empty array (max 12)");
    } else {
      const seen = new Set<string>();
      for (const p of perms) {
        if (typeof p !== "string" || !(WIDGET_PERMISSIONS as readonly string[]).includes(p)) {
          errors.push(`unknown permission "${p}" — allowed: ${WIDGET_PERMISSIONS.join(", ")}`);
          break;
        }
        if (seen.has(p)) { errors.push(`duplicate permission "${p}"`); break; }
        seen.add(p);
      }
    }
    if (String(m.description || "").length > 280)
      errors.push("manifest.description is too long (max 280 chars)");
  }
  if (typeof spec.js !== "string" || !spec.js.trim()) {
    errors.push("js is required");
  } else {
    if (spec.js.length > WIDGET_MAX_JS) errors.push(`js is too large (${spec.js.length} > ${WIDGET_MAX_JS})`);
    if (/<\/script/i.test(spec.js)) errors.push("js must not contain a </script> sequence");
    if (/\bfetch\s*\(/.test(spec.js)) errors.push("js must not use fetch() — use execrm.api instead");
    if (/\bXMLHttpRequest\b/.test(spec.js)) errors.push("js must not use XMLHttpRequest — use execrm.api instead");
    if (/\bWebSocket\s*\(/.test(spec.js)) errors.push("js must not use WebSocket");
    if (/\bEventSource\s*\(/.test(spec.js)) errors.push("js must not use EventSource");
  }
  if (spec.css !== undefined) {
    if (typeof spec.css !== "string") errors.push("css must be a string");
    else {
      if (spec.css.length > WIDGET_MAX_CSS) errors.push(`css is too large (${spec.css.length} > ${WIDGET_MAX_CSS})`);
      if (/<\/script/i.test(spec.css)) errors.push("css must not contain a </script> sequence");
    }
  }
  return { ok: !errors.length, errors };
}

// ---- deterministic templates ------------------------------------------------
// Hand-written widget code; chat text only selects the template and injects
// scalar parameters (numbers, stage slugs) via JSON — no code is generated
// from freeform text on this path.

const STAGE_WORDS: Record<string, string> = {
  prospecting: "prospecting", prospect: "prospecting",
  qualification: "qualification", qualifying: "qualification", qualified: "qualification",
  proposal: "proposal", proposals: "proposal",
  negotiation: "negotiation", negotiating: "negotiation",
};

function findStageWord(desc: string): string | null {
  const t = desc.toLowerCase();
  for (const [word, slug] of Object.entries(STAGE_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return slug;
  }
  return null;
}

function findDays(desc: string, fallback: number): number {
  const m = desc.toLowerCase().match(/(\d{1,3})\s*(day|week)/);
  if (!m) return fallback;
  const n = Math.min(365, Math.max(1, parseInt(m[1], 10)));
  return m[2].startsWith("week") ? Math.min(365, n * 7) : n;
}

const money = `function money(n){n=Number(n)||0;var a=Math.abs(n);var s=a>=1e6?(n/1e6).toFixed(1)+"M":a>=1e3?(n/1e3).toFixed(1)+"k":String(Math.round(n));return"$"+s}`;
const daysAgo = `function daysAgo(iso){var m=String(iso||"").slice(0,10).match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);if(!m)return null;var t=new Date(+m[1],+m[2]-1,+m[3]).getTime();return Math.round((Date.now()-t)/864e5)}`;
const ymdNum = `function ymdNum(iso){return +String(iso||"").slice(0,10).replace(/-/g,"")}`;
const todayNum = `function todayNum(){var d=new Date();return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate()}`;
const escHtml = `function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}`;
const baseCss = `.wcard{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#141824}.wcard h3{margin:0 0 8px;font-size:13px;font-weight:650}.wrow{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #eee}.wrow:first-of-type{border-top:0}.wsub{color:#6b7280;font-size:12px}.wtag{font-size:11px;color:#8a6d3b;background:#f5efe6;border-radius:99px;padding:1px 8px;white-space:nowrap}.wempty{color:#6b7280;padding:12px 0}.wamt{font-variant-numeric:tabular-nums;white-space:nowrap}`;

function withCfg(js: string, cfg: Record<string, unknown>): string {
  // CFG carries only JSON scalars — it cannot inject code.
  return `var CFG=${JSON.stringify(cfg)};\n` + js;
}

export interface WidgetTemplate {
  id: string;
  example: string;
  match(desc: string): Record<string, unknown> | null;
  build(params: Record<string, unknown>): WidgetDraftSpec;
}

const TEMPLATES: WidgetTemplate[] = [
  {
    id: "stalled",
    example: "a widget that shows stalled deals",
    match(desc) {
      if (!/\b(stall\w*|stuck|untouched|neglect|gone quiet|idle|dormant|no movement)\b/i.test(desc)) return null;
      return { days: findDays(desc, 30), stage: findStageWord(desc) };
    },
    build(p) {
      const days = Number(p.days) || 30;
      const stage = p.stage ? String(p.stage) : null;
      const js = withCfg(`
${daysAgo}
${escHtml}
${money}
(function(){
  var root=document.getElementById("wroot");
  root.innerHTML='<div class="wcard"><h3>Stalled deals</h3><div class="wsub">Loading…</div></div>';
  execrm.api.get("/api/deals").then(function(r){
    var deals=(r.deals||[]).filter(function(d){return !String(d.stage||"").startsWith("closed_")});
    if(CFG.stage) deals=deals.filter(function(d){return d.stage===CFG.stage});
    var rows=deals.map(function(d){return{d:d,days:daysAgo(d.updated_at)}})
      .filter(function(x){return x.days!=null&&x.days>=CFG.days})
      .sort(function(a,b){return b.days-a.days}).slice(0,8);
    var labels=(r.labels||{});
    var html='<div class="wcard"><h3>Stalled deals <span class="wtag">'+rows.length+" · "+CFG.days+'d+</span></h3>';
    if(!rows.length){html+='<div class="wempty">Nothing stalled — pipeline is moving. 🎉</div>'}
    else{html+=rows.map(function(x){var d=x.d;
      return '<div class="wrow"><div><div>'+esc(d.title)+'</div><div class="wsub">'+esc(labels[d.stage]||d.stage)+(d.company_name?" · "+esc(d.company_name):"")+'</div></div><div style="text-align:right"><div class="wamt">'+money(d.value)+'</div><div class="wsub">'+x.days+'d untouched</div></div></div>'}).join("")}
    html+="</div>";root.innerHTML=html;
  }).catch(function(e){root.innerHTML='<div class="wcard wempty">Couldn\\'t load deals.</div>'});
})();`, { days, stage });
      return {
        title: "Stalled Radar",
        rationale: `Deals untouched ${days} or more days${stage ? ` in ${stage}` : ""} — the ones quietly dying.`,
        manifest: {
          name: "stalled-radar", title: "Stalled Radar", version: "1.0.0",
          mount: "dashboard", permissions: ["deals:read"],
          contextSlots: ["selectedDeal"],
          description: `Open deals untouched ${days}+ days, ranked by days idle.`,
        },
        js, css: baseCss,
      };
    },
  },
  {
    id: "overdue_tasks",
    example: "a widget for overdue tasks",
    match(desc) {
      if (!/\b(overdue|past[ -]due)\b/i.test(desc)) return null;
      if (/\bdeal/i.test(desc)) return null; // "overdue deals" isn't a task widget
      return {};
    },
    build() {
      const js = withCfg(`
${ymdNum}
${todayNum}
${escHtml}
(function(){
  var root=document.getElementById("wroot");
  root.innerHTML='<div class="wcard"><h3>Overdue tasks</h3><div class="wsub">Loading…</div></div>';
  execrm.api.get("/api/tasks").then(function(r){
    var t=todayNum();
    var rows=(r.tasks||[]).filter(function(x){return !x.done&&x.due_date&&ymdNum(x.due_date)<t})
      .sort(function(a,b){return ymdNum(a.due_date)-ymdNum(b.due_date)}).slice(0,8);
    var html='<div class="wcard"><h3>Overdue tasks <span class="wtag">'+rows.length+'</span></h3>';
    if(!rows.length){html+='<div class="wempty">Nothing overdue. 🎉</div>'}
    else{html+=rows.map(function(x){
      return '<div class="wrow"><div><div>'+esc(x.title)+'</div><div class="wsub">'+(x.deal_title?esc(x.deal_title)+" · ":"")+(x.owner?esc(x.owner):"")+'</div></div><div class="wtag">'+esc(String(x.due_date).slice(0,10))+'</div></div>'}).join("")}
    html+="</div>";root.innerHTML=html;
  }).catch(function(){root.innerHTML='<div class="wcard wempty">Couldn\\'t load tasks.</div>'});
})();`, {});
      return {
        title: "Overdue Tasks",
        rationale: "Tasks past their due date, oldest first — the morning's first screen.",
        manifest: {
          name: "overdue-tasks", title: "Overdue Tasks", version: "1.0.0",
          mount: "dashboard", permissions: ["tasks:read"],
          description: "Open tasks past their due date, oldest first.",
        },
        js, css: baseCss,
      };
    },
  },
  {
    id: "stage_counts",
    example: "a widget with pipeline by stage",
    match(desc) {
      if (!/\b(pipeline by stage|deals by stage|stage counts?|funnel|by stage)\b/i.test(desc)) return null;
      return {};
    },
    build() {
      const js = withCfg(`
${escHtml}
${money}
(function(){
  var root=document.getElementById("wroot");
  root.innerHTML='<div class="wcard"><h3>Pipeline by stage</h3><div class="wsub">Loading…</div></div>';
  execrm.api.get("/api/deals").then(function(r){
    var labels=r.labels||{};var order=r.stages||[];
    var by={};(r.deals||[]).forEach(function(d){if(String(d.stage).startsWith("closed_"))return;
      var b=by[d.stage]||(by[d.stage]={n:0,v:0});b.n++;b.v+=Number(d.value)||0});
    var total=Object.keys(by).reduce(function(a,k){return a+by[k].v},0);
    var html='<div class="wcard"><h3>Pipeline by stage</h3>';
    var keys=order.filter(function(k){return by[k]}).concat(Object.keys(by).filter(function(k){return order.indexOf(k)<0}));
    if(!keys.length){html+='<div class="wempty">No open deals.</div>'}
    else{html+=keys.map(function(k){var b=by[k];var pct=total?Math.round(b.v/total*100):0;
      return '<div class="wrow"><div><div>'+esc(labels[k]||k)+'</div><div class="wsub">'+b.n+' deal'+(b.n===1?"":"s")+'</div></div><div style="text-align:right"><div class="wamt">'+money(b.v)+'</div><div class="wsub">'+pct+'%</div></div></div>'}).join("")}
    html+="</div>";root.innerHTML=html;
  }).catch(function(){root.innerHTML='<div class="wcard wempty">Couldn\\'t load deals.</div>'});
})();`, {});
      return {
        title: "Pipeline by Stage",
        rationale: "Open deal counts and value per stage — the funnel at a glance.",
        manifest: {
          name: "pipeline-by-stage", title: "Pipeline by Stage", version: "1.0.0",
          mount: "dashboard", permissions: ["deals:read"],
          description: "Open deal counts and pipeline value per stage.",
        },
        js, css: baseCss,
      };
    },
  },
  {
    id: "closing_soon",
    example: "a widget for deals closing soon",
    match(desc) {
      if (!/\b(closing soon|close soon|closing this|closing in|expected to close|upcoming close)\b/i.test(desc)) return null;
      return { days: findDays(desc, 14) };
    },
    build(p) {
      const days = Number(p.days) || 14;
      const js = withCfg(`
${ymdNum}
${todayNum}
${escHtml}
${money}
(function(){
  var root=document.getElementById("wroot");
  root.innerHTML='<div class="wcard"><h3>Closing soon</h3><div class="wsub">Loading…</div></div>';
  execrm.api.get("/api/deals").then(function(r){
    var t=todayNum(),hi=t+CFG.days*1;
    function num(iso){var s=String(iso||"").slice(0,10).replace(/-/g,"");return s.length===8?+s:0}
    var rows=(r.deals||[]).filter(function(d){if(String(d.stage).startsWith("closed_"))return false;
      var n=num(d.expected_close);return n>=t&&n<=t+CFG.days})
      .sort(function(a,b){return num(a.expected_close)-num(b.expected_close)}).slice(0,8);
    var labels=(r.labels||{});
    var html='<div class="wcard"><h3>Closing soon <span class="wtag">'+rows.length+" · "+CFG.days+'d</span></h3>';
    if(!rows.length){html+='<div class="wempty">Nothing closing in the next '+CFG.days+' days.</div>'}
    else{html+=rows.map(function(d){
      return '<div class="wrow"><div><div>'+esc(d.title)+'</div><div class="wsub">'+esc(labels[d.stage]||d.stage)+(d.company_name?" · "+esc(d.company_name):"")+'</div></div><div style="text-align:right"><div class="wamt">'+money(d.value)+'</div><div class="wsub">'+esc(String(d.expected_close).slice(0,10))+'</div></div></div>'}).join("")}
    html+="</div>";root.innerHTML=html;
  }).catch(function(){root.innerHTML='<div class="wcard wempty">Couldn\\'t load deals.</div>'});
})();`, { days });
      return {
        title: "Closing Soon",
        rationale: `Deals expected to close in the next ${days} days — the short list to protect.`,
        manifest: {
          name: "closing-soon", title: "Closing Soon", version: "1.0.0",
          mount: "dashboard", permissions: ["deals:read"],
          contextSlots: ["selectedDeal"],
          description: `Open deals with an expected close date in the next ${days} days.`,
        },
        js, css: baseCss,
      };
    },
  },
];

export function matchTemplate(desc: string): { template: WidgetTemplate; params: Record<string, unknown> } | null {
  for (const t of TEMPLATES) {
    const params = t.match(desc);
    if (params) return { template: t, params };
  }
  return null;
}

export function buildFromTemplate(template: WidgetTemplate, params: Record<string, unknown>): WidgetDraftSpec {
  return template.build(params);
}

export function templateExamples(): string[] {
  return TEMPLATES.map((t) => t.example);
}

// ---- LLM drafting -----------------------------------------------------------

export function llmDraftSystemPrompt(): string {
  return `You draft exec-crm dashboard widgets. Respond with ONLY a single JSON object, no prose, no code fences:
{"title":"Short Title","rationale":"one sentence on why this helps","manifest":{...},"js":"...","css":"..."}
manifest: {"name":"slug-2-48-lowercase-letters-digits-dash","title":"Short Title","version":"1.0.0","mount":"dashboard","permissions":[...],"description":"at most 280 chars"}
permissions: choose the FEWEST needed from [deals:read,deals:write,contacts:read,contacts:write,companies:read,companies:write,tasks:read,tasks:write,outreach:read,outreach:write,feed:read]. Prefer read-only.
js: vanilla JS only, no libraries. It runs in a sandboxed iframe with a strict CSP (no network except the bridge) and renders into document.getElementById('wroot'). NEVER use fetch, XMLHttpRequest, WebSocket, or EventSource. NEVER include the literal sequence </script in js or css.
Bridge (window.execrm):
- execrm.api.get('/api/deals') -> {deals:[{id,title,value,stage,updated_at,expected_close,owner,company_name,contact_name}],stages:[slugs],labels:{slug:name}}
- execrm.api.get('/api/tasks') -> {tasks:[{id,title,due_date,done,owner,deal_id,deal_title}]}
- execrm.api.get('/api/contacts') -> {contacts:[{id,name,email,phone,company_name}]}
- execrm.api.get('/api/companies') -> {companies:[{id,name,deal_count,open_value}]}
- execrm.api.get('/api/outreach') -> {outreach:[{id,channel,happened_at,note,deal_title,contact_name}]}
- execrm.api.get('/api/daily-feed') -> the dashboard feed
- execrm.api.post/patch/del(path,body) for writes (only if you requested a write permission)
- execrm.context.get('selectedDeal'|'selectedContact'|'selectedCompany') -> object or null
- execrm.context.on(slot,fn), execrm.events.subscribe(topic,fn), execrm.notify(message)
Rules: keep js under ~200 lines, handle load errors with a friendly message, escape any CRM text you inject into HTML, dates are 'YYYY-MM-DD' strings, deal stages starting with 'closed_' are closed.
css: optional small stylesheet for the widget.`;
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export interface LlmDraftOpts {
  endpoint: string; // base, e.g. http://localhost:11434/v1
  model: string;
  key?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function draftWidgetViaLlm(
  desc: string,
  opts: LlmDraftOpts
): Promise<{ ok: true; spec: WidgetDraftSpec } | { ok: false; error: string }> {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 90000;
  let text = "";
  try {
    const res = await fetchImpl(opts.endpoint.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}) },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: llmDraftSystemPrompt() },
          { role: "user", content: `Draft a dashboard widget: ${desc}` },
        ],
        max_tokens: 2500,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j: any = await res.json();
        detail = typeof j?.error === "string" ? j.error : j?.error?.message || "";
      } catch { /* non-JSON */ }
      return { ok: false, error: `${res.status} from the model${detail ? `: ${detail}` : ""}` };
    }
    const j: any = await res.json();
    text = String(j.choices?.[0]?.message?.content || "").trim();
    if (!text) return { ok: false, error: "the model returned an empty draft" };
  } catch (e: any) {
    return { ok: false, error: `model request failed: ${String(e?.message || e).slice(0, 160)}` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return { ok: false, error: "the model didn't return valid JSON — try rephrasing the request" };
  }
  const v = validateWidgetDraft(parsed);
  if (!v.ok) return { ok: false, error: `the draft failed validation: ${v.errors[0]}` };
  return {
    ok: true,
    spec: {
      title: String(parsed.manifest.title),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
      manifest: parsed.manifest,
      js: parsed.js,
      css: typeof parsed.css === "string" ? parsed.css : undefined,
    },
  };
}
