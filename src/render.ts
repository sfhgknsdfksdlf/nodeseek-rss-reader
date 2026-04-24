import { boardOptions, displayBoard } from "./board";
import { escapeAttr, escapeHtml, highlightText } from "./filters";
import { getHighlightGroups } from "./posts";
import { formatBeijingTime } from "./time";
import type { Env, PageData, Post, User } from "./types";
import { styles } from "./styles";

function pageUrl(page: number, data: PageData): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (data.board) params.set("board", data.board);
  if (data.query) params.set("q", data.query);
  const qs = params.toString();
  return `/${qs ? `?${qs}` : ""}`;
}

function pager(data: PageData): string {
  const pages = [data.page, data.page + 1, data.page + 2, data.page + 3].filter((p) => p <= data.totalPages);
  return `<nav class="pager"><a class="page" href="${pageUrl(Math.max(1, data.page - 1), data)}">上一页</a>${pages.map((p) => `<a class="page ${p === data.page ? "current" : ""}" href="${pageUrl(p, data)}">${p}</a>`).join("")}<a class="page" href="${pageUrl(Math.min(data.totalPages, data.page + 1), data)}">下一页</a></nav>`;
}

function renderPost(post: Post, groups: Awaited<ReturnType<typeof getHighlightGroups>>): string {
  const title = highlightText(post.title, groups);
  return `<article class="card ${post.is_read ? "read" : ""}" data-open="/post/${post.id}/open"><div class="title">${title}</div><div class="body">${post.content_html}</div><div class="meta"><button class="author" data-copy="${escapeAttr(post.author || "")}">${escapeHtml(post.author || "")}</button><div class="board">${escapeHtml(displayBoard(post.board_key))}</div><time class="time">${escapeHtml(formatBeijingTime(post.published_at))}</time></div></article>`;
}

export async function renderHome(env: Env, user: User | null, data: PageData): Promise<Response> {
  const groups = await getHighlightGroups(env, user);
  const boardSelect = `<select name="board">${boardOptions.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === data.board ? "selected" : ""}>${label}</option>`).join("")}</select>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>NodeSeek RSS Reader</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><style>${styles}</style></head><body><main class="wrap"><header class="top"><a class="brand" href="/">NodeSeek RSS Reader</a><div class="auth">${user ? `<span class="muted hide-sm">${escapeHtml(user.username)}</span><button data-dialog="settings">设置</button><button id="logout">退出</button>` : `<button data-dialog="login">登录</button><button data-dialog="register" class="primary">注册</button>`}</div></header><form class="toolbar" action="/" method="get">${boardSelect}<input name="q" value="${escapeAttr(data.query)}" placeholder="正则搜索"><button class="primary">搜索</button></form>${pager(data)}<section>${data.posts.map((p) => renderPost(p, groups)).join("") || `<p class="muted">暂无帖子</p>`}</section>${pager(data)}<form class="jump" action="/" method="get"><input name="page" inputmode="numeric" value="${data.page}" aria-label="页码"><input type="hidden" name="board" value="${escapeAttr(data.board)}"><input type="hidden" name="q" value="${escapeAttr(data.query)}"><button>跳转</button></form></main><div class="float"><button id="toTop" aria-label="到顶部">⌃</button><button id="toBottom" aria-label="到底部">⌄</button></div>${dialogs(user)}<script>${clientScript()}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function dialogs(user: User | null): string {
  return `<dialog id="login"><div class="panel-head"><b>登录</b><button data-close>关闭</button></div><form class="grid" data-auth="/api/auth/login"><input name="username" placeholder="用户名"><input name="password" type="password" placeholder="密码"><button class="primary">登录</button></form></dialog><dialog id="register"><div class="panel-head"><b>注册</b><button data-close>关闭</button></div><form class="grid" data-auth="/api/auth/register"><input name="username" placeholder="用户名"><input name="password" type="password" placeholder="密码至少 6 位"><button class="primary">注册</button></form></dialog><dialog id="settings"><div class="panel-head"><b>设置</b><button data-close>关闭</button></div>${user ? settingsHtml(user) : ""}</dialog>`;
}

function settingsHtml(user: User): string {
  return `<div class="grid"><div class="row"><button data-load="highlights">高亮</button><button data-load="blocks">屏蔽</button><button data-load="subs">订阅</button></div><div class="rule"><b>邮箱</b><form class="row" data-put="/api/me/email"><input name="email" value="${escapeAttr(user.email || "")}" placeholder="收件邮箱"><button class="primary">保存</button></form></div><div class="rule"><b>Telegram</b><p class="muted">绑定码：${escapeHtml(user.telegram_bind_code || "")}</p><form class="row" data-put="/api/me/telegram"><input name="telegramChatId" value="${escapeAttr(user.telegram_chat_id || "")}" placeholder="Chat ID"><button class="primary">保存</button></form></div><div id="settingsBody" class="grid muted">选择高亮、屏蔽或订阅。</div></div>`;
}

