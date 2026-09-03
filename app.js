'use strict';

/* =========================================================
 * 课程管理平台 · 我和下雨天
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

function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

function fmtDateShort(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }

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
    || (s === 'idle' ? (mode === 'server' ? '已保存' : '已存本机')
      : s === 'saving' ? '保存中…' : '保存失败');
}

function save(immediate) {
  clearTimeout(saveTimer);

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

function todaySessions() {
  const week = Math.max(1, currentWeek());
  const today = dayIndexMon1(new Date());
  const out = [];
  state.courses.forEach((c) => {
    c.sessions.forEach((s) => {
      if (s.day !== today) return;
      if (currentWeek() > 0 && !parseWeeks(s.weeks)[week]) return;
      const slot = slotById(s.slot);
      if (slot) out.push({ course: c, s: s, slot: slot });
    });
  });
  out.sort((a, b) => toMinutes(a.slot.start) - toMinutes(b.slot.start));
  return out;
}

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

function renderDash() {
  const cw = currentWeek();
  const week = Math.max(1, cw);
  const today = todaySessions();
  const next = nextClassInfo();
  const ongoing = currentSession();

  const hwAll = state.assignments.slice().sort((a, b) => hwSortKey(a) - hwSortKey(b));
  const people = activePerson === 'both' ? state.people : [personById(activePerson)];

  let dueSoon = 0, overdue = 0;
  const now = new Date();
  hwAll.forEach((a) => {
    people.forEach((p) => {
      const st = hwStatus(a, p.id);
      if (st.done || !a.due) return;
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
  html += renderMasthead();
  html += '<div class="section grid-stats">';
  html += statCard('今日课程', today.length, cw > 0 ? '第 ' + week + ' 周 · ' + DAY_NAMES[dayIndexMon1(new Date())] : '尚未开学', '');
  html += statCard('待完成作业', overdue + dueSoon, overdue + ' 项已逾期 · ' + dueSoon + ' 项 3 天内', overdue > 0 ? 'is-danger' : dueSoon > 0 ? 'is-warn' : '');
  const totalHw = hwAll.length * people.length;
  const doneHw = hwAll.reduce((n, a) => n + people.filter((p) => hwStatus(a, p.id).done).length, 0);
  html += statCard('作业完成度', (totalHw ? Math.round(doneHw / totalHw * 100) : 0) + '%', doneHw + ' / ' + totalHw + ' 项已完成', '');
  scoreTotals.forEach((st) => {
    html += statCard(st.p.name + ' 累计加分', st.total.toFixed(1), state.scores.filter((s) => s.personId === st.p.id).length + ' 条记录', '');
  });
  html += '</div>';

  html += '<div class="split">';

  /* 左：今日课程时间轴 */
  html += '<div class="section"><div class="card"><div class="pad" style="padding-bottom:6px">'
    + '<div class="section-head" style="margin-bottom:4px"><h2>今日课程</h2>'
    + '<span class="sub">' + fmtDateShort(new Date()) + ' · ' + DAY_NAMES[dayIndexMon1(new Date())] + '</span></div></div>';
  if (ongoing || next) {
    html += '<div class="pad" style="padding-top:0;padding-bottom:12px">';
    if (ongoing) {
      const left = toMinutes(ongoing.slot.end) - nowMinutes();
      const span = toMinutes(ongoing.slot.end) - toMinutes(ongoing.slot.start);
      const prog = Math.round(((span - left) / span) * 100);
      html += '<div class="mini-item" style="border-color:#d9cfb8;background:#faf6ec;margin-bottom:8px">'
        + '<span class="avatar" style="background:var(--brass)">●</span>'
        + '<div class="mi-main"><div style="font-weight:600">' + esc(ongoing.course.shortName || ongoing.course.name) + '</div>'
        + '<div class="mh-progress" style="margin:6px 0 4px"><div class="mh-bar" style="width:' + prog + '%"></div></div>'
        + '<div class="mi-sub">' + esc(ongoing.slot.start) + ' - ' + esc(ongoing.slot.end)
        + ' · 距下课还有 ' + left + ' 分钟 · ' + esc(ongoing.s.room || '教室待定') + '</div></div></div>';
    }
    if (next) {
      const left = toMinutes(next.slot.start) - nowMinutes();
      html += '<div class="mini-item" style="border-color:#c9d3df;background:#f1f4f8">'
        + '<span class="avatar ' + (activePerson === 'rain' ? 'rain' : 'me') + '" style="background:var(--accent)">→</span>'
        + '<div class="mi-main"><div style="font-weight:600">下一节：' + esc(next.course.shortName || next.course.name) + '</div>'
        + '<div class="mi-sub">' + esc(next.slot.start) + ' 上课 · '
        + (left >= 60 ? Math.floor(left / 60) + ' 小时 ' + (left % 60) + ' 分钟后' : left + ' 分钟后')
        + ' · ' + esc(next.s.room || '待定') + '</div></div></div>';
    }
    html += '</div>';
  }
  if (!today.length) {
    html += '<div class="empty"><div class="em-title">今天没有课</div><div>好好休息，或者整理一下作业清单</div></div>';
  } else {
    html += '<div class="list">';
    const mins = nowMinutes();
    today.forEach((t) => {
      const slot = t.slot;
      const started = mins >= toMinutes(slot.start);
      const ended = mins >= toMinutes(slot.end);
      html += '<div class="row' + (ended ? ' is-done' : '') + '" data-act="open-course" data-id="' + t.course.id + '" style="cursor:pointer">'
        + '<span class="avatar" style="background:' + (t.course.color ? t.course.color.tx : '#888') + '">'
        + esc((t.course.shortName || t.course.name).slice(0, 1)) + '</span>'
        + '<div class="row-main"><div class="row-title">' + esc(t.course.name) + '</div>'
        + '<div class="row-meta"><span>' + esc(slot.time) + '</span>'
        + '<span>' + esc(t.s.room || '教室待定') + '</span>'
        + (t.course.teacher ? '<span>' + esc(t.course.teacher) + '</span>' : '')
        + (ended ? '<span class="badge">已结束</span>' : started ? '<span class="badge ok">进行中</span>' : '')
        + '</div></div></div>';
    });
    html += '</div>';
  }
  html += '</div></div>';

  /* 右：待办提醒 */
  html += '<div class="section"><div class="card"><div class="pad" style="padding-bottom:6px">'
    + '<div class="section-head" style="margin-bottom:4px"><h2>待办提醒</h2>'
    + '<span class="sub">按截止紧急度分组</span>'
    + '<span class="spacer"></span><button class="btn sm primary" data-act="add-hw">+ 新作业</button></div></div>';

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
  html += '<div class="card pad mt14"><div class="section-head" style="margin-bottom:4px"><h2>常用链接</h2>'
    + '<span class="sub">校外访问部分入口需登录学校 VPN</span></div>';
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
  html += '</div>';

  html += '</div></div>';

  return html;
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
      html += '<td><div class="ttcell">';
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

