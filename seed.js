(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CourseHubSeed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// 课表来源：四川师范大学班级课表 PDF（打印日期 2026/9/1，26-27 学年第一学期）
// 班级：数科 2025 级 03 班（数学与应用数学），总学分 40.25
// 额外加入两门线上课程：中国法律史、软件测试与质量保证
// 量化加分字段来源：25级3班量化月表表头（每栏 = 明细项 + 分数，共 6 栏）

const SLOTS = [
  { id: 'am12',   label: '上午 1-2', time: '08:10 - 09:45', start: '08:10', end: '09:45' },
  { id: 'am34',   label: '上午 3-4', time: '10:10 - 11:45', start: '10:10', end: '11:45' },
  { id: 'noon12', label: '中午 1-2', time: '12:35 - 14:10', start: '12:35', end: '14:10' },
  { id: 'pm12',   label: '下午 1-2', time: '14:10 - 15:45', start: '14:10', end: '15:45' },
  { id: 'pm34',   label: '下午 3-4', time: '16:10 - 17:45', start: '16:10', end: '17:45' },
  { id: 'eve12',  label: '晚上 1-2', time: '19:10 - 20:45', start: '19:10', end: '20:45' },
  { id: 'eve13',  label: '晚上 1-3', time: '19:10 - 21:35', start: '19:10', end: '21:35' }
];

const SCORE_CATEGORIES = [
  { id: 'sxdd', name: '思想道德表现与现实表现', short: '思想道德', cap: 5 },
  { id: 'xskj', name: '学术科技与创新创业',     short: '学术科技', cap: 4 },
  { id: 'wtys', name: '文体艺术与身心发展',     short: '文体艺术', cap: 4 },
  { id: 'shsj', name: '社会实践与志愿服务',     short: '社会实践', cap: 4 },
  { id: 'sthd', name: '社团活动与社会工作',     short: '社团活动', cap: 5 },
  { id: 'zyjn', name: '职业技能培训与其他',     short: '职业技能', cap: 3 }
];

const RAW_COURSES = [
  {
    name: '大学英语（普通类）3', teacher: '何煦', type: '线下', campus: '狮子山',
    sessions: [
      { day: 1, slot: 'am12', weeks: '1~3(单),4~9,11~16', room: '03301' },
      { day: 1, slot: 'am12', weeks: '2,10', room: '综合实验楼102' }
    ]
  },
  {
    name: '常微分方程', teacher: '罗宏', type: '线下', campus: '狮子山',
    sessions: [
      { day: 2, slot: 'am12', weeks: '1~17', room: '07208' },
      { day: 3, slot: 'am34', weeks: '1~17(单)', room: '02101' }
    ]
  },
  {
    name: '数学分析3', teacher: '李凤莲', type: '线下', campus: '狮子山',
    sessions: [
      { day: 2, slot: 'am34', weeks: '1~17', room: '06507' },
      { day: 4, slot: 'am12', weeks: '1~17', room: '07410' },
      { day: 5, slot: 'am34', weeks: '1~17', room: '07208' }
    ]
  },
  {
    name: '大学物理实验（二）', teacher: '逯来玉 / 杨丽君 / 张原维 / 董云明 / 张田 / 黄龙',
    type: '实验', campus: '成龙',
    note: '分 #1~#6 组上课，各组教室不同：#1 北219 中学物理教学法实验（张原维）、#2 北209 力学热学实验（黄龙）、#3 北206 光学实验（逯来玉）、#4 北213 光学实验（杨丽君）、#5 北514 电磁学实验（董云明）、#6 北513 电磁学实验（张田）。中午 1-2 与下午 1-2 连堂。',
    sessions: [
      { day: 1, slot: 'noon12', weeks: '11~16', room: '第一实验楼北 206/213/219/514/513/209' },
      { day: 1, slot: 'pm12',   weeks: '11~16', room: '第一实验楼北 206/213/219/514/513/209' }
    ]
  },
  {
    name: '毛泽东思想和中国特色社会主义理论体系概论', shortName: '毛概',
    teacher: '何静', type: '线下', campus: '狮子山',
    sessions: [
      { day: 1, slot: 'pm34',  weeks: '1~8', room: '07102' },
      { day: 2, slot: 'eve13', weeks: '1~8', room: '07303' }
    ]
  },
  {
    name: '习近平新时代中国特色社会主义思想概论', shortName: '习思想概论',
    teacher: '拓丹丹', type: '线下', campus: '狮子山',
    sessions: [
      { day: 2, slot: 'eve13', weeks: '9~16', room: '07303' },
      { day: 5, slot: 'pm12',  weeks: '9~16', room: '07303' }
    ]
  },
  {
    name: '运筹学', teacher: '徐玲', type: '线下', campus: '狮子山',
    sessions: [
      { day: 1, slot: 'eve12', weeks: '1~17(单)', room: '07208' },
      { day: 3, slot: 'pm12',  weeks: '1~14', room: '07208' },
      { day: 3, slot: 'pm12',  weeks: '15~17', room: '04202（数学与应用数学实验）' }
    ]
  },
  {
    name: '程序设计基础（C）', teacher: '张莉', type: '线下', campus: '狮子山',
    sessions: [
      { day: 2, slot: 'pm12', weeks: '1~17', room: '03404' },
      { day: 4, slot: 'pm34', weeks: '7~17', room: '04201 数学与软件科学学院实验室' },
      { day: 4, slot: 'pm34', weeks: '1~6',  room: '03203' }
    ]
  },
  {
    name: '大学体育3', teacher: '体育教研部', type: '体育', campus: '狮子山',
    sessions: [
      { day: 2, slot: 'pm34', weeks: '1~16', room: '狮子山操场' }
    ]
  },
  {
    name: '习近平总书记关于教育的重要论述', shortName: '习教育重要论述',
    teacher: '段晓霞', type: '线下', campus: '狮子山',
    sessions: [
      { day: 3, slot: 'am34', weeks: '2~18(双)', room: '07303' }
    ]
  },
  {
    name: '教育学基础', teacher: '张霞', type: '线下', campus: '狮子山',
    sessions: [
      { day: 4, slot: 'am34', weeks: '1~17', room: '07202' }
    ]
  },
  {
    name: '形势与政策3', teacher: '柏敏', type: '线下', campus: '狮子山',
    sessions: [
      { day: 3, slot: 'eve12', weeks: '14~15', room: '07303' },
      { day: 4, slot: 'pm12',  weeks: '14~15', room: '07202' }
    ]
  },
  {
    name: '教育心理学', teacher: '廖宗卿', type: '线下', campus: '狮子山',
    sessions: [
      { day: 5, slot: 'am12', weeks: '1~18', room: '07114' }
    ]
  },
  {
    name: '占位课程', shortName: '占位课程（尔雅）', teacher: '尔雅平台',
    type: '线上', campus: '线上',
    note: '课表标注为「占位课程 · 尔雅」，通常对应尔雅通识线上课，具体课程以教务通知为准。',
    sessions: [
      { day: 1, slot: 'pm34', weeks: '11~16', room: '尔雅平台' }
    ]
  },
  {
    name: '中国法律史', teacher: '待定', type: '线上', campus: '线上',
    note: '线上课程，无固定上课时间，请自行设置提醒。',
    sessions: []
  },
  {
    name: '软件测试与质量保证', teacher: '待定', type: '线上', campus: '线上',
    note: '线上课程，无固定上课时间，请自行设置提醒。',
    sessions: []
  }
];

// 课表配色：低饱和学术色系，浅色主题下文字保持深色可读
const PALETTE = [
  { bg: '#eef1f5', bd: '#cfd8e2', tx: '#2c4a6b' },
  { bg: '#edf1ea', bd: '#ccd7c7', tx: '#3d5c46' },
  { bg: '#f5eeea', bd: '#ddc9bf', tx: '#7d4638' },
  { bg: '#f2eff5', bd: '#d4cde0', tx: '#4f4370' },
  { bg: '#f6f2e7', bd: '#ded2b4', tx: '#7a6425' },
  { bg: '#eaf0f0', bd: '#c3d6d6', tx: '#2f5d5b' },
  { bg: '#f1efe9', bd: '#d6d3c8', tx: '#5f5a4c' },
  { bg: '#f6ebe7', bd: '#e0cdc4', tx: '#8a4a33' }
];

function buildSeed() {
  const courses = RAW_COURSES.map((c, i) => ({
    id: 'c' + (i + 1),
    name: c.name,
    shortName: c.shortName || '',
    teacher: c.teacher || '',
    type: c.type,
    campus: c.campus || '',
    credit: null,
    note: c.note || '',
    color: PALETTE[i % PALETTE.length],
    remindBefore: 30,
    sessions: c.sessions.map((s) => Object.assign({ note: '' }, s)),
    reminders: []
  }));

  return {
    version: 1,
    meta: {
      termName: '26-27 学年第一学期',
      className: '数科 2025 级 03 班（数学与应用数学）',
      totalCredits: '40.25',
      termStart: '2026-09-07',
      totalWeeks: 18,
      updatedAt: ''
    },
    people: [
      { id: 'me',   name: '豆沙馅', short: '豆', color: '#9c4535' },
      { id: 'rain', name: '下雨天', short: '雨', color: '#3d5a80' }
    ],
    slots: SLOTS,
    scoreCategories: SCORE_CATEGORIES,
    courses: courses,
    assignments: [],
    scores: []
  };
}

return { buildSeed: buildSeed, SLOTS: SLOTS, SCORE_CATEGORIES: SCORE_CATEGORIES, PALETTE: PALETTE };
});
