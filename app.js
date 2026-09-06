'use strict';

/* =========================================================
 * 豆沙馅和下雨天 · 课程管理平台
 * 前端逻辑：周次计算 / 课表网格 / 课程提醒 / 作业双人状态 /
 *          量化加分六栏 / 多维筛选 / 待办提醒 / 实时保存
 * ========================================================= */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

let state = null;
let activeView = 'dash';
let activePerson = 'both';
let selWeek = 1;
let saveTimer = null;

/* 运行模式：'server' = 有 Node 后端，数据存 data/state.json
            'browser' = 静态托管（线上），数据存浏览器 localStorage */
let mode = 'server';
const LS_KEY = 'course-hub-state-v1';

function loadFromBrowser() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveToBrowser() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    return true;
  } catch (e) { return false; }
}

function buildFromClientSeed() {
  if (typeof CourseHubSeed === 'undefined') return null;
  return CourseHubSeed.buildSeed();
}

/* 背景动画开关（按浏览器记忆，不进数据文件） */
function bgEnabled() {
  try { return localStorage.getItem('coursehub-bg') !== 'off'; } catch (e) { return true; }
}

function applyBg() {
  if (!window.CourseHubBg) return;
  if (bgEnabled()) window.CourseHubBg.enable(); else window.CourseHubBg.disable();
}

/* ---------------- 浏览器弹窗提醒 ----------------
 * 页面打开期间有效：考试开始前 60/30/10 分钟、作业与待办当天截止未完成，
 * 触发系统级弹窗（Notification API）。短信/邮箱需付费网关，暂未接入。 */

function notifyAllowed() {
  return 'Notification' in window && Notification.permission === 'granted';
}

function pushNotify(title, body) {
  if (notifyAllowed()) {
    try { new Notification(title, { body: body }); return; } catch (e) { /* 降级 toast */ }
  }
  toast('⏰ ' + title + '：' + body);
}

function checkAlarms() {
  if (!state) return;
  const now = new Date();
  const dayKey = dateKey(now);
  let flags = {};
  try { flags = JSON.parse(localStorage.getItem('coursehub-notified') || '{}'); } catch (e) { flags = {}; }
  let changed = false;
  const fire = (key, title, body) => {
    if (flags[key]) return;
    flags[key] = 1; changed = true;
    pushNotify(title, body);
  };

  /* 考试：开始前 60 / 30 / 10 分钟 */
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const dt = new Date(x.date);
      if (isNaN(dt)) return;
      const mins = Math.round((dt - now) / 60000);
      [60, 30, 10].forEach((mark) => {
        if (mins <= mark && mins > mark - 2) {
          fire(dayKey + '-exam-' + x.id + '-' + mark, '⏰ 考试提醒',
            (x.title || '考试') + '（' + (c.shortName || c.name) + '）将于 ' + Math.max(0, mins) + ' 分钟后开始' + (x.location ? '，地点 ' + x.location : ''));
        }
      });
    });
  });

  /* 作业：当天截止且未完成（每天提醒一次） */
  state.assignments.forEach((a) => {
    if (!a.due) return;
    const d = new Date(a.due);
    if (startOfDay(d) - startOfDay(now) !== 0) return;
    const pending = state.people.some((p) => !hwStatus(a, p.id).done);
    if (!pending) return;
    fire(dayKey + '-hw-' + a.id, '📌 作业今天截止', a.title + '（' + ((courseById(a.courseId) || {}).name || '') + '）今天截止，记得完成');
  });

  /* 待办：当天到期且未完成 */
  (state.todos || []).forEach((t) => {
    if (!t.due) return;
    const d = new Date(t.due);
    if (startOfDay(d) - startOfDay(now) !== 0) return;
    const pending = todoOwners(t).some((p) => !hwStatus(t, p.id).done);
    if (!pending) return;
    fire(dayKey + '-td-' + t.id, '📌 待办今天到期', t.title);
  });

  if (changed) { try { localStorage.setItem('coursehub-notified', JSON.stringify(flags)); } catch (e) { /* 忽略 */ } }
}

/* 深浅色主题 */
function themeDark() {
  try { return localStorage.getItem('coursehub-theme') === 'dark'; } catch (e) { return false; }
}

function applyTheme() {
  const dark = themeDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const b = $('#themeBtn');
  if (b) b.textContent = dark ? '☀' : '🌙';
  window.dispatchEvent(new CustomEvent('coursehub-theme', { detail: { dark: dark } }));
}

function toggleTheme() {
  try { localStorage.setItem('coursehub-theme', themeDark() ? 'light' : 'dark'); } catch (e) { /* 忽略 */ }
  applyTheme();
  toast(themeDark() ? '已切换到深色模式' : '已切换到浅色模式');
}

const FILTERS = {
  hw: { courseId: 'all', person: 'both', status: 'all' },
  course: { type: 'all', keyword: '' },
  score: { person: 'both', category: 'all', month: 'all' }
};

/* ---------------- 工具函数 ---------------- */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
}

function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}

function fmtTime(d) { if (!d || isNaN(d)) return '—'; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

function fmtDateShort(d) { if (!d || isNaN(d)) return '—'; return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

function dayIndexMon1(d) { const w = d.getDay(); return w === 0 ? 7 : w; }

function slotById(id) { return (state.slots || []).filter((s) => s.id === id)[0] || null; }

function courseById(id) { return state.courses.filter((c) => c.id === id)[0] || null; }

function personById(id) { return state.people.filter((p) => p.id === id)[0] || state.people[0]; }

function catById(id) { return state.scoreCategories.filter((c) => c.id === id)[0] || { id: id, name: '未分类', short: '未分类' }; }

/** 解析周次表达式：'1~17' / '1~17(单)' / '2~18(双)' / '2,10' / '1~3(单),4~9,11~16' */
function parseWeeks(expr) {
  const out = {};
  if (!expr) return out;
  String(expr).split(/[,，]/).forEach((raw) => {
    let part = raw.trim();
    if (!part) return;
    let parity = 0;
    if (/单/.test(part)) parity = 1;
    else if (/双/.test(part)) parity = 2;
    part = part.replace(/[()（）单双\s]/g, '');
    const range = /^(\d+)[~～\-](\d+)$/.exec(part);
    if (range) {
      const a = +range[1], b = +range[2];
      for (let w = Math.min(a, b); w <= Math.max(a, b); w++) {
        if (parity === 1 && w % 2 === 0) continue;
        if (parity === 2 && w % 2 === 1) continue;
        out[w] = true;
      }
    } else if (/^\d+$/.test(part)) {
      out[+part] = true;
    }
  });
  return out;
}

function termStartDate() { return parseDateKey(state.meta.termStart) || startOfDay(new Date()); }

function currentWeek() {
  const diff = Math.floor((startOfDay(new Date()) - termStartDate()) / 86400000);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

function weekDayDate(week, day) {
  const s = termStartDate();
  return new Date(s.getTime() + ((week - 1) * 7 + (day - 1)) * 86400000);
}

/* ---------------- 作业状态 ---------------- */

/* 录入对象判定：作业/考试是否归属某人（owner: 'both' | 'me' | 'rain'，缺省 both） */
function hwApplies(item, pid) {
  return !item.owner || item.owner === 'both' || item.owner === pid;
}

/* 录入对象徽章（仅归属单人时显示） */
function ownerBadge(item) {
  if (!item.owner || item.owner === 'both') return '';
  const p = personById(item.owner);
  return p ? ' <span class="badge">仅' + esc(p.name) + '</span>' : '';
}

function hwStatus(a, pid) {
  if (!a.status) a.status = {};
  if (!a.status[pid]) a.status[pid] = { done: false, doneAt: null, note: '' };
  return a.status[pid];
}

function isOverdue(a, pid) {
  const st = hwStatus(a, pid);
  if (st.done || !a.due) return false;
  return new Date(a.due) < new Date();
}

function dueInfo(a) {
  if (!a.due) return { text: '未设截止', cls: '' };
  const d = new Date(a.due);
  const now = new Date();
  const diffDays = Math.floor((startOfDay(d) - startOfDay(now)) / 86400000);
  const t = fmtTime(d);
  if (diffDays < 0) return { text: '逾期 ' + (-diffDays) + ' 天（' + fmtDateShort(d) + ' ' + t + '）', cls: 'danger' };
  if (diffDays === 0) return { text: '今天 ' + t + ' 截止', cls: 'warn' };
  if (diffDays === 1) return { text: '明天 ' + t + ' 截止', cls: 'warn' };
  if (diffDays <= 3) return { text: diffDays + ' 天后截止（' + fmtDateShort(d) + ' ' + t + '）', cls: 'warn' };
  return { text: fmtDateShort(d) + ' ' + t + ' 截止', cls: '' };
}

function hwSortKey(a) { return a.due ? new Date(a.due).getTime() : 8e15; }

/* ---------------- 数据保存 ---------------- */

function setSaveState(s, text) {
  const chip = $('#saveChip');
  if (!chip) return;
  chip.dataset.state = s;
  $('.save-text', chip).textContent = text
    || (s === 'idle' ? (mode === 'remote' ? '已云端同步' : mode === 'server' ? '已保存' : '已存本机')
      : s === 'saving' ? '保存中…' : '保存失败');
}

/* Supabase 云端同步（remote 模式）：anon/publishable key 为公开密钥，可置于前端 */
const SUPA_URL = 'https://chbkxgjzfkfcauiqocjz.supabase.co';
const SUPA_KEY = 'sb_publishable_A4w8K90dqkgWShYif-1WXg_UpErnZil';

function supaHeaders(withAuth) {
  const h = {
    'apikey': SUPA_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  if (withAuth) h['Authorization'] = 'Bearer ' + SUPA_KEY;
  return h;
}

/* 先只带 apikey，若 401 再补 Authorization 重试 */
async function supaFetch(path, opts) {
  const base = opts || {};
  let last = null;
  for (const withAuth of [false, true]) {
    const r = await fetch(SUPA_URL + path, {
      method: base.method || 'GET',
      headers: supaHeaders(withAuth),
      body: base.body
    });
    if (r.status !== 401) return r;
    last = r;
  }
  return last;
}

async function supaLoad() {
  const r = await supaFetch('/rest/v1/app_state?id=eq.1&select=data,updated_at');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const arr = await r.json();
  if (!arr || !arr.length || !arr[0].data) return { empty: true };
  return { empty: false, data: arr[0].data, updatedAt: arr[0].updated_at };
}

async function supaSave(stateObj) {
  const now = new Date().toISOString();
  let r = await supaFetch('/rest/v1/app_state?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({ data: stateObj, updated_at: now })
  });
  if (!r.ok) {
    r = await supaFetch('/rest/v1/app_state', {
      method: 'POST',
      body: JSON.stringify({ id: 1, data: stateObj, updated_at: now })
    });
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

/* ---------------- 数据安全网 ----------------
 * 1) 快照：每次保存前，把上一份已保存的数据滚动存档（最多 6 份），出事可回滚；
 * 2) 空数据保护阀：云端模式下，若本地内容计数从有到无（疑似被清空），
 *    拒绝写入云端，防止崩溃页面把空数据覆盖上去。 */

function countContent(st) {
  let e = 0;
  (st.courses || []).forEach((c) => { (c.exams || []).forEach(() => { e++; }); });
  return {
    courses: (st.courses || []).length,
    a: (st.assignments || []).length,
    t: (st.todos || []).length,
    s: (st.scores || []).length,
    e: e
  };
}

function readLastCloudCounts() {
  try { return JSON.parse(localStorage.getItem('coursehub-lastcounts') || 'null'); } catch (e) { return null; }
}

function writeLastCloudCounts(st) {
  try { localStorage.setItem('coursehub-lastcounts', JSON.stringify(countContent(st))); } catch (e) { /* 忽略 */ }
}

function pushSnapshot() {
  try {
    const prev = loadFromBrowser();               // localStorage 里是上一次保存的数据 = 本次改动前
    if (!prev || !Array.isArray(prev.courses)) return;
    const snaps = JSON.parse(localStorage.getItem('coursehub-snapshots') || '[]');
    if (snaps.length && JSON.stringify(snaps[0].data) === JSON.stringify(prev)) return; // 无变化不重复存
    snaps.unshift({ at: new Date().toISOString(), counts: countContent(prev), data: prev });
    if (snaps.length > 6) snaps.length = 6;
    localStorage.setItem('coursehub-snapshots', JSON.stringify(snaps));
  } catch (e) { /* 快照失败不影响保存 */ }
}

function readSnapshots() {
  try { return JSON.parse(localStorage.getItem('coursehub-snapshots') || '[]'); } catch (e) { return []; }
}

function save(immediate) {
  clearTimeout(saveTimer);

  /* 云端模式：写 Supabase + 本地缓存兜底 */
  if (mode === 'remote') {
    const runRemote = () => {
      /* 空数据保护阀：上次云端有内容、这次全为空 → 拦截，防止事故式覆盖 */
      const last = readLastCloudCounts();
      const lastTotal = last ? (last.a + last.t + last.s + last.e) : 0;
      const nowC = countContent(state);
      const nowTotal = nowC.a + nowC.t + nowC.s + nowC.e;
      if (lastTotal > 0 && nowTotal === 0 && nowC.courses >= 5) {
        setSaveState('error', '已拦截');
        toast('⚠️ 检测到数据疑似被清空（原 ' + lastTotal + ' 条 → 0 条），已阻止覆盖云端。请到「设置 → 历史快照」恢复。', true);
        return;
      }
      pushSnapshot();
      setSaveState('saving', '同步中…');
      saveToBrowser();
      supaSave(state)
        .then(() => { writeLastCloudCounts(state); setSaveState('idle', '已云端同步'); })
        .catch((e) => {
          setSaveState('error', '同步失败');
          toast('云端同步失败（数据已存本机缓存）：' + e.message, true);
        });
    };
    if (immediate) runRemote();
    else saveTimer = setTimeout(runRemote, 500);
    return;
  }

  /* 无后端：写浏览器 localStorage */
  if (mode === 'browser') {
    const runLocal = () => {
      setSaveState('saving', '保存中…');
      if (saveToBrowser()) setSaveState('idle', '已存本机');
      else { setSaveState('error', '保存失败'); toast('浏览器存储不可用，请检查隐私模式设置', true); }
    };
    if (immediate) runLocal();
    else saveTimer = setTimeout(runLocal, 400);
    return;
  }

  const run = () => {
    setSaveState('saving', '保存中…');
    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok) setSaveState('idle', '已保存');
        else { setSaveState('error', '保存失败'); toast('保存失败：' + (j.error || '未知错误'), true); }
      })
      .catch((e) => { setSaveState('error', '保存失败'); toast('保存失败：' + e.message, true); });
  };
  if (immediate) run();
  else saveTimer = setTimeout(run, 400);
}

function toast(msg, isErr) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2200);
}

/* ---------------- ICS 日历导出（参考 GitHub 同类项目的高频功能） ---------------- */

function icsEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function icsStamp(d) {
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
    + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}