function clientScript(): string {
  return `
document.querySelectorAll('[data-dialog]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.dialog).showModal());
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('[data-auth]').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const r=await fetch(f.dataset.auth,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});if(r.ok) location.reload(); else alert((await r.json()).error||'失败')});
document.getElementById('logout')?.addEventListener('click',async()=>{await fetch('/api/auth/logout',{method:'POST'});location.reload()});
document.querySelectorAll('[data-put]').forEach(f=>f.onsubmit=async e=>{e.preventDefault();const r=await fetch(f.dataset.put,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});alert(r.ok?'已保存':((await r.json()).error||'失败'))});
document.querySelectorAll('.card').forEach(c=>c.addEventListener('click',e=>{if(e.target.closest('[data-copy]'))return;c.classList.add('read');window.open(c.dataset.open,'_blank','noopener')}));
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const v=b.dataset.copy||'';try{await navigator.clipboard.writeText(v)}catch{const i=document.createElement('input');i.value=v;document.body.append(i);i.select();document.execCommand('copy');i.remove()}});
document.getElementById('toTop').onclick=()=>scrollTo({top:0,behavior:'smooth'});document.getElementById('toBottom').onclick=()=>scrollTo({top:document.body.scrollHeight,behavior:'smooth'});
async function api(method,url,body){const r=await fetch(url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)alert((await r.json()).error||'失败');return r}
document.querySelectorAll('[data-load]').forEach(b=>b.onclick=()=>loadSettings(b.dataset.load));
async function loadSettings(type){window.settingType=type;const box=document.getElementById('settingsBody');let url=type==='highlights'?'/api/highlight-groups':type==='blocks'?'/api/block-rules':'/api/subscriptions';const data=await (await fetch(url)).json();box.className='grid';if(type==='highlights'){box.innerHTML='<a class="btn" href="/api/export/highlights" target="_blank">导出</a><form class="row" id="newGroup"><input name="name" placeholder="分组名"><input name="color" type="color" value="#ffe066"><button class="primary">添加分组</button></form>'+data.map(g=>'<div class="rule"><div class="group-title"><span class="swatch" style="background:'+g.color+'"></span><b>'+g.name+'</b><button data-clear="'+g.id+'">清空</button><button class="danger" data-del-group="'+g.id+'">删除</button></div><div class="keywords">'+g.patterns.map(p=>'<span class="chip">'+p+'</span>').join('')+'</div><form class="row" data-add-rule="'+g.id+'"><input name="pattern" placeholder="关键字正则"><button class="primary">添加</button></form></div>').join('');document.getElementById('newGroup').onsubmit=async e=>{e.preventDefault();await api('POST',url,Object.fromEntries(new FormData(e.target)));loadSettings(type)}}else{box.innerHTML='<a class="btn" href="/api/export/'+(type==='blocks'?'blocks':'subscriptions')+'" target="_blank">导出</a><form class="row" id="newRule"><input name="pattern" placeholder="正则表达式"><button class="primary">添加</button></form>'+data.map(r=>'<div class="rule row"><span class="chip">'+r.pattern+'</span><button class="danger" data-del="'+r.id+'">删除</button></div>').join('');document.getElementById('newRule').onsubmit=async e=>{e.preventDefault();await api('POST',url,Object.fromEntries(new FormData(e.target)));loadSettings(type)}}}
document.addEventListener('submit',async e=>{const f=e.target;if(f.dataset.addRule){e.preventDefault();const group=await (await fetch('/api/highlight-groups')).json();const g=group.find(x=>String(x.id)===String(f.dataset.addRule));await api('PUT','/api/highlight-groups/'+f.dataset.addRule,{name:g.name,color:g.color,patterns:[...g.patterns,Object.fromEntries(new FormData(f)).pattern]});loadSettings('highlights')}});
document.addEventListener('click',async e=>{const t=e.target;if(t.dataset.del){const type=window.settingType||'blocks';await api('DELETE',(type==='subs'?'/api/subscriptions/':'/api/block-rules/')+t.dataset.del);loadSettings(type)}if(t.dataset.delGroup){await api('DELETE','/api/highlight-groups/'+t.dataset.delGroup);loadSettings('highlights')}if(t.dataset.clear){await api('POST','/api/highlight-groups/'+t.dataset.clear+'/clear');loadSettings('highlights')}});
`;
}