function renderTodoList() {
  const list = (state.todos || []).slice().sort((a, b) => hwSortKey(a) - hwSortKey(b));
  if (!list.length) {
    return '<div class="empty" style="padding:26px 16px"><div class="em-title">还没有其他待办</div>'
      + '<div>交材料、办手续、买东西这类不挂课程的事，都可以记在这里</div></div>';
  }
  let html = '<div class="list">';
  list.forEach((t) => {
    const di = t.due ? dueInfo(t) : null;
    html += '<div class="row">'
      + '<div class="row-main">'
      + '<div class="row-title">' + esc(t.title) + '</div>'
      + '<div class="row-meta">'
      + (di ? (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span class="muted tiny">' + esc(di.text) + '</span>') : '<span class="muted tiny">无截止</span>')
      + (t.note ? '<span class="muted tiny">' + esc(t.note) + '</span>' : '')
      + '</div></div>'
      + '<div class="two-state">' + todoOwners(t).map((p) => doneChip(t, p)).join('') + '</div>'
      + '<div class="row-actions">'
      + '<button class="icon-btn" data-act="edit-todo" data-id="' + t.id + '" title="编辑">✎</button>'
      + '<button class="icon-btn" data-act="del-todo" data-id="' + t.id + '" title="删除">🗑</button>'
      + '</div></div>';
  });
  html += '</div>';
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

/* ---------------- 视图：课程 ---------------- */

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

/* ---------------- 视图：作业 ---------------- */

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

  html += '<div class="card">';
  if (!list.length) {
    html += '<div class="empty"><div class="em-title">没有符合条件的作业</div><div>点击右上角「新作业」添加一条</div></div>';
  } else {
    html += '<div class="list">';
    list.forEach((a) => {
      const c = courseById(a.courseId);
      const di = dueInfo(a);
      html += '<div class="row">'
        + '<div class="row-main">'
        + '<div class="row-title">' + esc(a.title) + '</div>'
        + '<div class="row-meta">'
        + '<span class="badge">' + esc(c ? (c.shortName || c.name) : '未指定课程') + '</span>'
        + (di.cls ? '<span class="badge ' + di.cls + '">' + esc(di.text) + '</span>' : '<span class="muted tiny">' + esc(di.text) + '</span>')
        + (a.note ? '<span class="muted tiny">' + esc(a.note) + '</span>' : '')
        + '</div>'
        + showPeople.map((p) => {
          const st = hwStatus(a, p.id);
          if (!st.done || !st.note) return '';
          return '<div class="row-note"><span class="avatar ' + p.id + '" style="width:18px;height:18px;font-size:10px">' + esc(p.short || p.name) + '</span> ' + esc(st.note) + '</div>';
        }).join('')
        + '</div>'
        + '<div class="two-state">' + showPeople.map((p) => doneChip(a, p)).join('') + '</div>'
        + '<div class="row-actions">'
        + '<button class="icon-btn" data-act="edit-hw" data-id="' + a.id + '" title="编辑">✎</button>'
        + '<button class="icon-btn" data-act="del-hw" data-id="' + a.id + '" title="删除">🗑</button>'
        + '</div></div>';
    });
    html += '</div>';
  }
  html += '</div>';

  html += '<div class="card mt14"><div class="group-title" style="font-size:13px">其他待办'
    + '<span class="count">' + ((state.todos || []).filter(todoUndone)).length + ' 项未完成</span>'
    + '<span style="margin-left:auto"><button class="btn sm" data-act="add-todo">+ 新待办</button></span></div>'
    + renderTodoList() + '</div>';

  html += '<p class="muted tiny mt8">作业条目两人共用，各自独立勾选完成状态。任何修改都会自动保存。</p>';
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

function renderScore() {
  const f = FILTERS.score;
  const showPeople = f.person === 'both' ? state.people : [personById(f.person)];

  const months = {};
  state.scores.forEach((s) => { months[s.month || (s.date || '').slice(0, 7)] = true; });
  const monthList = Object.keys(months).filter(Boolean).sort().reverse();

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
    + state.people.map((p) => '<div class="field"><label>' + (p.id === 'me' ? '第一位（我）' : '第二位（下雨天）') + '</label>'
      + '<input class="input" data-person-name="' + p.id + '" value="' + esc(p.name) + '"></div>').join('')
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>外观</h2><span class="sub">按浏览器记忆，不随数据同步</span></div>'
    + '<div class="mini-list">'
    + '<div class="mini-item"><div class="mi-main"><div>背景数学动画</div>'
    + '<div class="mi-sub">Three.js 流动正弦曲面 + 环面纽结 + 漂浮公式，低饱和浅色不干扰阅读</div></div>'
    + '<button class="btn sm" data-act="toggle-bg">' + (bgEnabled() ? '关闭' : '开启') + '</button></div>'
    + '</div></div>';

  html += '<div class="card pad mt14"><div class="section-head"><h2>数据</h2><span class="sub">'
    + (mode === 'server' ? '保存在本机 course-hub/data/state.json' : '线上版：保存在当前浏览器 localStorage')
    + '</span></div>'
    + '<div class="mini-list">'
    + '<div class="mini-item"><div class="mi-main"><div>导出课表到日历</div><div class="mi-sub">生成 .ics 文件，可导入手机日历 / Google 日历 / Outlook，自动带上课提醒</div></div>'
    + '<button class="btn sm" data-act="export-ics">导出日历</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>导出数据</div><div class="mi-sub">下载 JSON 备份，包含课程、作业与加分记录</div></div>'
    + '<button class="btn sm" data-act="export">导出</button></div>'
    + '<div class="mini-item"><div class="mi-main"><div>导入数据</div><div class="mi-sub">从 JSON 备份恢复，会覆盖当前全部数据</div></div>'
    + '<button class="btn sm" data-act="import">选择文件</button>'
    + '<input type="file" id="importFile" accept="application/json,.json" hidden></div>'
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
  const c = courseById(courseId);
  if (!c) return;
  if (!c.exams) c.exams = [];
  const x = examId ? c.exams.filter((e) => e.id === examId)[0] : null;
  const defDate = x ? x.date : (function () {
    const d = new Date(Date.now() + 7 * 86400000);
    d.setHours(10, 0, 0, 0);
    return dateKey(d) + 'T' + pad2(d.getHours()) + ':00';
  })();

  const body = '<div class="form-grid">'
    + '<div class="field span2"><label>名称</label><input class="input" id="exTitle" placeholder="例如：期中考试 / 阶段测试一 / 期末考试" value="' + esc(x ? x.title : '') + '"></div>'
    + '<div class="field"><label>日期时间</label><input type="datetime-local" class="input" id="exDate" value="' + esc(defDate) + '"></div>'
    + '<div class="field"><label>地点（选填）</label><input class="input" id="exLoc" placeholder="例如：07208" value="' + esc(x ? x.location : '') + '"></div>'
    + '<div class="field span2"><label>备注（选填）</label><textarea class="textarea" id="exNote" placeholder="考试范围、题型等">' + esc(x ? x.note : '') + '</textarea></div>'
    + '</div>';

  openModal((x ? '编辑考试' : '添加考试') + ' · ' + c.name, body, [
    { label: '取消', key: 'cancel' },
    { label: '保存', key: 'save', primary: true }
  ]);

  $('#modalFoot [data-mbtn="save"]').onclick = () => {
    const title = $('#exTitle').value.trim();
    if (!title) { toast('请填写考试名称', true); return; }
    const item = {
      id: x ? x.id : uid('e'),
      title: title,
      date: $('#exDate').value,
      location: $('#exLoc').value.trim(),
      note: $('#exNote').value.trim()
    };
    if (x) c.exams[c.exams.indexOf(x)] = item;
    else c.exams.push(item);
    save();
    toast(x ? '考试已更新' : '考试已登记');
    closeModalThen(() => { render(); openCourseDetail(courseId); });
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
    item.due = $('#hwDue').value;
    item.note = $('#hwNote').value.trim();
    if (!isNew) {
      $$('[data-pnote]').forEach((el) => { hwStatus(item, el.dataset.pnote).note = el.value.trim(); });
    } else {
      state.people.forEach((p) => hwStatus(item, p.id));
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
    + '<div class="field"><label>成员</label><select class="select" id="scPerson">'
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
    const cur = state.scores.filter((s) => s.personId === $('#scPerson').value && s.categoryId === catId)
      .reduce((n, s) => n + (Number(s.score) || 0), 0);
    if (cap && cur + val > cap) {
      toast('「' + cat.short + '」栏上限 ' + cap + ' 分，当前 ' + cur.toFixed(1) + '，最多还可加 ' + (cap - cur).toFixed(1) + ' 分', true);
      return;
    }
    state.scores.push({
      id: uid('s'),
      personId: $('#scPerson').value,
      categoryId: catId,
      item: item,
      score: val,
      date: date,
      month: date.slice(0, 7),
      note: $('#scNote').value.trim(),
      createdAt: new Date().toISOString()
    });
    save();
    toast(cap && cur + val >= cap ? '已录入，该栏已加满 ' + cap + ' 分' : '加分已录入');
    closeModalThen(render);
  };
}

function closeModalThen(fn) {
  closeModal();
  fn();
}

/* ---------------- 渲染调度 ---------------- */

function render() {
  const main = $('#main');
  if (activeView === 'dash') main.innerHTML = renderDash();
  else if (activeView === 'timetable') main.innerHTML = renderTimetable();
  else if (activeView === 'courses') main.innerHTML = renderCourses();
  else if (activeView === 'homework') main.innerHTML = renderHomework();
  else if (activeView === 'score') main.innerHTML = renderScore();
  else if (activeView === 'settings') main.innerHTML = renderSettings();

  updateHeader();
}

function updateHeader() {
  const cw = currentWeek();
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
  const tab = $('#tabbar [data-view="homework"]');
  if (!tab) return;
  const now = new Date();
  let n = 0;
  state.assignments.forEach((a) => {
    state.people.forEach((p) => {
      const st = hwStatus(a, p.id);
      if (st.done || !a.due) return;
      if (new Date(a.due) < now || Math.floor((startOfDay(new Date(a.due)) - startOfDay(now)) / 86400000) === 0) n++;
    });
  });
  (state.todos || []).forEach((t) => {
    todoOwners(t).forEach((p) => {
      const st = hwStatus(t, p.id);
      if (st.done || !t.due) return;
      if (new Date(t.due) < now || Math.floor((startOfDay(new Date(t.due)) - startOfDay(now)) / 86400000) === 0) n++;
    });
  });
  state.courses.forEach((c) => {
    (c.exams || []).forEach((x) => {
      if (!x.date) return;
      const days = Math.ceil((startOfDay(new Date(x.date)) - startOfDay(now)) / 86400000);
      if (days >= 0 && days <= 3) n++;
    });
  });
  tab.textContent = '作业';
  if (n > 0) {
    tab.insertAdjacentHTML('beforeend', '<span class="tab-badge">' + n + '</span>');
  }
}

/* ---------------- 事件绑定 ---------------- */

function onAction(act, el, ev) {
  const id = el.dataset.id;
  const pid = el.dataset.person;

  switch (act) {
    case 'open-course': openCourseDetail(id); break;

    case 'toggle-done': {
      const a = state.assignments.filter((x) => x.id === id)[0];
      if (!a) break;
      const st = hwStatus(a, pid);
      st.done = !st.done;
      st.doneAt = st.done ? new Date().toISOString() : null;
      save();
      render();
      if (openDetailId) openCourseDetail(openDetailId);
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

  /* 标签页 */
  $('#tabbar').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    activeView = btn.dataset.view;
    $$('#tabbar .tab').forEach((b) => b.classList.toggle('is-active', b === btn));
    render();
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
  try {
    const res = await fetch('/api/state');
    const j = await res.json();
    if (j && j.ok && j.state && Array.isArray(j.state.courses)) {
      state = j.state;
      mode = 'server';
      loaded = true;
    }
  } catch (e) { /* 静态托管下没有后端接口，走浏览器模式 */ }

  if (!loaded) {
    mode = 'browser';
    state = loadFromBrowser() || buildFromClientSeed();
    if (!state) throw new Error('无法加载课程数据');
  }

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
  if (mode === 'browser') showModeBanner();
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