function buildICS() {
  const start = termStartDate();
  const now = new Date();
  const totalWeeks = state.meta.totalWeeks || 18;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CourseHub//课程管理平台//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape((state.meta.termName || '课表') + ' · ' + state.meta.className),
    'X-WR-TIMEZONE:Asia/Shanghai'
  ];

  state.courses.forEach((c) => {
    c.sessions.forEach((s) => {
      const slot = slotById(s.slot);
      if (!slot) return;
      const weeks = parseWeeks(s.weeks);
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      for (let w = 1; w <= totalWeeks; w++) {
        if (!weeks[w]) continue;
        const day = new Date(start.getTime() + ((w - 1) * 7 + (s.day - 1)) * 86400000);
        if (day < startOfDay(now)) continue; // 已过去的课不再导出
        const evStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
        const evEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
        const pad = (n) => pad2(n);
        const f = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
        lines.push(
          'BEGIN:VEVENT',
          'UID:coursehub-' + c.id + '-' + s.day + '-' + s.slot + '-' + w + '@course.hub',
          'DTSTAMP:' + icsStamp(now),
          'DTSTART:' + f(evStart),
          'DTEND:' + f(evEnd),
          'SUMMARY:' + icsEscape(c.name),
          'LOCATION:' + icsEscape((c.campus ? c.campus + ' ' : '') + (s.room || '待定')),
          'DESCRIPTION:' + icsEscape('教师：' + (c.teacher || '待定') + '｜第' + w + '周｜' + slot.label),
          'BEGIN:VALARM',
          'TRIGGER:-PT' + (c.remindBefore || 30) + 'M',
          'ACTION:DISPLAY',
          'DESCRIPTION:' + icsEscape(c.name + ' ' + slot.start + ' 上课'),
          'END:VALARM',
          'END:VEVENT'
        );
      }
    });
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function downloadICS() {
  const blob = new Blob([buildICS()], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '课表-' + dateKey(new Date()) + '.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('日历已导出，可导入手机/电脑日历');
}

/* ---------------- 弹窗 ---------------- */

let modalOnClose = null;
let openDetailId = null;

function openModal(title, bodyHTML, buttons) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  (buttons || []).forEach((b) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
    el.textContent = b.label;
    el.dataset.mbtn = b.key || '';
    foot.appendChild(el);
  });
  $('#modalRoot').hidden = false;
  modalOnClose = null;
  const first = $('#modalBody input, #modalBody select, #modalBody textarea');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeModal() {
  $('#modalRoot').hidden = true;
  $('#modalBody').innerHTML = '';
  $('#modalFoot').innerHTML = '';
  openDetailId = null;
  if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
}

function confirmModal(title, message, onYes) {
  modalOnClose = null;
  openModal(title, '<p style="margin:0;color:var(--text-2)">' + esc(message) + '</p>', [
    { label: '取消', key: 'cancel' },
    { label: '确定', key: 'yes', primary: true }
  ]);
  modalOnClose = null;
  const foot = $('#modalFoot');
  const yes = $('[data-mbtn="yes"]', foot);
  if (yes) yes.onclick = () => { closeModal(); onYes(); };
}

/* ---------------- 视图：概览 ---------------- */

function currentSession() {
  const week = Math.max(1, currentWeek());
  const today = dayIndexMon1(new Date());
  const mins = nowMinutes();
  const out = [];
  state.courses.forEach((c) => {
    c.sessions.forEach((s) => {
      if (s.day !== today) return;
      if (!parseWeeks(s.weeks)[week]) return;
      const slot = slotById(s.slot);
      if (!slot) return;
      if (mins >= toMinutes(slot.start) && mins < toMinutes(slot.end)) out.push({ course: c, s: s, slot: slot });
    });
  });
  return out[0] || null;
}

function nextClassInfo() {
  const week = Math.max(1, currentWeek());
  if (currentWeek() <= 0) return null;
  const today = dayIndexMon1(new Date());
  const mins = nowMinutes();
  const cands = [];
  state.courses.forEach((c) => {
    c.sessions.forEach((s) => {
      if (s.day !== today) return;
      if (!parseWeeks(s.weeks)[week]) return;
      const slot = slotById(s.slot);
      if (!slot) return;
      if (toMinutes(slot.start) <= mins) return;
      cands.push({ course: c, s: s, slot: slot });
    });
  });
  cands.sort((a, b) => toMinutes(a.slot.start) - toMinutes(b.slot.start));
  return cands[0] || null;
}

function sessionsOn(date) {
  /* 未开学（第 0 周）没有课 */
  if (currentWeek() <= 0) return [];
  const week = currentWeek();
  const day = dayIndexMon1(date);
  const out = [];
  state.courses.forEach((c) => {
    c.sessions.forEach((s) => {
      if (s.day !== day) return;
      if (!parseWeeks(s.weeks)[week]) return;
      const slot = slotById(s.slot);
      if (slot) out.push({ course: c, s: s, slot: slot });
    });
  });
  out.sort((a, b) => toMinutes(a.slot.start) - toMinutes(b.slot.start));
  return out;
}

function todaySessions() { return sessionsOn(new Date()); }

function upcomingReminders() {
  const now = new Date();
  const out = [];
  state.courses.forEach((c) => {
    (c.reminders || []).forEach((r) => {
      if (r.done) return;
      out.push({ course: c, r: r });
    });
  });
  out.sort((a, b) => new Date(a.r.datetime || 0) - new Date(b.r.datetime || 0));
  return out.filter((x) => {
    const d = new Date(x.r.datetime || 0);
    return d - now < 7 * 86400000;
  });
}

function cnNum(n) {
  const d = '零一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + d[n % 10];
  const t = Math.floor(n / 10), o = n % 10;
  return d[t] + '十' + (o ? d[o] : '');
}

function renderMasthead() {
  const now = new Date();
  const cw = currentWeek();
  const total = state.meta.totalWeeks || 18;
  const dateLine = cnNum(now.getMonth() + 1) + '月' + cnNum(now.getDate()) + '日 · 星期' + '一二三四五六日'[dayIndexMon1(now) - 1];
  let weekLine, pct = 0, pctLabel = '';
  if (cw <= 0) {
    const days = Math.ceil((termStartDate() - startOfDay(now)) / 86400000);
    weekLine = '距开学还有 ' + days + ' 天';
    pct = 0; pctLabel = '未开始';
  } else {
    weekLine = '第 ' + cw + ' 周 · 共 ' + total + ' 周';
    pct = Math.min(100, Math.max(0, Math.round(((cw - 0.5) / total) * 100)));
    pctLabel = pct + '%';
  }
  return '<div class="masthead">'
    + '<div class="mh-left"><div class="mh-date">' + esc(dateLine) + '</div>'
    + '<div class="mh-sub">' + esc(state.meta.termName) + ' · ' + esc(weekLine) + '</div></div>'
    + '<div class="mh-right"><div class="mh-progress"><div class="mh-bar" style="width:' + pct + '%"></div>'
    + '<div class="mh-mark" style="left:' + (100 / total * Math.min(cw || 0.01, total)) + '%"></div></div>'
    + '<span class="mh-pct">' + esc(pctLabel) + '</span></div>'
    + '</div>';
}

/* 概览顶部：墨蓝驾驶舱横幅（日期周次进度 + 下一节课倒计时） */
function renderDashHero(ongoing, next) {
  const now = new Date();
  const cw = currentWeek();
  const total = state.meta.totalWeeks || 18;
  const dateLine = cnNum(now.getMonth() + 1) + '月' + cnNum(now.getDate()) + '日 · 星期' + '一二三四五六日'[dayIndexMon1(now) - 1];
  let pct = 0, weekLine;
  if (cw <= 0) {
    weekLine = '距开学 ' + Math.ceil((termStartDate() - startOfDay(now)) / 86400000) + ' 天';
  } else {
    pct = Math.min(100, Math.max(0, Math.round(((cw - 0.5) / total) * 100)));
    weekLine = '第 ' + cw + ' 周 · 共 ' + total + ' 周';
  }
  let right = '';
  if (ongoing) {
    const left = toMinutes(ongoing.slot.end) - nowMinutes();
    const span = toMinutes(ongoing.slot.end) - toMinutes(ongoing.slot.start);
    const prog = Math.round(((span - left) / span) * 100);
    right = '<div class="dh-label dh-label-now">● 正在进行</div>'
      + '<div class="dh-name">' + esc(ongoing.course.name) + '</div>'
      + '<div class="dh-meta">' + esc(ongoing.slot.start) + ' - ' + esc(ongoing.slot.end) + ' · ' + esc(ongoing.s.room || '教室待定') + '</div>'
      + '<div class="mh-progress dh-prog"><div class="mh-bar" style="width:' + prog + '%"></div></div>'
      + '<div class="dh-count-wrap"><span class="dh-count">' + left + '</span><span class="dh-unit">分钟后下课</span></div>';
  } else if (next && cw > 0) {
    const left = toMinutes(next.slot.start) - nowMinutes();
    const when = left >= 60 ? Math.floor(left / 60) + 'h' + (left % 60 ? (left % 60) + "'" : '') : left + "'";
    right = '<div class="dh-label">下一节课</div>'
      + '<div class="dh-name">' + esc(next.course.name) + '</div>'
      + '<div class="dh-meta">' + esc(next.slot.start) + ' 上课 · ' + esc(next.s.room || '教室待定') + '</div>'
      + '<div class="dh-count-wrap"><span class="dh-count">' + when + '</span><span class="dh-unit">后上课</span></div>';
  } else {
    const days = Math.ceil((termStartDate() - startOfDay(now)) / 86400000);
    right = '<div class="dh-label">' + (cw > 0 ? '今日课程已结束' : '尚未开学') + '</div>'
      + '<div class="dh-name">' + (cw > 0 ? '明天见 ☾' : '准备开学') + '</div>'
      + '<div class="dh-meta">' + (cw > 0 ? '或去作业页看看还有什么没做' : '距开学 ' + days + ' 天，先把作业和待办理一理') + '</div>';
  }
  return '<div class="dash-hero">'
    + '<div class="dh-left">'
    + '<div class="dh-date">' + esc(dateLine) + '</div>'
    + '<div class="dh-sub">' + esc(state.meta.termName) + ' · ' + esc(weekLine) + '</div>'
    + '<div class="mh-progress dh-prog"><div class="mh-bar" style="width:' + pct + '%"></div></div>'
    + '</div>'
    + '<div class="dh-divider"></div>'
    + '<div class="dh-right">' + right + '</div>'
    + '</div>';
}

function renderDash() {
  const cw = currentWeek();
  const week = Math.max(1, cw);
  const today = todaySessions();
  const next = nextClassInfo();
  const ongoing = currentSession();

  const hwAll = state.assignments.slice().sort((a, b) => hwSortKey(a) - hwSortKey(b));
  const people = activePerson === 'both' ? state.people : [personById(activePerson)];

  let undone = 0, overdue = 0, dueSoon = 0, noDue = 0;
  const now = new Date();
  hwAll.forEach((a) => {
    people.forEach((p) => {
      if (!hwApplies(a, p.id)) return;
      const st = hwStatus(a, p.id);
      if (st.done) return;
      undone++;
      if (!a.due) { noDue++; return; }
      const d = new Date(a.due);
      if (d < now) overdue++;
      else if (d - now < 3 * 86400000) dueSoon++;
    });
  });

  const scoreTotals = people.map((p) => ({
    p: p,
    total: state.scores.filter((s) => s.personId === p.id).reduce((sum, s) => sum + (Number(s.score) || 0), 0)
  }));

  let html = '<div class="view">';

  /* Bento 驾驶舱 */
  const urgentTodos = (state.todos || []).filter((t) => {
    if (!todoUndone(t)) return false;
    const u = todoUrgency(t);
    return u === 'overdue' || u === 'soon';
  }).sort((a, b) => hwSortKey(a) - hwSortKey(b));
  const overdueHw = hwAll.filter((a) => people.some((p) => isOverdue(a, p.id)));
  const examSoon = [];
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const days = Math.ceil((startOfDay(new Date(x.date)) - startOfDay(now)) / 86400000);
      if (days >= 0 && days <= 7) examSoon.push({ c: c, x: x, days: days, date: new Date(x.date) });
    });
  });
  examSoon.sort((a, b) => a.days - b.days);

  const nowDate = new Date();
  const dateLine = cnNum(nowDate.getMonth() + 1) + '月' + cnNum(nowDate.getDate()) + '日 · 星期' + '一二三四五六日'[dayIndexMon1(nowDate) - 1];
  const totalWeeks = state.meta.totalWeeks || 18;
  let pct = 0, weekLine;
  if (cw <= 0) {
    weekLine = '距开学 ' + Math.ceil((termStartDate() - startOfDay(nowDate)) / 86400000) + ' 天';
  } else {
    pct = Math.min(100, Math.max(0, Math.round(((cw - 0.5) / totalWeeks) * 100)));
    weekLine = '第 ' + cw + ' 周 · 共 ' + totalWeeks + ' 周';
  }

  let heroRight = '';
  if (ongoing) {
    const left = toMinutes(ongoing.slot.end) - nowMinutes();
    const span = toMinutes(ongoing.slot.end) - toMinutes(ongoing.slot.start);
    const prog = Math.round(((span - left) / span) * 100);
    heroRight = '<div class="dh-label dh-label-now">● 正在进行</div>'
      + '<div class="dh-name">' + esc(ongoing.course.name) + '</div>'
      + '<div class="dh-meta">' + esc(ongoing.slot.start) + ' - ' + esc(ongoing.slot.end) + ' · ' + esc(ongoing.s.room || '教室待定') + '</div>'
      + '<div class="mh-progress dh-prog"><div class="mh-bar" style="width:' + prog + '%"></div></div>'
      + '<div class="dh-count-wrap"><span class="dh-count">' + left + '</span><span class="dh-unit">分钟后下课</span></div>';
  } else if (next && cw > 0) {
    const left = toMinutes(next.slot.start) - nowMinutes();
    const when = left >= 60 ? Math.floor(left / 60) + 'h' + (left % 60 ? (left % 60) + "'" : '') : left + "'";
    heroRight = '<div class="dh-label">下一节课</div>'
      + '<div class="dh-name">' + esc(next.course.name) + '</div>'
      + '<div class="dh-meta">' + esc(next.slot.start) + ' 上课 · ' + esc(next.s.room || '教室待定') + '</div>'
      + '<div class="dh-count-wrap"><span class="dh-count">' + when + '</span><span class="dh-unit">后上课</span></div>';
  } else {
    const days = Math.ceil((termStartDate() - startOfDay(nowDate)) / 86400000);
    heroRight = '<div class="dh-label">' + (cw > 0 ? '今日课程已结束' : '尚未开学') + '</div>'
      + '<div class="dh-name">' + (cw > 0 ? '明天见 ☾' : '准备开学') + '</div>'
      + '<div class="dh-meta">' + (cw > 0 ? '或去作业页看看还有什么没做' : '距开学 ' + days + ' 天，先把作业和待办理一理') + '</div>';
  }

  html += '<div class="bento">';
  html += '<div class="b-tile b-hero">'
    + '<div class="dh-date">' + esc(dateLine) + '</div>'
    + '<div class="dh-sub">' + esc(state.meta.termName) + ' · ' + esc(weekLine) + '</div>'
    + '<div class="bh-divider"></div>'
    + heroRight
    + '<div class="mh-progress dh-prog" style="margin-top:14px"><div class="mh-bar" style="width:' + pct + '%"></div></div>'
    + '<div class="dh-prog-label">学期进度 ' + pct + '%</div>'
    + '</div>';

  html += '<div class="b-tile b-num"><div class="bh-label">今日概览</div><div class="bn-grid">'
    + bnum('今日课程', today.length + ' 节', cw > 0 ? '第 ' + week + ' 周' : '未开学')
    + bnum('待完成作业', String(undone), overdue + ' 逾期 · ' + noDue + ' 无截止')
    + people.map((p) => {
        const tot = hwAll.filter((a) => hwApplies(a, p.id)).length;
        const done = hwAll.filter((a) => hwApplies(a, p.id) && hwStatus(a, p.id).done).length;
        return bnum(p.name + ' 作业', (tot ? Math.round(done / tot * 100) : 0) + '%', done + ' / ' + tot);
      }).join('')
    + scoreTotals.map((st) => bnum(st.p.name + ' 加分', '+' + st.total.toFixed(1), state.scores.filter((s) => s.personId === st.p.id).length + ' 条记录')).join('')
    + '</div>'
    + '<div style="margin-top:12px"><div class="bh-label">双人进度</div><div class="ring-wrap">'
    + state.people.map((p) => {
        const tot = hwAll.filter((a) => hwApplies(a, p.id)).length;
        const done = hwAll.filter((a) => hwApplies(a, p.id) && hwStatus(a, p.id).done).length;
        const pc = tot ? Math.round(done / tot * 100) : 0;
        return ringSvg(pc, p.id === 'rain' ? 'var(--rain)' : 'var(--me)', p.name);
      }).join('')
    + '</div></div></div>';

  html += '<div class="b-tile b-urgent"><div class="bh-label">紧急提醒</div>';

  const urgentItems = [];
  examSoon.filter((e) => e.days <= 3).forEach((e) => urgentItems.push({
    cls: e.days === 0 ? 'danger' : 'warn',
    tag: e.days === 0 ? '今天考' : e.days === 1 ? '明天考' : e.days + ' 天后',
    text: e.x.title + ' · ' + (e.c.shortName || e.c.name),
    sub: fmtDateShort(e.date) + ' ' + fmtTime(e.date) + (e.x.location ? ' · ' + e.x.location : '')
  }));
  urgentTodos.slice(0, 3).forEach((t) => {
    const u = todoUrgency(t);
    const targets = state.people.filter((p) => !hwStatus(t, p.id).done && todoOwners(t).some((o) => o.id === p.id));
    urgentItems.push({
      cls: u === 'overdue' ? 'danger' : 'warn',
      tag: URGENT_LABEL[u] ? URGENT_LABEL[u][0] : '待办',
      text: t.title,
      sub: t.due ? fmtDateShort(new Date(t.due)) : ''
    });
  });
  overdueHw.slice(0, 3).forEach((a) => {
    urgentItems.push({
      cls: 'danger', tag: '作业逾期', text: a.title, sub: '作业页可处理',
      targets: state.people.filter((p) => !hwStatus(a, p.id).done),
      kind: 'hw', title: a.title
    });
  });
  if (urgentItems.length) {
    html += '<div class="mini-list">';
    urgentItems.slice(0, 5).forEach((it) => {
      html += '<div class="mini-item"><span class="badge ' + it.cls + '">' + esc(it.tag) + '</span>'
        + '<div class="mi-main"><div>' + esc(it.text) + '</div>'
        + (it.sub ? '<div class="mi-sub">' + esc(it.sub) + '</div>' : '') + '</div>'
        + '</div>';
    });
    html += '</div>';
  } else {
    html += '<div class="empty" style="padding:14px 0"><div class="em-title">一切安好</div><div>近期没有紧急事项</div></div>';
  }
  html += examTimelineHtml();
  html += '</div>';

  html += '</div>';

  html += '<div class="split">';

  /* 左：今日课程时间轴 */
  html += '<div class="section"><div class="card"><div class="pad" style="padding-bottom:6px">'
    + '<div class="section-head" style="margin-bottom:4px"><h2>今日课程</h2>'
    + '<span class="sub">' + fmtDateShort(new Date()) + ' · ' + DAY_NAMES[dayIndexMon1(new Date())] + '</span></div></div>';

  if (!today.length) {
    html += '<div class="empty"><div class="em-title">' + (cw > 0 ? '今天没有课' : '尚未开学') + '</div>'
      + '<div>' + (cw > 0 ? '好好休息，或者整理一下作业清单' : '9 月 7 日正式开课，先把作业和待办理一理吧') + '</div></div>';
  } else {
    const mins = nowMinutes();
    html += '<div class="day-tl">';
    today.forEach((t) => {
      const slot = t.slot;
      const started = mins >= toMinutes(slot.start);
      const ended = mins >= toMinutes(slot.end);
      html += '<div class="dtl-item' + (ended ? ' is-done' : started ? ' is-now' : '') + '">'
        + '<div class="dtl-time"><div class="dtl-start">' + esc(slot.start) + '</div><div class="dtl-end">' + esc(slot.end) + '</div></div>'
        + '<div class="dtl-line"><div class="dtl-dot"></div></div>'
        + '<div class="dtl-body">'
        + '<div class="dtl-name">' + esc(t.course.name)
        + (ended ? '<span class="badge">已结束</span>' : started ? '<span class="badge ok">进行中</span>' : '')
        + '</div>'
        + '<div class="dtl-meta">' + esc(t.s.room || '教室待定')
        + (t.course.teacher ? ' · ' + esc(t.course.teacher) : '')
        + ' · ' + esc(slot.label) + '</div>'
        + '</div></div>';
    });
    html += '</div>';
  }

  /* 明天课程（紧凑小节，同卡内） */
  const tomorrow = sessionsOn(new Date(Date.now() + 86400000));
  const tmr = new Date(Date.now() + 86400000);
  html += '<div class="pad" style="padding-top:2px">'
    + '<div class="sub-title">明天 · ' + DAY_NAMES[dayIndexMon1(tmr)] + ' <span class="muted tiny">' + tomorrow.length + ' 节</span></div>';
  if (!tomorrow.length) {
    html += '<div class="muted tiny" style="padding:2px 0 10px">' + (cw > 0 ? '明天没有课' : '开学后这里会显示第二天的课') + '</div>';
  } else {
    tomorrow.forEach((t) => {
      html += '<div class="mini-item" data-act="open-course" data-id="' + t.course.id + '" style="cursor:pointer">'
        + '<span class="badge">' + esc(t.slot.start) + '</span>'
        + '<div class="mi-main"><div>' + esc(t.course.name) + '</div>'
        + '<div class="mi-sub">' + esc(t.s.room || '教室待定') + (t.course.teacher ? ' · ' + esc(t.course.teacher) : '') + '</div></div></div>';
    });
  }
  html += '</div>';

  html += '</div></div>';

  /* 右：待办提醒（单卡收纳） */
  html += '<div class="section">';
  html += '<div class="card">';
  html += '<div class="group-title">待办提醒 <span class="count">考试 · 课程提醒 · 作业</span>'
    + '<button class="btn sm primary" data-act="add-hw" style="margin-left:auto">+ 新作业</button></div>';

  const rems = upcomingReminders();
  if (rems.length) {
    html += '<div class="pad" style="padding-top:0">';
    html += '<div class="sub-title">课程提醒</div><div class="mini-list">';
    rems.slice(0, 4).forEach((x) => {
      const rd = new Date(x.r.datetime);
      const diffH = Math.round((rd - now) / 3600000);
      let when;
      if (diffH < 0) when = '已过期';
      else if (diffH < 24) when = diffH + ' 小时后';
      else when = Math.floor(diffH / 24) + ' 天后';
      html += '<div class="mini-item"><span class="badge warn">' + esc(when) + '</span>'
        + '<div class="mi-main"><div>' + esc(x.r.title) + '</div>'
        + '<div class="mi-sub">' + esc(x.course.shortName || x.course.name) + ' · '
        + esc(fmtDateShort(rd) + ' ' + fmtTime(rd)) + (x.r.note ? ' · ' + esc(x.r.note) : '') + '</div></div></div>';
    });
    html += '</div></div>';
  }

  /* 考试与测验（近 3 周） */
  const upcomingExams = [];
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const d = new Date(x.date);
      const days = Math.ceil((startOfDay(d) - startOfDay(now)) / 86400000);
      if (days >= -1 && days <= 21) upcomingExams.push({ course: c, x: x, days: days, date: d });
    });
  });
  upcomingExams.sort((a, b) => a.days - b.days);
  if (upcomingExams.length) {
    html += '<div class="pad" style="padding-top:0">';
    html += '<div class="sub-title">考试与测验</div><div class="mini-list">';
    upcomingExams.slice(0, 5).forEach((e) => {
      let when;
      if (e.days < 0) when = '已结束';
      else if (e.days === 0) when = '今天';
      else if (e.days === 1) when = '明天';
      else when = e.days + ' 天后';
      html += '<div class="mini-item" data-act="open-course" data-id="' + e.course.id + '" style="cursor:pointer">'
        + '<span class="badge ' + (e.days <= 3 && e.days >= 0 ? 'danger' : 'warn') + '">' + esc(when) + '</span>'
        + '<div class="mi-main"><div>' + esc(e.x.title) + '</div>'
        + '<div class="mi-sub">' + esc(e.course.shortName || e.course.name) + ' · '
        + esc(fmtDateShort(e.date) + ' ' + fmtTime(e.date))
        + (e.x.location ? ' · ' + esc(e.x.location) : '') + '</div></div></div>';
    });
    html += '</div></div>';
  }

  const groups = [
    { key: 'overdue', title: '已逾期', test: (a, p) => isOverdue(a, p.id) },
    { key: 'today', title: '今天截止', test: (a, p) => { const st = hwStatus(a, p.id); return !st.done && a.due && Math.floor((startOfDay(new Date(a.due)) - startOfDay(new Date())) / 86400000) === 0; } },
    { key: 'week', title: '7 天内', test: (a, p) => { const st = hwStatus(a, p.id); if (st.done || !a.due) return false; const d = (new Date(a.due) - new Date()) / 86400000; return d > 0 && d <= 7; } },
    { key: 'later', title: '更晚', test: (a, p) => { const st = hwStatus(a, p.id); if (st.done || !a.due) return false; return (new Date(a.due) - new Date()) / 86400000 > 7; } },
    { key: 'nodue', title: '未设截止', test: (a, p) => !hwStatus(a, p.id).done && !a.due }
  ];

  let any = false;
  groups.forEach((g) => {
    const rows = [];
    hwAll.forEach((a) => { if (people.some((p) => g.test(a, p))) rows.push(a); });
    if (!rows.length) return;
    any = true;
    html += '<div class="group-title">' + g.title + ' <span class="count">' + rows.length + '</span></div><div class="list">';
    rows.forEach((a) => {
      const c = courseById(a.courseId);
      const di = dueInfo(a);
      html += '<div class="row" data-act="edit-hw" data-id="' + a.id + '" style="cursor:pointer">'
        + '<div class="row-main"><div class="row-title">' + esc(a.title) + '</div>'
        + '<div class="row-meta"><span class="badge">' + esc(c ? (c.shortName || c.name) : '未指定') + '</span>'
        + (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span>' + esc(di.text) + '</span>')
        + '</div></div>'
        + '<div class="two-state">' + people.map((p) => doneChip(a, p)).join('') + '</div></div>';
    });
    html += '</div>';
  });
  if (!any && !rems.length) {
    html += '<div class="empty"><div class="em-title">暂无待办</div><div>所有作业都已完成，很棒</div></div>';
  }

  /* 其他待办（不挂课程） */
  const todos = (state.todos || []).filter((t) => todoUndone(t) && todoOwners(t).some((p) => activePerson === 'both' || p.id === activePerson))
    .sort((a, b) => hwSortKey(a) - hwSortKey(b));
  if (todos.length) {
    html += '<div class="group-title">其他待办 <span class="count">' + todos.length + '</span></div><div class="list">';
    todos.forEach((t) => {
      const di = t.due ? dueInfo(t) : null;
      const showOwners = activePerson === 'both' ? todoOwners(t) : [personById(activePerson)];
      html += '<div class="row" data-act="edit-todo" data-id="' + t.id + '" style="cursor:pointer">'
        + '<div class="row-main"><div class="row-title">' + esc(t.title) + '</div>'
        + '<div class="row-meta">'
        + (di ? (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span class="muted tiny">' + esc(di.text) + '</span>') : '<span class="muted tiny">无截止</span>')
        + '</div></div>'
        + '<div class="two-state">' + showOwners.map((p) => doneChip(t, p)).join('') + '</div></div>';
    });
    html += '</div>';
  }

  /* 关闭：待办卡片 → 右栏 → 左右分栏 → 视图 */
  html += '</div></div></div></div>';

  /* 常用链接：页面最底部 */
  const linkGroups = [
    { title: '教务处', items: [
      { name: '教务处官网', url: 'https://jwc.sicnu.edu.cn', desc: '通知公告 · 校历 · 规章制度' },
      { name: '学生课表登录', url: 'http://jwcxk.sicnu.edu.cn/student/sso/login', desc: '个人课表 · 选课 · 成绩' },
      { name: '本班课表', url: 'https://jwcxk.sicnu.edu.cn/student/for-std/adminclass-course-table/info/288994?semesterId=153', desc: '数科 2025 级 03 班 · 需登录' },
      { name: '教务管理系统', url: 'http://202.115.194.60', desc: '学籍 · 成绩证明' }
    ]},
    { title: '线上课程平台', items: [
      { name: '学习通', url: 'https://i.chaoxing.com/', desc: '超星 · 作业 · 课程 · 考试' },
      { name: '长江雨课堂', url: 'https://changjiang.yuketang.cn/web', desc: '雨课堂 · 长江版' },
      { name: '智慧树', url: 'http://www.zhihuishu.com/', desc: '共享学分课' },
      { name: '学堂在线', url: 'http://sicnu.xuetangx.com/', desc: 'SICNU 专属入口' },
      { name: '超星尔雅', url: 'https://mooc.chaoxing.com/', desc: '尔雅通识课（占位课程）' }
    ]},
    { title: '学校', items: [
      { name: '四川师范大学', url: 'https://www.sicnu.edu.cn', desc: '学校主页' }
    ]}
  ];
  html += '<details class="links-fold">'
    + '<summary><span class="lf-title">常用链接</span>'
    + '<span class="lf-hint">教务处 · 学习通 · 长江雨课堂 · 智慧树 · 学堂在线 · 尔雅</span>'
    + '<span class="lf-arrow">▾</span></summary>'
    + '<div class="lf-body">';
  linkGroups.forEach((g) => {
    html += '<div class="sub-title" style="margin:12px 0 4px">' + esc(g.title) + '</div><div class="link-list">';
    g.items.forEach((l) => {
      html += '<a class="link-row" href="' + esc(l.url) + '" target="_blank" rel="noopener">'
        + '<span class="lr-name">' + esc(l.name) + '</span>'
        + '<span class="lr-desc">' + esc(l.desc) + '</span>'
        + '<span class="lr-arrow">↗</span></a>';
    });
    html += '</div>';
  });
  html += '</div></details>';

  /* PWA 引导（仅手机窄屏显示一次） */
  let pwaHintOff = false;
  try { pwaHintOff = localStorage.getItem('coursehub-pwa-hint') === 'off'; } catch (e) { /* 忽略 */ }
  if (!pwaHintOff) {
    html += '<div class="pwa-hint" id="pwaHint">📲 <span><b>添加到主屏幕</b> 像 App 一样全屏使用</span>'
      + '<button class="icon-btn" data-act="dismiss-pwa-hint" title="不再显示" style="margin-left:auto;width:26px;height:26px;flex:none">✕</button></div>';
  }

  return html;
}

function fmtDateBox(due) {
  if (!due) return '<div class="date-box db-none"><div class="db-day">—</div><div class="db-sub">无截止</div></div>';
  const d = new Date(due);
  const days = Math.floor((startOfDay(d) - startOfDay(new Date())) / 86400000);
  const cls = days < 0 ? 'db-danger' : days <= 3 ? 'db-warn' : days <= 7 ? 'db-soon' : '';
  const sub = days < 0 ? '逾期' : days === 0 ? '今天' : days <= 7 ? days + ' 天' : (d.getMonth() + 1) + '月';
  return '<div class="date-box ' + cls + '"><div class="db-day">' + d.getDate() + '</div><div class="db-sub">' + sub + '</div></div>';
}

function dateBox(a) { return fmtDateBox(a.due); }

/* Bento 数字格 */
function bnum(label, num, sub) {
  return '<div class="bn-cell"><div class="bn-num">' + esc(num) + '</div><div class="bn-label">' + esc(label) + '</div>'
    + (sub ? '<div class="bn-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

/* 双人完成度环形进度（概览） */
function ringSvg(pct, colorVar, name) {
  const r = 24, c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, pct));
  const dash = (v / 100 * c).toFixed(1);
  return '<div class="ring"><svg width="56" height="56" viewBox="0 0 56 56">'
    + '<circle cx="28" cy="28" r="24" fill="none" stroke="var(--surface-3)" stroke-width="6"/>'
    + '<circle cx="28" cy="28" r="24" fill="none" stroke="' + colorVar + '" stroke-width="6" stroke-linecap="round" '
    + 'stroke-dasharray="' + dash + ' ' + c.toFixed(1) + '" transform="rotate(-90 28 28)"/>'
    + '<text x="28" y="31.5" text-anchor="middle" font-family="Georgia,serif" font-size="13" fill="' + colorVar + '" font-weight="600">' + v + '%</text>'
    + '</svg><div class="ring-name">' + esc(name) + '</div></div>';
}

/* 学期考试时间线（横向一页纸） */
function examTimelineHtml() {
  const now = new Date();
  const totalWeeks = state.meta.totalWeeks || 18;
  const cw = currentWeek();
  const all = [];
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const wk = Math.max(1, Math.ceil((startOfDay(new Date(x.date)).getTime() + 1 - termStartDate().getTime()) / (7 * 86400000)));
      if (wk >= 1 && wk <= totalWeeks) all.push({ wk: wk, c: c, x: x, past: startOfDay(new Date(x.date)) < startOfDay(now) });
    });
  });
  if (!all.length) return '';
  all.sort((a, b) => a.wk - b.wk);
  const pos = (wk) => Math.min(98, Math.max(2, ((wk - 0.5) / totalWeeks) * 100));
  let markers = '';
  all.forEach((e) => {
    markers += '<span class="etl-mark' + (e.past ? ' is-past' : '') + '" style="left:' + pos(e.wk).toFixed(1) + '%" title="'
      + esc(e.x.title + ' · ' + (e.c.shortName || e.c.name) + ' · 第' + e.wk + '周') + '"></span>';
  });
  const nowPos = cw > 0 ? pos(Math.min(totalWeeks, cw)) : 0;
  const next = all.filter((e) => !e.past)[0];
  return '<div class="bh-label" style="margin-top:14px">学期考试时间线</div>'
    + '<div class="etl"><div class="etl-track">' + markers
    + (cw > 0 ? '<span class="etl-now" style="left:' + nowPos.toFixed(1) + '%"></span>' : '')
    + '</div>'
    + '<div class="etl-scale"><span>第 1 周</span><span>第 ' + totalWeeks + ' 周</span></div>'
    + (next ? '<div class="etl-next">下一场：' + esc(next.x.title + ' · ' + (next.c.shortName || next.c.name)) + ' · 第 ' + next.wk + ' 周</div>' : '')
    + '</div>';
}

function statCard(label, value, foot, cls) {
  return '<div class="stat ' + (cls || '') + '"><div class="stat-label">' + esc(label) + '</div>'
    + '<div class="stat-value">' + esc(value) + '</div>'
    + '<div class="stat-foot">' + esc(foot) + '</div></div>';
}

function doneChip(a, p) {
  const st = hwStatus(a, p.id);
  const label = st.done ? '已完成' : '待完成';
  const time = st.done && st.doneAt ? fmtDateShort(new Date(st.doneAt)) + ' ' + fmtTime(new Date(st.doneAt)) : '';
  return '<button class="tstate ' + p.id + (st.done ? ' is-done' : '') + '" data-act="toggle-done" data-id="' + a.id + '" data-person="' + p.id + '" title="' + esc(p.name + '：' + label + (time ? '（' + time + '）' : '')) + '">'
    + '<span class="dot"></span><span>' + esc(p.short || p.name) + '</span>'
    + (time ? '<span class="ts-time">' + esc(time.slice(0, 5)) + '</span>' : '')
    + '</button>';
}

/* ---------------- 视图：课表 ---------------- */

function renderTimetable() {
  const cw = currentWeek();
  const start = weekDayDate(selWeek, 1);
  const end = weekDayDate(selWeek, 7);
  const todayIdx = dayIndexMon1(new Date());
  const isCurrentWeek = selWeek === cw;

  let html = '<div class="view">';

  html += '<div class="tt-nav">'
    + '<button class="btn sm" data-act="week-prev">‹ 上一周</button>'
    + '<button class="btn sm" data-act="week-next">下一周 ›</button>'
    + '<button class="btn sm" data-act="week-now">回到本周</button>'
    + '<span class="title">第 ' + selWeek + ' 周</span>'
    + '<span class="date-range">' + fmtDateShort(start) + ' - ' + fmtDateShort(end) + '</span>'
    + (cw === 0 ? '<span class="badge warn">尚未开学</span>' : isCurrentWeek ? '<span class="badge ok">本周</span>' : '')
    + '<span class="muted tiny">灰显课程表示该周不上</span>'
    + '<span class="spacer"></span>'
    + '<button class="btn sm" data-act="export-ics" title="导出整学期课表为 .ics，可导入手机/电脑日历">导出日历</button>'
    + '</div>';

  html += '<div class="tt-wrap"><table class="tt"><thead><tr><th class="slotcol">节次</th>';
  for (let d = 1; d <= 7; d++) {
    const date = weekDayDate(selWeek, d);
    const isToday = isCurrentWeek && d === todayIdx;
    html += '<th class="' + (isToday ? 'is-today' : '') + '">' + DAY_NAMES[d]
      + '<span class="dnum">' + (date.getMonth() + 1) + '/' + date.getDate() + '</span></th>';
  }
  html += '</tr></thead><tbody>';

  (state.slots || []).forEach((slot) => {
    const mins = nowMinutes();
    const inSlot = isCurrentWeek && mins >= toMinutes(slot.start) && mins < toMinutes(slot.end);
    html += '<tr><th>' + esc(slot.label) + '<span class="st">' + esc(slot.time.replace(/ - /g, '-')) + '</span></th>';
    for (let d = 1; d <= 7; d++) {
      const todayCol = isCurrentWeek && d === todayIdx;
      html += '<td' + (todayCol ? ' class="td-today"' : '') + '><div class="ttcell">';
      state.courses.forEach((c) => {
        c.sessions.forEach((s) => {
          if (s.day !== d || s.slot !== slot.id) return;
          const on = parseWeeks(s.weeks)[selWeek];
          const col = c.color || {};
          html += '<button class="ttblock' + (on ? '' : ' is-dim') + (inSlot && on ? ' is-now' : '') + '"'
            + ' data-act="open-course" data-id="' + c.id + '"'
            + ' style="background:' + (col.bg || '#eee') + ';border-color:' + (col.bd || '#ddd') + ';color:' + (col.tx || '#333') + '"'
            + ' title="' + esc(c.name + '｜' + (s.room || '教室待定') + '｜' + (s.weeks || '每周') + '周') + '">'
            + '<span class="tb-name">' + esc(c.shortName || c.name) + '</span>'
            + '<span class="tb-meta">' + esc(s.room || '') + (s.weeks ? ' · ' + esc(s.weeks) + '周' : '') + '</span>'
            + '</button>';
        });
      });
      html += '</div></td>';
    }
    html += '</tr>';
  });

  html += '</tbody></table></div>';

  /* 本周无课表的线上课程提示 */
  const online = state.courses.filter((c) => c.type === '线上');
  if (online.length) {
    html += '<div class="card pad mt14"><div class="section-head" style="margin-bottom:8px"><h2>线上课程</h2>'
      + '<span class="sub">无固定排课，请自行设置提醒</span></div><div class="mini-list">';
    online.forEach((c) => {
      const n = (c.reminders || []).filter((r) => !r.done).length;
      html += '<div class="mini-item" data-act="open-course" data-id="' + c.id + '" style="cursor:pointer">'
        + '<span class="badge online">线上</span>'
        + '<div class="mi-main"><div>' + esc(c.name) + '</div>'
        + '<div class="mi-sub">' + esc(c.teacher || '教师待定') + ' · ' + (n ? n + ' 个待办提醒' : '暂无提醒') + '</div></div>'
        + '<button class="btn sm" data-act="add-remind" data-id="' + c.id + '">+ 提醒</button></div>';
    });
    html += '</div></div>';
  }

  html += '</div>';
  return html;
}

/* ---------------- 其他待办（不挂课程的自定义清单） ---------------- */

function todoOwners(t) {
  return t.owner === 'both' || !t.owner ? state.people.slice() : [personById(t.owner)];
}

function todoUndone(t) {
  return todoOwners(t).some((p) => !hwStatus(t, p.id).done);
}

function todoUrgent(t) {
  const now = new Date();
  return todoOwners(t).some((p) => {
    if (hwStatus(t, p.id).done || !t.due) return false;
    const d = new Date(t.due);
    return d < now || Math.floor((startOfDay(d) - startOfDay(now)) / 86400000) === 0;
  });
}

/* 紧急度：overdue > soon(≤3天) > week(≤7天) > normal > none */
function todoUrgency(t) {
  if (!t.due) return 'none';
  const now = new Date();
  const days = Math.floor((startOfDay(new Date(t.due)) - startOfDay(now)) / 86400000);
  if (days <= 0) return 'overdue';
  if (days <= 3) return 'soon';
  if (days <= 7) return 'week';
  return 'normal';
}

const URGENT_LABEL = { overdue: ['已逾期', 'danger'], soon: ['3 天内', 'warn'], week: ['本周内', ''] };

function renderTodoList() {
  /* Things 3 心智模型：今天/已逾期 → 即将到来 → 收集箱（无截止）→ 已完成折叠 */
  const todos = state.todos || [];
  const now = new Date();
  const buckets = { today: [], upcoming: [], inbox: [], done: [] };
  todos.forEach((t) => {
    const allDone = todoOwners(t).every((p) => hwStatus(t, p.id).done);
    if (allDone) { buckets.done.push(t); return; }
    if (!t.due) { buckets.inbox.push(t); return; }
    const days = Math.floor((startOfDay(new Date(t.due)) - startOfDay(now)) / 86400000);
    if (days <= 0) buckets.today.push(t);
    else buckets.upcoming.push(t);
  });
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
  buckets.today.sort(byDue);
  buckets.upcoming.sort(byDue);

  const item = (t) => {
    const allDone = todoOwners(t).every((p) => hwStatus(t, p.id).done);
    const di = t.due ? dueInfo(t) : null;
    return '<div class="tk-item' + (allDone ? ' is-done' : '') + '">'
      + '<div class="tki-main">'
      + '<div class="tki-title">' + esc(t.title)
      + (t.owner && t.owner !== 'both' ? ' <span class="badge">仅 ' + esc(personById(t.owner).name) + '</span>' : '')
      + '</div>'
      + '<div class="tki-meta">'
      + (di ? (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span>' + esc(di.text) + '</span>') : '<span class="muted tiny">无截止</span>')
      + (t.note ? '<span class="muted tiny">' + esc(t.note) + '</span>' : '')
      + '</div></div>'
      + '<div class="two-state">' + todoOwners(t).map((p) => doneChip(t, p)).join('') + '</div>'
      + '<div class="row-actions">'
      + '<button class="icon-btn" data-act="edit-todo" data-id="' + t.id + '" title="编辑">✎</button>'
      + '<button class="icon-btn" data-act="del-todo" data-id="' + t.id + '" title="删除">🗑</button>'
      + '</div></div>';
  };

  let html = '<div class="todo-things">';
  if (buckets.today.length) {
    html += '<div class="tk-section-head" style="color:var(--danger)">● 今天 / 已逾期</div>';
    buckets.today.forEach((t) => { html += item(t); });
  }
  if (buckets.upcoming.length) {
    html += '<div class="tk-section-head" style="color:var(--accent);margin-top:10px">◇ 即将到来</div>';
    buckets.upcoming.forEach((t) => { html += item(t); });
  }
  if (buckets.inbox.length) {
    html += '<div class="tk-section-head" style="color:var(--text-3);margin-top:10px">☁ 收集箱（无截止）</div>';
    buckets.inbox.forEach((t) => { html += item(t); });
  }
  if (!todos.length) {
    html += '<div class="empty" style="padding:22px 16px"><div class="em-title">暂无待办</div>'
      + '<div>不属于课程的事项可以记录在此，例如：提交材料、领取物品、办理手续</div></div>';
  }
  if (buckets.done.length) {
    html += '<div class="tk-done-summary">✓ 已完成 ' + buckets.done.length + ' 项</div>';
    buckets.done.slice(0, 5).forEach((t) => { html += item(t); });
  }
  html += '</div>'; // 闭合 todo-things
  html += '<div class="tk-quick"><button class="btn sm primary" data-act="add-todo">+ 新增待办</button>'
    + '<span class="muted tiny">会弹出完整表单：内容、归属、截止时间、备注都能填</span></div>';
  return html;
}

function openTodoForm(id) {
  const t = id ? (state.todos || []).filter((x) => x.id === id)[0] : null;
  const isNew = !t;
  const body = '<div class="form-grid">'
    + '<div class="field span2"><label>待办内容</label><input class="input" id="tdTitle" placeholder="例如：交团费、取快递、办身份证" value="' + esc(t ? t.title : '') + '"></div>'
    + '<div class="field"><label>归属</label><select class="select" id="tdOwner">'
    + [['both', '两人'], ['me', state.people[0].name], ['rain', (state.people[1] || state.people[0]).name]]
      .map((o) => '<option value="' + o[0] + '"' + ((t ? t.owner : 'both') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>截止（可选）</label><input type="datetime-local" class="input" id="tdDue" value="' + esc(t ? t.due : '') + '"></div>'
    + '<div class="field span2"><label>备注（选填）</label><input class="input" id="tdNote" value="' + esc(t ? t.note : '') + '"></div>'
    + '</div>';
  openModal(isNew ? '新增待办' : '编辑待办', body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);
  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    const title = $('#tdTitle').value.trim();
    if (!title) { toast('请填写待办内容', true); return; }
    const item = t || { id: uid('t'), status: {}, createdAt: new Date().toISOString() };
    item.title = title;
    item.owner = $('#tdOwner').value;
    item.due = $('#tdDue').value;
    item.note = $('#tdNote').value.trim();
    todoOwners(item).forEach((p) => hwStatus(item, p.id));
    if (!state.todos) state.todos = [];
    if (isNew) state.todos.push(item);
    save();
    toast(isNew ? '待办已添加' : '待办已更新');
    closeModalThen(render);
  };
}

/* ---------------- 视图：考试（考试 + 期末作业） ---------------- */

function allExams() {
  const out = [];
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      out.push({ course: c, x: x, date: new Date(x.date) });
    });
  });
  out.sort((a, b) => a.date - b.date);
  return out;
}

function renderExams() {
  const now = new Date();
  const exams = allExams();
  const upcoming = exams.filter((e) => e.date >= startOfDay(now));
  const past = exams.filter((e) => e.date < startOfDay(now)).reverse();
  const finals = state.assignments.filter((a) => a.kind === 'final')
    .sort((a, b) => hwSortKey(a) - hwSortKey(b));

  let html = '<div class="view">';

  /* 杂志封面倒计时 */
  if (upcoming.length) {
    const e = upcoming[0];
    const days = Math.ceil((startOfDay(e.date) - startOfDay(now)) / 86400000);
    const mood = days <= 3 ? ' · <b style="color:#e8938a">就要来了</b>' : days <= 7 ? ' · <b style="color:#e0c489">该复习了</b>' : '';
    html += '<div class="exam-cover">'
      + '<div class="ec-left">'
      + '<div class="ec-label">距离最近一场考试</div>'
      + '<div class="ec-name">' + esc(e.x.title) + ' · ' + esc(e.course.shortName || e.course.name) + '</div>'
      + '<div class="ec-meta">' + esc(fmtDateShort(e.date) + ' ' + fmtTime(e.date))
      + (e.x.location ? ' · ' + esc(e.x.location) : '') + mood + '</div>'
      + '<button class="btn" data-act="add-exam" style="margin-top:14px;background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25);color:#f0ead8">+ 登记考试</button>'
      + '</div>'
      + '<div class="ec-count"><div class="ec-num">' + days + '</div><div class="ec-unit">' + (days === 0 ? '今天考' : '天后开考') + '</div></div>'
      + '</div>';
  } else {
    html += '<div class="exam-cover">'
      + '<div class="ec-left">'
      + '<div class="ec-label">还没有登记考试</div>'
      + '<div class="ec-name">暂无考试安排</div>'
      + '<div class="ec-meta">期中、期末、阶段测试都可以在这里登记，会自动倒计时提醒</div>'
      + '<button class="btn" data-act="add-exam" style="margin-top:14px;background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25);color:#f0ead8">+ 登记考试</button></div>'
      + '<div class="ec-count"><div class="ec-num">∑</div></div></div>';
  }

  html += '<div class="split">';

  /* 左：考试安排磁贴 */
  html += '<div class="section"><div class="card mt0">'
    + '<div class="group-title">考试安排 <span class="count">' + upcoming.length + ' 场待考</span></div>';
  if (!upcoming.length) {
    html += '<div class="empty" style="padding:24px 16px"><div class="em-title">暂无考试</div><div>点右上角「登记考试」添加</div></div>';
  } else {
    html += '<div class="exam-grid">';
    upcoming.forEach((e, i) => {
      const days = Math.ceil((startOfDay(e.date) - startOfDay(now)) / 86400000);
      const cls = i === 0 ? 'is-hero' : days <= 3 ? 'u-danger' : days <= 7 ? 'u-warn' : '';
      const unit = days === 0 ? '今天' : '天后';
      const big = days === 0 ? '今' : days;
      html += '<div class="exam-tile ' + cls + '">'
        + '<div class="et-count"><span class="et-num">' + big + '</span><span class="et-unit">' + unit + '</span></div>'
        + '<div class="et-main">'
        + '<div class="et-title">' + esc(e.x.title) + ownerBadge(e.x) + '</div>'
        + '<div class="et-course">' + esc(e.course.shortName || e.course.name) + '</div>'
        + '<div class="et-meta">' + esc(fmtDateShort(e.date) + ' ' + fmtTime(e.date))
        + (e.x.location ? ' · ' + esc(e.x.location) : '') + '</div>'
        + '</div>'
        + '<div class="row-actions">'
        + '<button class="icon-btn" data-act="edit-exam" data-id="' + e.course.id + '" data-xid="' + e.x.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-exam" data-id="' + e.course.id + '" data-xid="' + e.x.id + '" title="删除">🗑</button>'
        + '</div></div>';
    });
    html += '</div>';
  }
  html += '</div></div>';

  /* 右：期末作业伴随栏 */
  html += '<div class="section"><div class="card mt0">'
    + '<div class="group-title">期末作业 <span class="count">' + finals.length + ' 项 · 平时作业在「作业」页</span></div>';
  if (!finals.length) {
    html += '<div class="empty" style="padding:24px 16px"><div class="em-title">还没有期末作业</div>'
      + '<div>在「作业」页添加作业时，把「作业类型」选成「期末作业」，它就会出现在这里</div></div>';
  } else {
    html += '<div class="list">';
    finals.forEach((a) => {
      const c = courseById(a.courseId);
      const di = dueInfo(a);
      const chipPeople = state.people.filter((p) => hwApplies(a, p.id));
      html += '<div class="row">'
        + '<div class="row-main">'
        + '<div class="row-title">' + esc(a.title) + ownerBadge(a) + '</div>'
        + '<div class="row-meta">'
        + '<span class="badge">' + esc(c ? (c.shortName || c.name) : '未指定课程') + '</span>'
        + '<span class="badge pe">期末</span>'
        + (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span class="muted tiny">' + esc(di.text) + '</span>')
        + (a.note ? '<span class="muted tiny">' + esc(a.note) + '</span>' : '')
        + '</div></div>'
        + '<div class="two-state">' + chipPeople.map((p) => doneChip(a, p)).join('') + '</div>'
        + '<div class="row-actions">'
        + '<button class="icon-btn" data-act="edit-hw" data-id="' + a.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-hw" data-id="' + a.id + '" title="删除">🗑</button>'
        + '</div></div>';
    });
    html += '</div>';
  }
  html += '</div></div>';

  /* 已结束的考试 */
  if (past.length) {
    html += '<div class="card mt14"><div class="group-title">已结束 <span class="count">' + past.length + '</span></div><div class="list">';
    past.slice(0, 10).forEach((e) => {
      html += '<div class="row is-done">'
        + '<div class="row-main"><div class="row-title">' + esc(e.x.title) + ' · ' + esc(e.course.shortName || e.course.name) + '</div>'
        + '<div class="row-meta"><span>' + esc(fmtDateShort(e.date)) + '</span>'
        + (e.x.location ? '<span>' + esc(e.x.location) + '</span>' : '') + '</div></div>'
        + '<div class="row-actions">'
        + '<button class="icon-btn" data-act="del-exam" data-id="' + e.course.id + '" data-xid="' + e.x.id + '">🗑</button>'
        + '</div></div>';
    });
    html += '</div></div>';
  }

  html += '</div></div>';
  return html;
}


function renderHomework() {
  const f = FILTERS.hw;
  const people = activePerson === 'both' ? state.people : [personById(activePerson)];
  let list = state.assignments.slice().sort((a, b) => hwSortKey(a) - hwSortKey(b));

  if (f.courseId !== 'all') list = list.filter((a) => a.courseId === f.courseId);
  if (f.person !== 'both') list = list.filter((a) => matchesPersonStatus(a, f.person));

  const showPeople = f.person === 'both' ? people : [personById(f.person)];

  list = list.filter((a) => {
    const sts = showPeople.map((p) => hwStatus(a, p.id));
    if (f.status === 'done') return sts.every((s) => s.done);
    if (f.status === 'pending') return sts.some((s) => !s.done);
    if (f.status === 'overdue') return sts.some((s) => !s.done) && showPeople.some((p) => isOverdue(a, p.id));
    return true;
  });

  let html = '<div class="view">';

  html += '<div class="filterbar">'
    + '<div class="field" style="min-width:180px"><label>课程</label><select class="select" data-filter="hw-course">'
    + '<option value="all">全部课程</option>'
    + state.courses.map((c) => '<option value="' + c.id + '"' + (f.courseId === c.id ? ' selected' : '') + '>' + esc(c.shortName || c.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field" style="min-width:130px"><label>按人</label><select class="select" data-filter="hw-person">'
    + '<option value="both"' + (f.person === 'both' ? ' selected' : '') + '>两人</option>'
    + state.people.map((p) => '<option value="' + p.id + '"' + (f.person === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field" style="min-width:130px"><label>完成状态</label><select class="select" data-filter="hw-status">'
    + [['all', '全部'], ['pending', '有未完成的'], ['done', '全部已完成'], ['overdue', '已逾期']]
      .map((o) => '<option value="' + o[0] + '"' + (f.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select></div>'
    + '<div class="grow"></div>'
    + '<button class="btn primary" data-act="add-hw">+ 新作业</button>'
    + '</div>';

  if (!list.length) {
    html += '<div class="empty"><div class="em-title">没有符合条件的作业</div><div>点击右上角「新作业」添加一条</div></div>';
  } else {
    /* 期刊账本：第 1 章期末作业 / 第 2 章平时作业（按课程分组 + 完成度细条） */
    const finals = list.filter((a) => a.kind === 'final');
    const normals = list.filter((a) => a.kind !== 'final');

    const hwRow = (a) => {
      const c = courseById(a.courseId);
      const di = dueInfo(a);
      const chipPeople = state.people.filter((p) => hwApplies(a, p.id));
      return '<div class="row hw-row">'
        + '<div class="row-main">'
        + '<div class="row-title">' + esc(a.title) + ownerBadge(a) + '</div>'
        + '<div class="row-meta">'
        + '<span class="badge">' + esc(c ? (c.shortName || c.name) : '未指定课程') + '</span>'
        + (a.startTime ? '<span class="badge">进行 ' + esc(fmtDateShort(new Date(a.startTime))) + '</span>' : '')
        + (a.note ? '<span class="muted tiny">' + esc(a.note) + '</span>' : '')
        + showPeople.map((p) => {
          const st = hwStatus(a, p.id);
          if (!st.done || !st.note) return '';
          return '<div class="row-note"><span class="avatar ' + p.id + '" style="width:18px;height:18px;font-size:10px">' + esc(p.short || p.name) + '</span> ' + esc(st.note) + '</div>';
        }).join('')
        + '</div></div>'
        + dateBox(a)
        + '<div class="two-state">' + chipPeople.map((p) => doneChip(a, p)).join('') + '</div>'
        + '<div class="row-actions">'
        + '<button class="icon-btn" data-act="edit-hw" data-id="' + a.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-hw" data-id="' + a.id + '" title="删除">🗑</button>'
        + '</div></div>';
    };

    html += '<div class="journal">';
    html += '<div class="ch-head">第 1 章 · 期末作业 <span class="ch-count">' + finals.length + ' 项 · 考试页同步展示</span></div>';
    if (finals.length) {
      html += '<div class="ch-body">' + finals.map(hwRow).join('') + '</div>';
    } else {
      html += '<div class="ch-empty">还没有期末作业；添加作业时把「作业类型」选成「期末作业」即可归入本章</div>';
    }

    html += '<div class="ch-head ch-head-2">第 2 章 · 平时作业 <span class="ch-count">' + normals.length + ' 项</span></div>';
    if (normals.length) {
      const byCourse = {};
      normals.forEach((a) => { (byCourse[a.courseId] = byCourse[a.courseId] || []).push(a); });
      Object.keys(byCourse).forEach((cid) => {
        const rows = byCourse[cid];
        const c = courseById(cid);
        const tot = rows.reduce((n, a) => n + state.people.filter((p) => hwApplies(a, p.id)).length, 0);
        const done = rows.reduce((n, a) => n + state.people.filter((p) => hwApplies(a, p.id) && hwStatus(a, p.id).done).length, 0);
        const pc = tot ? Math.round(done / tot * 100) : 0;
        html += '<div class="course-group">'
          + '<div class="cg-head"><span class="cg-name">' + esc(c ? (c.shortName || c.name) : '未指定课程') + '</span>'
          + '<span class="cg-bar"><span class="cg-fill" style="width:' + pc + '%"></span></span>'
          + '<span class="cg-pct">' + done + ' / ' + tot + '</span></div>'
          + rows.map(hwRow).join('')
          + '</div>';
      });
    } else {
      html += '<div class="ch-empty">暂无平时作业</div>';
    }
    html += '</div>';
  }

  html += '<div class="card mt14">' + renderTodoList() + '</div>';

  html += '<p class="muted tiny mt8">作业条目两人共用，各自独立勾选完成状态；日常杂事记在下面「其他待办」。任何修改都会自动保存。</p>';
  html += '</div>';
  return html;
}


function matchesPersonStatus(a, pid) {
  const st = hwStatus(a, pid);
  const f = FILTERS.hw.status;
  if (f === 'done') return st.done;
  if (f === 'pending') return !st.done;
  if (f === 'overdue') return !st.done && isOverdue(a, pid);
  return true;
}

/* ---------------- 视图：量化加分 ---------------- */

function renderCourses() {
  const kw = FILTERS.course.keyword.trim().toLowerCase();
  let list = state.courses.slice();
  if (FILTERS.course.type !== 'all') list = list.filter((c) => c.type === FILTERS.course.type);
  if (kw) list = list.filter((c) => (c.name + ' ' + c.teacher + ' ' + (c.shortName || '')).toLowerCase().indexOf(kw) >= 0);

  const week = Math.max(1, currentWeek());

  let html = '<div class="view">';

  html += '<div class="filterbar">'
    + '<div class="field"><label>课程类型</label><select class="select" data-filter="course-type">'
    + ['all', '线下', '实验', '体育', '线上'].map((t) => '<option value="' + t + '"' + (FILTERS.course.type === t ? ' selected' : '') + '>' + (t === 'all' ? '全部类型' : t) + '</option>').join('')
    + '</select></div>'
    + '<div class="field grow"><label>搜索课程或教师</label>'
    + '<input class="input" data-filter="course-kw" placeholder="例如：数学分析、李凤莲" value="' + esc(FILTERS.course.keyword) + '"></div>'
    + '</div>';

  html += '<div class="course-grid">';
  list.forEach((c) => {
    const onSessions = c.sessions.filter((s) => parseWeeks(s.weeks)[week]);
    const hw = state.assignments.filter((a) => a.courseId === c.id);
    const people = activePerson === 'both' ? state.people : [personById(activePerson)];
    const undone = hw.reduce((n, a) => n + people.filter((p) => !hwStatus(a, p.id).done).length, 0);
    const col = c.color || {};
    html += '<div class="course-card" data-act="open-course" data-id="' + c.id + '" style="--cc:' + (col.tx || '#888') + '">'
      + '<div class="cc-head"><div style="flex:1;min-width:0"><h3 class="cc-name">' + esc(c.name) + '</h3>'
      + '<div class="cc-teacher">' + esc(c.teacher || '教师待定') + '</div></div>'
      + typeBadge(c.type) + '</div>';

    if (c.sessions.length) {
      html += '<div class="cc-sessions">';
      c.sessions.forEach((s) => {
        const slot = slotById(s.slot);
        const on = parseWeeks(s.weeks)[week];
        html += '<div class="cc-srow"' + (on ? '' : ' style="opacity:.45"') + '>'
          + '<span class="day">' + DAY_NAMES[s.day] + '</span>'
          + '<span>' + esc(slot ? slot.label : s.slot) + '</span>'
          + '<span class="room">' + esc(s.room || '') + '</span>'
          + '<span class="room">' + esc(s.weeks || '') + '周</span></div>';
      });
      html += '</div>';
    } else {
      html += '<div class="cc-sessions"><div class="cc-srow"><span class="muted">无固定排课（线上课程）</span></div></div>';
    }

    html += '<div class="cc-foot">';
    if (c.sessions.length) {
      html += onSessions.length
        ? '<span class="badge ok">本周 ' + onSessions.length + ' 节</span>'
        : '<span class="badge">本周无课</span>';
    }
    const rn = (c.reminders || []).filter((r) => !r.done).length;
    if (rn) html += '<span class="badge warn">' + rn + ' 个提醒</span>';
    if (hw.length) html += '<span class="badge">' + hw.length + ' 项作业</span>';
    if (undone) html += '<span class="badge danger">' + undone + ' 项待完成</span>';
    html += '<span style="margin-left:auto;display:flex;gap:2px">'
      + '<button class="icon-btn" data-act="add-remind" data-id="' + c.id + '" title="添加课程提醒">＋</button>'
      + '<button class="icon-btn" data-act="add-hw-for" data-id="' + c.id + '" title="添加这门课的作业">✎</button>'
      + '</span></div></div>';
  });
  html += '</div>';

  if (!list.length) html += '<div class="empty"><div class="em-title">没有匹配的课程</div><div>换个筛选条件试试</div></div>';

  html += '</div>';
  return html;
}

function typeBadge(t) {
  const map = { '线上': 'online', '实验': 'lab', '体育': 'pe' };
  return '<span class="badge ' + (map[t] || '') + '">' + esc(t) + '</span>';
}

function renderScore() {
  const f = FILTERS.score;
  const showPeople = f.person === 'both' ? state.people : [personById(f.person)];

  const months = {};
  state.scores.forEach((s) => { months[s.month || (s.date || '').slice(0, 7)] = true; });
  /* 有记录的月份 + 本学期月份兜底（数据为空时也能按月筛选） */
  const semMonths = [];
  {
    const t0 = termStartDate();
    for (let i = 0; i < 6; i++) {
      const d = new Date(t0.getFullYear(), t0.getMonth() + i, 1);
      semMonths.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1));
    }
  }
  const monthSet = new Set(semMonths.concat(Object.keys(months).filter(Boolean)));
  const monthList = Array.from(monthSet).sort().reverse();

  let html = '<div class="view">';

  html += '<div class="filterbar">'
    + '<div class="field" style="min-width:120px"><label>按人</label><select class="select" data-filter="sc-person">'
    + '<option value="both"' + (f.person === 'both' ? ' selected' : '') + '>两人</option>'
    + state.people.map((p) => '<option value="' + p.id + '"' + (f.person === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field" style="min-width:170px"><label>加分栏位</label><select class="select" data-filter="sc-cat">'
    + '<option value="all">全部栏位</option>'
    + state.scoreCategories.map((c) => '<option value="' + c.id + '"' + (f.category === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field" style="min-width:120px"><label>月份</label><select class="select" data-filter="sc-month">'
    + '<option value="all">全部月份</option>'
    + monthList.map((m) => '<option value="' + m + '"' + (f.month === m ? ' selected' : '') + '>' + m + '</option>').join('')
    + '</select></div>'
    + '<div class="grow"></div>'
    + '<button class="btn primary" data-act="add-score">+ 录入加分</button>'
    + '</div>';

  html += '<div class="score-cols">';
  showPeople.forEach((p) => {
    const all = state.scores.filter((s) => s.personId === p.id
      && (f.category === 'all' || s.categoryId === f.category)
      && (f.month === 'all' || (s.month || (s.date || '').slice(0, 7)) === f.month));
    const total = all.reduce((n, s) => n + (Number(s.score) || 0), 0);

    html += '<div class="person-panel">'
      + '<div class="pp-head"><span class="avatar ' + p.id + '" style="width:30px;height:30px;font-size:13px">' + esc(p.short || p.name) + '</span>'
      + '<span class="pp-name">' + esc(p.name) + '</span>'
      + '<div class="pp-total"><span class="num" style="color:var(--' + (p.id === 'rain' ? 'rain' : 'me') + ')">' + total.toFixed(1) + '</span>'
      + '<span class="lb">累计奖励分</span></div></div>';

    state.scoreCategories.forEach((cat) => {
      const items = all.filter((s) => s.categoryId === cat.id)
        .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const sum = items.reduce((n, s) => n + (Number(s.score) || 0), 0);
      const cap = cat.cap || null;
      let capBadge = '';
      if (cap) {
        if (sum >= cap) capBadge = '<span class="badge danger">已满 ' + cap + '</span>';
        else if (sum > cap * 0.75) capBadge = '<span class="badge warn">接近上限</span>';
        else capBadge = '<span class="badge">' + sum.toFixed(1) + ' / ' + cap + '</span>';
      }
      html += '<div class="cat-row"><span class="cat-name">' + esc(cat.name) + '</span>'
        + '<span class="badge">' + items.length + ' 条</span>'
        + capBadge
        + '<span class="cat-sum">' + sum.toFixed(1) + '</span></div>';
      if (items.length) {
        html += '<div class="cat-detail">';
        items.forEach((s) => {
          html += '<div class="score-item">'
            + '<span class="si-date">' + esc(s.date || '') + '</span>'
            + '<span class="si-item">' + esc(s.item || '')
            + (s.note ? ' <span class="si-note">· ' + esc(s.note) + '</span>' : '') + '</span>'
            + '<span class="si-val">+' + Number(s.score || 0).toFixed(1) + '</span>'
            + '<button class="icon-btn" data-act="del-score" data-id="' + s.id + '" title="删除">✕</button>'
            + '</div>';
        });
        html += '</div>';
      }
    });
    html += '</div>';
  });
  html += '</div>';

  html += '<div class="card pad mt14"><div class="section-head" style="margin-bottom:6px"><h2>字段说明</h2>'
    + '<span class="sub">取自量化月表表头</span></div>'
    + '<p class="muted tiny" style="margin:0">月表中共 <b>6 栏</b>加分字段（每栏由「明细项 + 分数」两列组成），分别为：'
    + state.scoreCategories.map((c) => esc(c.name) + '（上限 ' + c.cap + ' 分）').join('、')
    + '。栏位加满后无法再录入，会给出提示；「累计奖励分」为各栏之和，此处自动计算。</p></div>';

  html += '</div>';
  return html;
}

/* ---------------- 视图：设置 ---------------- */

function renderSettings() {
  let html = '<div class="view">';

  html += '<div class="card pad"><div class="section-head"><h2>学期设置</h2><span class="sub">用于计算当前周次与课表单双周</span></div>'
    + '<div class="form-grid">'
    + '<div class="field"><label>学期第一周的周一（决定周次与单双周）</label><input type="date" class="input" data-set="termStart" value="' + esc(state.meta.termStart) + '"></div>'
    + '<div class="field"><label>学期总周数</label><input type="number" class="input" min="1" max="30" data-set="totalWeeks" value="' + esc(state.meta.totalWeeks) + '"></div>'
    + '<div class="field"><label>学期名称</label><input class="input" data-set="termName" value="' + esc(state.meta.termName) + '"></div>'
    + '<div class="field"><label>班级</label><input class="input" data-set="className" value="' + esc(state.meta.className) + '"></div>'
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>成员</h2><span class="sub">两人课表相同，作业各自独立</span></div>'
    + '<div class="form-grid">'
    + state.people.map((p) => '<div class="field"><label>' + (p.id === 'me' ? '第一位（豆沙馅）' : '第二位（下雨天）') + '</label>'
      + '<input class="input" data-person-name="' + p.id + '" value="' + esc(p.name) + '"></div>').join('')
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>基本</h2><span class="sub">改名后两人同步生效</span></div>'
    + '<div class="mini-list">'
    + '<div class="mini-item"><div class="mi-main"><div>网站名称</div>'
    + '<div class="mi-sub">显示在左上角和浏览器标签页，留空恢复默认「课程管理平台」</div>'
    + '<input class="input" data-set="siteName" value="' + esc(state.meta.siteName || '') + '" placeholder="课程管理平台" style="width:200px"></div></div>'
    + '</div></div>'
    + '<div class="card pad mt14"><div class="section-head"><h2>外观</h2><span class="sub">按浏览器记忆，不随数据同步</span></div>'
    + '<div class="mini-list">'
    + '<div class="mini-item"><div class="mi-main"><div>浏览器弹窗提醒</div>'
    + '<div class="mi-sub">页面打开时：考试前 60/30/10 分钟、作业与待办截止当天自动弹窗</div></div>'
    + '<button class="btn sm" data-act="notify-perm">开启授权</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>深浅色模式</div>'
    + '<div class="mi-sub">当前：' + (themeDark() ? '深色' : '浅色') + '，也可以点右上角 🌙 快捷切换</div></div>'
    + '<button class="btn sm" data-act="toggle-theme">切换</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>背景数学动画</div>'
    + '<div class="mi-sub">Three.js 流动正弦曲面 + 环面纽结 + 漂浮公式，低饱和浅色不干扰阅读</div></div>'
    + '<button class="btn sm" data-act="toggle-bg">' + (bgEnabled() ? '关闭' : '开启') + '</button></div>'
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>数据</h2><span class="sub">'
    + (mode === 'remote' ? '已接入 Supabase 云数据库，两人共用同一份数据'
      : mode === 'server' ? '保存在本机 course-hub/data/state.json' : '线上版：保存在当前浏览器 localStorage')
    + '</span></div>'
    + '<div class="mini-list">'
    + '<div class="mini-item"><div class="mi-main"><div>导出课表到日历</div><div class="mi-sub">生成 .ics 文件，可导入手机日历 / Google 日历 / Outlook，自动带上课提醒</div></div>'
    + '<button class="btn sm" data-act="export-ics">导出日历</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>导出数据</div><div class="mi-sub">下载 JSON 备份，包含课程、作业与加分记录</div></div>'
    + '<button class="btn sm" data-act="export">导出</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>导入数据</div><div class="mi-sub">从 JSON 备份恢复，会覆盖当前全部数据</div></div>'
    + '<button class="btn sm" data-act="import">选择文件</button>'
    + '<input type="file" id="importFile" accept="application/json,.json" hidden></div>'
    + '<div class="mini-item"><div class="mi-main"><div>从本设备缓存恢复</div><div class="mi-sub">若云端数据被清空，可尝试用这台设备上一次自动缓存的数据恢复</div></div>'
    + '<button class="btn sm" data-act="restore-local">恢复</button></div>'
    + (function () {
        const snaps = readSnapshots();
        if (!snaps.length) return '';
        const s0 = snaps[0];
        return '<div class="mini-item"><div class="mi-main"><div>历史快照（' + snaps.length + ' 份）</div>'
          + '<div class="mi-sub">最近 ' + esc(s0.at.slice(5, 16).replace('T', ' ')) + ' · 作业 ' + s0.counts.a + ' · 待办 ' + s0.counts.t + ' · 加分 ' + s0.counts.s + ' · 考试 ' + s0.counts.e + '（保存前自动存档，最多 6 份）</div></div>'
          + '<button class="btn sm" data-act="restore-snap">查看恢复</button></div>';
      })()
    + '<div class="mini-item"><div class="mi-main"><div>确认清空并同步</div><div class="mi-sub">如果你是真的要删光全部作业/待办/加分（顶部显示已拦截时用这个放行）</div></div>'
    + '<button class="btn sm danger" data-act="force-empty-sync">放行一次</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>重置课程数据</div><div class="mi-sub">仅重置 16 门课程，保留作业与加分记录</div></div>'
    + '<button class="btn sm danger" data-act="reset-courses">重置课程</button></div>'
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>课程清单</h2><span class="sub">共 ' + state.courses.length + ' 门</span></div>'
    + '<div class="mini-list">'
    + state.courses.map((c) => '<div class="mini-item"><span class="badge' + (c.type === '线上' ? ' online' : c.type === '实验' ? ' lab' : c.type === '体育' ? ' pe' : '') + '">' + esc(c.type) + '</span>'
      + '<div class="mi-main"><div>' + esc(c.name) + '</div><div class="mi-sub">' + esc(c.teacher || '教师待定')
      + (c.sessions.length ? ' · ' + c.sessions.length + ' 个上课时段' : ' · 线上无排课') + '</div></div></div>').join('')
    + '</div></div>';

  html += '</div>';
  return html;
}

/* ---------------- 课程详情弹窗 ---------------- */

function openCourseDetail(id) {
  const c = courseById(id);
  if (!c) return;
  openDetailId = id;
  const week = Math.max(1, currentWeek());

  let body = '<dl class="kv">'
    + '<dt>教师</dt><dd>' + esc(c.teacher || '待定') + '</dd>'
    + '<dt>类型</dt><dd>' + esc(c.type) + (c.campus ? ' · ' + esc(c.campus) : '') + '</dd>'
    + (c.credit ? '<dt>学分</dt><dd>' + esc(c.credit) + '</dd>' : '')
    + '</dl>';

  if (c.note) body += '<div class="row-note mt8">' + esc(c.note) + '</div>';

  body += '<div class="sub-title">上课安排</div>';
  if (!c.sessions.length) {
    body += '<p class="muted tiny">该课程无固定排课（线上课程）。</p>';
  } else {
    body += '<div class="mini-list">';
    c.sessions.forEach((s) => {
      const slot = slotById(s.slot);
      const on = parseWeeks(s.weeks)[week];
      body += '<div class="mini-item"><span class="badge' + (on ? ' ok' : '') + '">' + DAY_NAMES[s.day] + '</span>'
        + '<div class="mi-main"><div>' + esc(slot ? slot.label + '（' + slot.time + '）' : s.slot) + '</div>'
        + '<div class="mi-sub">' + esc(s.room || '教室待定') + ' · ' + esc(s.weeks || '每周') + '周'
        + (on ? ' · 本周有课' : ' · 本周无课') + '</div></div></div>';
    });
    body += '</div>';
  }

  body += '<div class="sub-title">考试与阶段测试</div>';
  const exams = (c.exams || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!exams.length) {
    body += '<p class="muted tiny">暂无考试安排。期中、期末、阶段测试都可以在这里登记。</p>';
  } else {
    body += '<div class="mini-list">';
    exams.forEach((x) => {
      const d = x.date ? new Date(x.date) : null;
      let tag = '<span class="badge">考试</span>';
      if (d) {
        const days = Math.ceil((startOfDay(d) - startOfDay(new Date())) / 86400000);
        if (days < 0) tag = '<span class="badge">已结束</span>';
        else if (days === 0) tag = '<span class="badge danger">今天</span>';
        else if (days <= 7) tag = '<span class="badge warn">' + days + ' 天后</span>';
      }
      body += '<div class="mini-item' + (d && d < new Date() ? ' is-done' : '') + '">'
        + tag
        + '<div class="mi-main"><div>' + esc(x.title) + '</div>'
        + '<div class="mi-sub">' + (d ? esc(fmtDateShort(d) + ' ' + fmtTime(d)) : '时间待定')
        + (x.location ? ' · ' + esc(x.location) : '')
        + (x.note ? ' · ' + esc(x.note) : '') + '</div></div>'
        + '<button class="icon-btn" data-act="edit-exam" data-id="' + c.id + '" data-xid="' + x.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-exam" data-id="' + c.id + '" data-xid="' + x.id + '" title="删除">✕</button>'
        + '</div>';
    });
    body += '</div>';
  }
  body += '<button class="btn sm mt8" data-act="add-exam" data-id="' + c.id + '">+ 添加考试 / 测验</button>';

  body += '<div class="sub-title">课程提醒</div>';
  const rems = c.reminders || [];
  if (!rems.length) {
    body += '<p class="muted tiny">暂无提醒。可为线上课或重要节点设置提醒。</p>';
  } else {
    body += '<div class="mini-list">';
    rems.forEach((r) => {
      const rd = r.datetime ? new Date(r.datetime) : null;
      body += '<div class="mini-item' + (r.done ? ' is-done' : '') + '">'
        + '<button class="icon-btn" data-act="toggle-remind" data-id="' + c.id + '" data-rid="' + r.id + '" title="标记完成">'
        + (r.done ? '✓' : '○') + '</button>'
        + '<div class="mi-main"><div>' + esc(r.title) + '</div>'
        + '<div class="mi-sub">' + (rd ? esc(fmtDateShort(rd) + ' ' + fmtTime(rd)) : '未设时间')
        + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>'
        + '<button class="icon-btn" data-act="edit-remind" data-id="' + c.id + '" data-rid="' + r.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-remind" data-id="' + c.id + '" data-rid="' + r.id + '" title="删除">✕</button>'
        + '</div>';
    });
    body += '</div>';
  }
  body += '<button class="btn sm mt8" data-act="add-remind" data-id="' + c.id + '">+ 添加提醒</button>';

  const hw = state.assignments.filter((a) => a.courseId === c.id).sort((a, b) => hwSortKey(a) - hwSortKey(b));
  body += '<div class="sub-title">作业清单（' + hw.length + '）</div>';
  if (!hw.length) {
    body += '<p class="muted tiny">暂无作业。</p>';
  } else {
    body += '<div class="mini-list">';
    hw.forEach((a) => {
      const di = dueInfo(a);
      body += '<div class="mini-item">'
        + '<div class="mi-main"><div>' + esc(a.title) + ' <span class="badge ' + (di.cls || '') + '">' + esc(di.text) + '</span></div>'
        + '<div class="mi-sub" style="display:flex;gap:6px;margin-top:5px">'
        + state.people.map((p) => doneChip(a, p)).join('') + '</div></div>'
        + '<button class="icon-btn" data-act="edit-hw" data-id="' + a.id + '">✎</button>'
        + '</div>';
    });
    body += '</div>';
  }
  body += '<button class="btn sm mt8" data-act="add-hw-for" data-id="' + c.id + '">+ 添加这门课的作业</button>';

  openModal(c.name, body, [{ label: '关闭', key: 'close', primary: true }]);
}

function openReminderForm(courseId, remId) {
  const c = courseById(courseId);
  if (!c) return;
  const r = remId ? (c.reminders || []).filter((x) => x.id === remId)[0] : null;
  const def = r ? r.datetime : (function () {
    const d = new Date(Date.now() + 86400000);
    d.setMinutes(0, 0, 0);
    return dateKey(d) + 'T' + pad2(d.getHours()) + ':00';
  })();

  const body = '<div class="form-grid">'
    + '<div class="field span2"><label>提醒内容</label><input class="input" id="rmTitle" placeholder="例如：线上课作业截止、实验报告提交" value="' + esc(r ? r.title : '') + '"></div>'
    + '<div class="field span2"><label>提醒时间</label><input type="datetime-local" class="input" id="rmTime" value="' + esc(def) + '"></div>'
    + '<div class="field span2"><label>备注（选填）</label><textarea class="textarea" id="rmNote" placeholder="补充说明">' + esc(r ? r.note : '') + '</textarea></div>'
    + '</div>';

  openModal((r ? '编辑提醒' : '添加提醒') + ' · ' + c.name, body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);

  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    const title = $('#rmTitle').value.trim();
    if (!title) { toast('请填写提醒内容', true); return; }
    const item = {
      id: r ? r.id : uid('r'),
      title: title,
      datetime: $('#rmTime').value,
      note: $('#rmNote').value.trim(),
      done: r ? r.done : false
    };
    if (!c.reminders) c.reminders = [];
    if (r) c.reminders[c.reminders.indexOf(r)] = item;
    else c.reminders.push(item);
    save();
    toast(r ? '提醒已更新' : '提醒已添加');
    closeModalThen(() => { render(); openCourseDetail(courseId); });
  };
}

function openExamForm(courseId, examId) {
  let c = courseId ? courseById(courseId) : null;
  if (courseId && !c) return;
  const x = c && examId ? (c.exams || []).filter((e) => e.id === examId)[0] : null;
  const defDate = x ? x.date : (function () {
    const d = new Date(Date.now() + 7 * 86400000);
    d.setHours(10, 0, 0, 0);
    return dateKey(d) + 'T' + pad2(d.getHours()) + ':00';
  })();

  let body = '<div class="form-grid">';
  if (!c) {
    body += '<div class="field span2"><label>课程</label><select class="select" id="exCourse">'
      + '<option value="">请选择课程</option>'
      + state.courses.map((cc) => '<option value="' + cc.id + '">' + esc(cc.shortName || cc.name) + '</option>').join('')
      + '</select></div>';
  }
  body += '<div class="field span2"><label>名称</label><input class="input" id="exTitle" placeholder="例如：期中考试 / 阶段测试一 / 期末考试" value="' + esc(x ? x.title : '') + '"></div>'
    + '<div class="field"><label>录入对象</label><select class="select" id="exOwner">'
    + [['both', '两人'], ['me', state.people[0].name], ['rain', (state.people[1] || state.people[0]).name]]
      .map((o) => '<option value="' + o[0] + '"' + ((x ? (x.owner || 'both') : 'both') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>开始时间</label><input type="datetime-local" class="input" id="exDate" value="' + esc(defDate) + '"></div>'
    + '<div class="field"><label>地点（选填）</label><input class="input" id="exLoc" placeholder="例如：07208" value="' + esc(x ? x.location : '') + '"></div>'
    + '<div class="field span2"><label>备注（选填）</label><textarea class="textarea" id="exNote" placeholder="考试范围、题型等">' + esc(x ? x.note : '') + '</textarea></div>'
    + '</div>';

  openModal((x ? '编辑考试' : '添加考试') + (c ? ' · ' + c.name : ''), body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);

  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    if (!c) {
      const cid = $('#exCourse').value;
      c = courseById(cid);
      if (!c) { toast('请选择课程', true); return; }
    }
    const title = $('#exTitle').value.trim();
    if (!title) { toast('请填写考试名称', true); return; }
    if (!c.exams) c.exams = [];
    const item = {
      id: x ? x.id : uid('e'),
      title: title,
      owner: $('#exOwner') ? $('#exOwner').value : 'both',
      date: $('#exDate').value,
      location: $('#exLoc').value.trim(),
      note: $('#exNote').value.trim()
    };
    if (x) c.exams[c.exams.indexOf(x)] = item;
    else c.exams.push(item);
    save();
    toast(x ? '考试已更新' : '考试已登记');
    closeModalThen(() => { render(); openCourseDetail(c.id); });
  };
}

function openHomeworkForm(id, presetCourseId) {
  const a = id ? state.assignments.filter((x) => x.id === id)[0] : null;
  const isNew = !a;

  const body = '<div class="form-grid">'
    + '<div class="field span2"><label>课程</label><select class="select" id="hwCourse">'
    + '<option value="">未指定</option>'
    + state.courses.map((c) => '<option value="' + c.id + '"' + ((a ? a.courseId : presetCourseId) === c.id ? ' selected' : '') + '>' + esc(c.shortName || c.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field span2"><label>作业标题</label><input class="input" id="hwTitle" placeholder="例如：习题 1.3、实验报告二" value="' + esc(a ? a.title : '') + '"></div>'
    + '<div class="field"><label>作业类型</label><select class="select" id="hwKind">'
    + [['normal', '平时作业'], ['final', '期末作业']]
      .map((o) => '<option value="' + o[0] + '"' + ((a ? (a.kind || 'normal') : 'normal') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>录入对象</label><select class="select" id="hwOwner">'
    + [['both', '两人'], ['me', state.people[0].name], ['rain', (state.people[1] || state.people[0]).name]]
      .map((o) => '<option value="' + o[0] + '"' + ((a ? (a.owner || 'both') : 'both') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>进行时间（选填）</label><input type="datetime-local" class="input" id="hwStart" value="' + esc(a ? (a.startTime || '') : '') + '"></div>'
    + '<div class="field"><label>截止日期时间</label><input type="datetime-local" class="input" id="hwDue" value="' + esc(a ? a.due : '') + '"></div>'
    + '<div class="field"><label>公共备注（两人共享）</label><input class="input" id="hwNote" placeholder="例如：提交到学习通" value="' + esc(a ? a.note : '') + '"></div>'
    + (isNew ? '' : state.people.map((p) => {
      const st = hwStatus(a, p.id);
      return '<div class="field"><label>' + esc(p.name) + ' 的个人备注</label>'
        + '<input class="input" data-pnote="' + p.id + '" placeholder="完成情况备注" value="' + esc(st.note || '') + '"></div>';
    }).join(''))
    + '</div>';

  openModal(isNew ? '新增作业' : '编辑作业', body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);

  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    const title = $('#hwTitle').value.trim();
    if (!title) { toast('请填写作业标题', true); return; }
    const item = a || { id: uid('a'), status: {}, createdAt: new Date().toISOString() };
    item.courseId = $('#hwCourse').value;
    item.title = title;
    item.startTime = $('#hwStart') ? $('#hwStart').value : '';
    item.due = $('#hwDue').value;
    item.note = $('#hwNote').value.trim();
    item.kind = $('#hwKind').value || 'normal';
    item.owner = $('#hwOwner') ? $('#hwOwner').value : 'both';
    if (!isNew) {
      $$('[data-pnote]').forEach((el) => { hwStatus(item, el.dataset.pnote).note = el.value.trim(); });
    } else {
      state.people.forEach((p) => { if (hwApplies(item, p.id)) hwStatus(item, p.id); });
    }
    if (isNew) state.assignments.push(item);
    save();
    toast(isNew ? '作业已添加' : '作业已更新');
    closeModalThen(render);
  };
}

function openScoreForm() {
  const today = dateKey(new Date());
  const body = '<div class="form-grid">'
    + '<div class="field"><label>录入对象</label><select class="select" id="scPerson">'
    + '<option value="both">两人同时加</option>'
    + state.people.map((p) => '<option value="' + p.id + '"' + (activePerson === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>加分栏位</label><select class="select" id="scCat">'
    + state.scoreCategories.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('')
    + '</select></div>'
    + '<div class="field"><label>分数</label><input type="number" step="0.1" min="0" class="input" id="scVal" placeholder="例如 0.2"></div>'
    + '<div class="field"><label>日期</label><input type="date" class="input" id="scDate" value="' + today + '"></div>'
    + '<div class="field span2"><label>事由 / 明细项</label><input class="input" id="scItem" placeholder="例如：第三周教授接待日活动"></div>'
    + '<div class="field span2"><label>备注（选填）</label><input class="input" id="scNote" placeholder="补充说明"></div>'
    + '<div class="field span2"><label>各栏上限</label><div class="muted tiny" style="padding-top:2px">'
    + state.scoreCategories.map((c) => esc(c.short) + ' <b style="font-weight:600;color:var(--text-2)">' + c.cap + '</b>').join(' 分 · ')
    + ' 分</div></div>'
    + '</div>';

  openModal('录入量化加分', body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);

  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    const val = parseFloat($('#scVal').value);
    if (isNaN(val)) { toast('请填写分数', true); return; }
    const item = $('#scItem').value.trim();
    if (!item) { toast('请填写事由', true); return; }
    const date = $('#scDate').value || today;
    const catId = $('#scCat').value;
    const cat = catById(catId);
    const cap = cat.cap || null;
    const chosen = $('#scPerson').value;
    const targets = chosen === 'both' ? state.people.slice() : [personById(chosen)];

    /* 先全员校验上限，任一超限就整体不写入，避免一人成功一人失败 */
    if (cap) {
      for (const p of targets) {
        const cur = state.scores.filter((s) => s.personId === p.id && s.categoryId === catId)
          .reduce((n, s) => n + (Number(s.score) || 0), 0);
        if (cur + val > cap) {
          toast(p.name + ' 的「' + cat.short + '」栏上限 ' + cap + ' 分，当前 ' + cur.toFixed(1) + '，最多还可加 ' + (cap - cur).toFixed(1) + ' 分', true);
          return;
        }
      }
    }
    for (const p of targets) {
      const cur = state.scores.filter((s) => s.personId === p.id && s.categoryId === catId)
        .reduce((n, s) => n + (Number(s.score) || 0), 0);
      state.scores.push({
        id: uid('s'),
        personId: p.id,
        categoryId: catId,
        item: item,
        score: val,
        date: date,
        month: date.slice(0, 7),
        note: $('#scNote').value.trim(),
        createdAt: new Date().toISOString()
      });
      p._fullAfter = cap && cur + val >= cap;
    }
    const fullNames = targets.filter((p) => p._fullAfter).map((p) => p.name);
    targets.forEach((p) => { delete p._fullAfter; });
    save();
    toast(fullNames.length
      ? '已给' + (fullNames.join('、')) + '录入，该栏已加满 ' + cap + ' 分'
      : (targets.length > 1 ? '已给两人各加 ' + val + ' 分' : '加分已录入'));
    closeModalThen(render);
  };
}

function closeModalThen(fn) {
  closeModal();
  fn();
}

/* ---------------- 渲染调度 ---------------- */

/* 切换页面：顶部 tab 与移动端底部 tab 状态同步 */
function switchView(v) {
  activeView = v;
  $$('#tabbar .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === v));
  $$('#bottomTab .bt').forEach((b) => b.classList.toggle('is-active', b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}

function render() {
  const main = $('#main');
  if (activeView === 'dash') main.innerHTML = renderDash();
  else if (activeView === 'timetable') main.innerHTML = renderTimetable();
  else if (activeView === 'courses') main.innerHTML = renderCourses();
  else if (activeView === 'homework') main.innerHTML = renderHomework();
  else if (activeView === 'exam') main.innerHTML = renderExams();
  else if (activeView === 'score') main.innerHTML = renderScore();
  else if (activeView === 'settings') main.innerHTML = renderSettings();

  updateHeader();
  animateView();
}

/* GSAP 入场动效：仅切换页面时播放一次（数据刷新不重播，CDN 不可用时静默跳过） */
let lastAnimatedView = null;
function animateView() {
  if (!window.gsap) return;
  if (lastAnimatedView === activeView) return;
  lastAnimatedView = activeView;
  const els = document.querySelectorAll('#main .card, #main .dash-hero, #main .stats-strip, #main .exam-hero');
  if (!els.length) return;
  try {
    window.gsap.from(els, { y: 12, opacity: 0, duration: .38, stagger: .045, ease: 'power2.out', clearProps: 'all', overwrite: true });
  } catch (e) { /* 动画失败不影响功能 */ }
}

function updateHeader() {
  const cw = currentWeek();
  const siteName = (state.meta.siteName || '').trim() || '豆沙馅和下雨天';
  const h1 = document.querySelector('.brand-text h1');
  if (h1) h1.textContent = siteName;
  /* 名字里已含两人时不再追加后缀，避免「豆沙馅和下雨天 · 我和下雨天」这种重复 */
  document.title = siteName;
  $('#weekNum').textContent = cw > 0 ? cw : '–';
  $$('#personSwitch .ps-btn').forEach((b) => {
    const p = b.dataset.person && b.dataset.person !== 'both' ? personById(b.dataset.person) : null;
    if (p) b.textContent = p.name;
  });
  $('#brandSub').textContent = state.meta.termName + ' · ' + state.meta.className
    + ' · ' + state.courses.length + ' 门课'
    + (cw === 0 ? ' · 距开学 ' + Math.ceil((termStartDate() - startOfDay(new Date())) / 86400000) + ' 天' : '');
  updateBadges();
}

/* 标签页角标：把逾期 / 今日截止的待办数顶到导航上 */
function updateBadges() {
  const now = new Date();
  const LABELS = { homework: '作业', exam: '考试' };
  const setBadge = (view, n) => {
    const tab = $('#tabbar [data-view="' + view + '"]');
    if (!tab) return;
    tab.textContent = LABELS[view] || '';
    if (n > 0) tab.insertAdjacentHTML('beforeend', '<span class="tab-badge">' + n + '</span>');
  };

  const dueNow = (iso) => {
    const d = new Date(iso);
    return d < now || Math.floor((startOfDay(d) - startOfDay(now)) / 86400000) === 0;
  };

  let hw = 0;
  state.assignments.forEach((a) => {
    if (!a.due) return;
    state.people.forEach((p) => {
      if (hwStatus(a, p.id).done) return;
      if (dueNow(a.due)) hw++;
    });
  });
  (state.todos || []).forEach((t) => {
    if (!t.due) return;
    todoOwners(t).forEach((p) => {
      if (hwStatus(t, p.id).done) return;
      if (dueNow(t.due)) hw++;
    });
  });

  let ex = 0;
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const days = Math.ceil((startOfDay(new Date(x.date)) - startOfDay(now)) / 86400000);
      if (days >= 0 && days <= 3) ex++;
    });
  });

  setBadge('homework', hw);
  setBadge('exam', ex);

  /* 移动端底部 Tab 红点 */
  const btHw = $('#btHwDot'), btEx = $('#btExDot');
  if (btHw) { btHw.textContent = hw; btHw.hidden = hw <= 0; }
  if (btEx) { btEx.textContent = ex; btEx.hidden = ex <= 0; }
}

/* ---------------- 事件绑定 ---------------- */

function onAction(act, el, ev) {
  const id = el.dataset.id;
  const pid = el.dataset.person;

  switch (act) {
    case 'open-course': openCourseDetail(id); break;

    case 'toggle-done': {
      /* 作业和其他待办都复用这套双人勾选，两个集合都要找 */
      let a = state.assignments.filter((x) => x.id === id)[0];
      if (!a && state.todos) a = state.todos.filter((x) => x.id === id)[0];
      if (!a) break;
      const st = hwStatus(a, pid);
      st.done = !st.done;
      st.doneAt = st.done ? new Date().toISOString() : null;
      save();
      render();
      if (openDetailId) openCourseDetail(openDetailId);
      break;
    }

    case 'force-empty-sync': {
      if (!window.confirm('确认把当前已清空的状态同步到云端？之后恢复只能靠历史快照。')) break;
      writeLastCloudCounts(state);
      save(true);
      toast('已放行并同步');
      render();
      break;
    }

    case 'restore-snap': {
      const snaps = readSnapshots();
      if (!snaps.length) { toast('还没有快照', true); break; }
      const list = snaps.map((s, i) => '<div class="mini-item"><div class="mi-main"><div>'
        + esc(s.at.slice(5, 16).replace('T', ' ')) + (i === 0 ? ' <span class="badge ok">最近</span>' : '')
        + '</div><div class="mi-sub">作业 ' + s.counts.a + ' · 待办 ' + s.counts.t + ' · 加分 ' + s.counts.s + ' · 考试 ' + s.counts.e + '</div></div>'
        + '<button class="btn sm" data-act="restore-snap-idx" data-idx="' + i + '">恢复</button></div>').join('');
      openModal('历史快照恢复', '<div class="mini-list">' + list + '</div>'
        + '<p class="muted tiny">快照是每次保存前自动存档的上一份数据（最多 6 份，只存在本设备浏览器里）。恢复会覆盖当前数据并同步云端。</p>', [
        { label: '关闭', key: 'cancel' }
      ]);
      break;
    }

    case 'restore-snap-idx': {
      const snaps = readSnapshots();
      const s = snaps[Number(el.dataset.idx)];
      if (!s || !s.data) { toast('快照不存在', true); break; }
      if (!window.confirm('恢复到 ' + s.at.slice(5, 16).replace('T', ' ') + ' 的快照（作业 ' + s.counts.a + ' · 待办 ' + s.counts.t + ' · 加分 ' + s.counts.s + '）？将覆盖当前数据并同步云端。')) break;
      state = s.data;
      if (!state.slots || !state.slots.length) state.slots = buildFromClientSeed().slots;
      save(true);
      toast('快照已恢复并同步云端');
      closeModalThen(render);
      break;
    }

    case 'restore-local': {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem('course-hub-state-v1') || 'null'); } catch (e) { cached = null; }
      if (!cached || !Array.isArray(cached.assignments)) { toast('本设备缓存里没有可恢复的数据', true); break; }
      const cN = (cached.assignments || []).length + (cached.scores || []).length + (cached.todos || []).length;
      const nowN = (state.assignments || []).length + (state.scores || []).length + (state.todos || []).length;
      if (cN <= nowN) { toast('本设备缓存 ' + cN + ' 条，不多于当前 ' + nowN + ' 条，无需恢复'); break; }
      if (!window.confirm('将从本设备缓存恢复：作业 ' + (cached.assignments || []).length + ' · 待办 ' + (cached.todos || []).length + ' · 加分 ' + (cached.scores || []).length + ' 条，并同步到云端。确定？')) break;
      state.assignments = cached.assignments || [];
      state.todos = cached.todos || [];
      state.scores = cached.scores || [];
      if (Array.isArray(cached.nudges)) state.nudges = cached.nudges;
      save();
      toast('已恢复 ' + cN + ' 条数据并同步云端');
      render();
      break;
    }

    case 'dismiss-pwa-hint': {
      try { localStorage.setItem('coursehub-pwa-hint', 'off'); } catch (e) { /* 忽略 */ }
      const hint = $('#pwaHint');
      if (hint) hint.remove();
      break;
    }

    case 'add-hw': openHomeworkForm(null, FILTERS.hw.courseId === 'all' ? '' : FILTERS.hw.courseId); break;
    case 'add-hw-for': closeModal(); openHomeworkForm(null, id); break;
    case 'edit-hw': openHomeworkForm(id); break;
    case 'del-hw': {
      const a = state.assignments.filter((x) => x.id === id)[0];
      if (!a) break;
      confirmModal('删除作业', '确定删除「' + a.title + '」？两人的完成状态会一并删除。', () => {
        state.assignments = state.assignments.filter((x) => x.id !== id);
        save(); render(); toast('已删除');
      });
      break;
    }

    case 'add-remind': ev.stopPropagation(); openReminderForm(id); break;
    case 'edit-remind': openReminderForm(id, el.dataset.rid); break;
    case 'del-remind': {
      const c = courseById(id);
      if (!c) break;
      c.reminders = (c.reminders || []).filter((r) => r.id !== el.dataset.rid);
      save(); closeModalThen(() => { render(); openCourseDetail(id); });
      break;
    }
    case 'toggle-remind': {
      const c = courseById(id);
      if (!c) break;
      const r = (c.reminders || []).filter((x) => x.id === el.dataset.rid)[0];
      if (r) { r.done = !r.done; save(); closeModalThen(() => { render(); openCourseDetail(id); }); }
      break;
    }

    case 'add-exam': ev.stopPropagation(); openExamForm(id); break;
    case 'edit-exam': openExamForm(id, el.dataset.xid); break;
    case 'del-exam': {
      const c = courseById(id);
      if (!c) break;
      c.exams = (c.exams || []).filter((e) => e.id !== el.dataset.xid);
      save(); closeModalThen(() => { render(); openCourseDetail(id); });
      break;
    }
    case 'add-todo': openTodoForm(); break;
    case 'edit-todo': openTodoForm(id); break;
    case 'del-todo': {
      const t = (state.todos || []).filter((x) => x.id === id)[0];
      if (!t) break;
      confirmModal('删除待办', '确定删除「' + t.title + '」？', () => {
        state.todos = state.todos.filter((x) => x.id !== id);
        save(); render(); toast('已删除');
      });
      break;
    }

    case 'add-score': openScoreForm(); break;
    case 'del-score': {
      const s = state.scores.filter((x) => x.id === id)[0];
      if (!s) break;
      confirmModal('删除加分记录', '确定删除「' + s.item + ' +' + s.score + '」？', () => {
        state.scores = state.scores.filter((x) => x.id !== id);
        save(); render(); toast('已删除');
      });
      break;
    }

    case 'week-prev': selWeek = Math.max(1, selWeek - 1); render(); break;
    case 'week-next': selWeek = Math.min(state.meta.totalWeeks || 18, selWeek + 1); render(); break;
    case 'week-now': selWeek = Math.max(1, currentWeek()); render(); break;

    case 'export': {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '课程管理平台备份-' + dateKey(new Date()) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出备份');
      break;
    }
    case 'export-ics': downloadICS(); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'notify-perm': {
      if (!('Notification' in window)) { toast('当前浏览器不支持弹窗通知', true); break; }
      Notification.requestPermission().then((p) => { toast(p === 'granted' ? '弹窗提醒已开启' : '弹窗权限未授权：' + p); });
      break;
    }
    case 'toggle-bg': {
      const wasOn = bgEnabled();
      try { localStorage.setItem('coursehub-bg', wasOn ? 'off' : 'on'); } catch (e) { /* 忽略 */ }
      applyBg();
      render();
      toast(wasOn ? '背景动画已关闭' : '背景动画已开启');
      break;
    }
    case 'import': $('#importFile').click(); break;
    case 'reset-courses':
      confirmModal('重置课程数据', '将恢复 16 门初始课程，你添加的课程提醒会丢失，作业与加分记录保留。确定继续？', async () => {
        const keepA = state.assignments, keepS = state.scores;
        let fresh = null;
        if (mode === 'server') {
          try {
            const res = await fetch('/api/reset', { method: 'POST' });
            const j = await res.json();
            if (j && j.ok) fresh = j.state;
          } catch (e) { /* 落到下面的本地重建 */ }
        }
        if (!fresh) fresh = buildFromClientSeed();
        if (!fresh) { toast('重置失败：找不到初始课程数据', true); return; }
        state = fresh;
        state.assignments = keepA;
        state.scores = keepS;
        save(true); render();
        if (mode === 'browser') showModeBanner();
        toast('课程已重置');
      });
      break;
  }
}

function bind() {

  /* 深浅色切换 */
  $('#themeBtn').addEventListener('click', toggleTheme);

  /* 顶部身份切换 */
  $('#personSwitch').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ps-btn');
    if (!btn) return;
    activePerson = btn.dataset.person;
    $$('#personSwitch .ps-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    FILTERS.score.person = activePerson;
    FILTERS.hw.person = activePerson;
    render();
  });

  /* 标签页（顶部 + 移动端底部共用） */
  $('#tabbar').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    switchView(btn.dataset.view);
  });

  /* 移动端底部 Tab（旧缓存页面无此元素时静默跳过） */
  const bottomTab = $('#bottomTab');
  if (bottomTab) bottomTab.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.bt');
    if (!btn) return;
    if (btn.dataset.view === 'more') {
      const sheet = $('#moreSheet');
      if (sheet) sheet.hidden = false;
      return;
    }
    switchView(btn.dataset.view);
  });
  const moreSheet = $('#moreSheet');
  if (moreSheet) moreSheet.addEventListener('click', (ev) => {
    const item = ev.target.closest('.ms-item');
    if (item) {
      moreSheet.hidden = true;
      switchView(item.dataset.view);
    } else if (ev.target.dataset.close) {
      moreSheet.hidden = true;
    }
  });

  /* 主区域：动作委托 */
  $('#main').addEventListener('click', (ev) => {
    if (ev.target.closest('.tstate')) return;
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    onAction(el.dataset.act, el, ev);
  });

  /* 完成状态按钮单独处理（避免与行点击冲突） */
  $('#main').addEventListener('click', (ev) => {
    const el = ev.target.closest('.tstate');
    if (!el) return;
    onAction('toggle-done', el, ev);
  });

  /* 筛选器 */
  $('#main').addEventListener('change', (ev) => {
    const el = ev.target;
    const f = el.dataset.filter;
    if (!f) return;
    if (f === 'hw-course') FILTERS.hw.courseId = el.value;
    else if (f === 'hw-person') FILTERS.hw.person = el.value;
    else if (f === 'hw-status') FILTERS.hw.status = el.value;
    else if (f === 'course-type') FILTERS.course.type = el.value;
    else if (f === 'sc-person') FILTERS.score.person = el.value;
    else if (f === 'sc-cat') FILTERS.score.category = el.value;
    else if (f === 'sc-month') FILTERS.score.month = el.value;
    render();
    return;
  });

  /* 设置项：失焦时规范化并刷新（避免输入过程中重渲染丢焦点） */
  $('#main').addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el.dataset.set) return;
    let v = el.value;
    if (el.dataset.set === 'totalWeeks') v = Math.max(1, Math.min(30, parseInt(v, 10) || 18));
    state.meta[el.dataset.set] = v;
    save();
    selWeek = Math.max(1, currentWeek());
    render();
  });

  $('#main').addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.filter === 'course-kw') {
      FILTERS.course.keyword = el.value;
      const pos = el.selectionStart;
      render();
      const again = $('#main [data-filter="course-kw"]');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }
    if (el.dataset.set) {
      let v = el.value;
      if (el.dataset.set === 'totalWeeks') v = Math.max(1, Math.min(30, parseInt(v, 10) || 18));
      state.meta[el.dataset.set] = v;
      save();
      selWeek = Math.max(1, currentWeek());
      updateHeader();
    }
    if (el.dataset.personName) {
      const p = personById(el.dataset.personName);
      p.name = el.value;
      if (p.short && p.short !== '我' && p.short !== '雨') p.short = el.value.slice(0, 1);
      save();
      $$('#personSwitch .ps-btn').forEach((b) => {
        if (b.dataset.person === p.id) b.textContent = p.name;
      });
    }
  });

  /* 弹窗 */
  $('#modalRoot').addEventListener('click', (ev) => {
    if (ev.target.dataset.close) { closeModal(); return; }
    const footBtn = ev.target.closest('[data-mbtn]');
    if (footBtn && footBtn.dataset.mbtn === 'close') closeModal();
    if (footBtn && footBtn.dataset.mbtn === 'cancel') closeModal();
    const inner = ev.target.closest('[data-act]');
    if (inner) onAction(inner.dataset.act, inner, ev);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#modalRoot').hidden) closeModal();
  });

  /* 导入 */
  $('#main').addEventListener('change', (ev) => {
    if (ev.target.id !== 'importFile') return;
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        if (!obj || !Array.isArray(obj.courses)) throw new Error('文件格式不正确');
        state = obj;
        if (!state.slots) state.slots = [];
        if (!state.scoreCategories) state.scoreCategories = [];
        save(true);
        render();
        toast('数据已导入');
      } catch (e) {
        toast('导入失败：' + e.message, true);
      }
    };
    reader.readAsText(file, 'utf-8');
    ev.target.value = '';
  });

  /* 每分钟刷新一次「下一节课」与逾期状态 */
  setInterval(() => {
    if (activeView === 'dash') render();
  }, 60000);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  let loaded = false;

  /* 1) 自托管后端（本机 Node / EdgeOne 边缘函数） */
  try {
    const res = await fetch('/api/state');
    const j = await res.json();
    if (j && j.ok && j.state && Array.isArray(j.state.courses)) {
      state = j.state;
      mode = 'server';
      loaded = true;
    }
  } catch (e) { /* 没有后端接口，继续尝试云端 */ }

  /* 2) Supabase 云数据库（两人共用同一份数据） */
  if (!loaded) {
    try {
      const res = await supaLoad();
      if (!res.empty && res.data && Array.isArray(res.data.courses)) {
        state = res.data;
        mode = 'remote';
        loaded = true;
        writeLastCloudCounts(state); // 记录云端数据基线，供空数据保护阀比对
      } else if (res.empty) {
        /* 云端还没有数据：用本地缓存或初始课程先占位，并立即推上去 */
        mode = 'remote';
        state = loadFromBrowser() || buildFromClientSeed();
        if (state) {
          await supaSave(state);
          loaded = true;
          setTimeout(() => toast('云端已初始化课程数据，两人现在共用这一份'), 800);
        }
      }
    } catch (e) { /* Supabase 不可达，降级浏览器模式 */ }
  }

  /* 3) 纯浏览器模式 */
  if (!loaded) {
    mode = 'browser';
    state = loadFromBrowser() || buildFromClientSeed();
    if (!state) throw new Error('无法加载课程数据');
  }

  /* 所有模式都写一份本地缓存，断网/换后端时有兜底 */
  saveToBrowser();

  if (!state.slots || !state.slots.length) {
    state.slots = [
      { id: 'am12', label: '上午 1-2', time: '08:10 - 09:45', start: '08:10', end: '09:45' },
      { id: 'am34', label: '上午 3-4', time: '10:10 - 11:45', start: '10:10', end: '11:45' },
      { id: 'noon12', label: '中午 1-2', time: '12:35 - 14:10', start: '12:35', end: '14:10' },
      { id: 'pm12', label: '下午 1-2', time: '14:10 - 15:45', start: '14:10', end: '15:45' },
      { id: 'pm34', label: '下午 3-4', time: '16:10 - 17:45', start: '16:10', end: '17:45' },
      { id: 'eve12', label: '晚上 1-2', time: '19:10 - 20:45', start: '19:10', end: '20:45' },
      { id: 'eve13', label: '晚上 1-3', time: '19:10 - 21:35', start: '19:10', end: '21:35' }
    ];
  }
  selWeek = Math.max(1, currentWeek());
  bind();
  render();
  setSaveState('idle'); // 启动后立刻显示真实保存模式，避免默认文案误导
  if (mode === 'browser') showModeBanner();
  applyTheme();
  checkAlarms();
  setInterval(checkAlarms, 60000);
  setTimeout(applyBg, 50); // 等 bg.js 模块加载完
}

function showModeBanner() {
  const el = document.createElement('div');
  el.className = 'mode-banner';
  el.innerHTML = '<span class="badge warn">线上版</span>'
    + '<span>数据保存在<b>当前浏览器</b>里，换设备或换浏览器看不到。'
    + '要同步给另一人，请在「设置 → 数据」导出 JSON 发给对方导入。'
    + '本机完整版（data/state.json 双人共用）：运行 <b>启动.bat</b>。</span>'
    + '<button class="icon-btn" id="bannerClose" aria-label="关闭">✕</button>';
  const main = $('#main');
  main.insertBefore(el, main.firstChild);
  $('#bannerClose').onclick = () => el.remove();
}

boot().catch((e) => {
  $('#main').innerHTML = '<div class="empty"><div class="em-title">加载失败</div><div>' + esc(e.message) + '</div></div>';
});
