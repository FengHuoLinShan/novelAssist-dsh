// 文案键(中英双语; 语言面由 DSH locale 服务解析)。
export const NS = 'novelcraft'

export type NovelcraftKey =
  | 'pet.silent'
  | 'pet.glow'
  | 'pet.busy'
  | 'pet.attention'
  | 'pet.title'
  | 'inbox.title'
  | 'inbox.empty'
  | 'inbox.unbound'
  | 'inbox.threshold'
  | 'inbox.refresh'
  | 'inbox.close'
  | 'inbox.verb.accept'
  | 'inbox.verb.reject'
  | 'inbox.verb.modify'
  | 'inbox.verb.defer'
  | 'inbox.reason.placeholder'
  | 'inbox.reason.confirm'
  | 'inbox.status.open'
  | 'inbox.status.accepted'
  | 'inbox.status.rejected'
  | 'inbox.status.deferred'
  | 'inbox.evidence'
  | 'inbox.action'
  | 'inbox.act.fail'
  | 'inbox.done.adopt'
  | 'inbox.done.record'
  | 'story.title'
  | 'story.empty'
  | 'story.unbound'
  | 'story.threads'
  | 'story.arcs'
  | 'story.foreshadowing'
  | 'story.reveals'
  | 'story.scenes'
  | 'story.chapters'
  | 'desk.title'
  | 'desk.empty'
  | 'desk.unbound'
  | 'desk.mode.watch'
  | 'desk.mode.plan'
  | 'desk.mode.review'
  | 'desk.mode.reference'
  | 'desk.chapters'
  | 'desk.objects'
  | 'desk.reviews'
  | 'desk.reviews.empty'

export const zh: Record<NovelcraftKey, string> = {
  'pet.silent': '静默',
  'pet.glow': '微光',
  'pet.busy': '忙碌',
  'pet.attention': '待确认',
  'pet.title': 'NovelCraft 守望',
  'inbox.title': '收件箱',
  'inbox.empty': '没有待处理信号。',
  'inbox.unbound': '这本书还没绑定工作区: 请在助手会话里打开它(每书一会话)。',
  'inbox.threshold': '待确认阈值',
  'inbox.refresh': '刷新',
  'inbox.close': '关闭',
  'inbox.verb.accept': '采纳',
  'inbox.verb.reject': '打回',
  'inbox.verb.modify': '改一改',
  'inbox.verb.defer': '先放着',
  'inbox.reason.placeholder': '一句话理由(校准原料, 必填)',
  'inbox.reason.confirm': '确认',
  'inbox.status.open': '待处理',
  'inbox.status.accepted': '已采纳',
  'inbox.status.rejected': '已打回',
  'inbox.status.deferred': '先放着',
  'inbox.evidence': '证据',
  'inbox.action': '建议动作',
  'inbox.act.fail': '操作失败',
  'inbox.done.adopt': '已记录采纳决定',
  'inbox.done.record': '已记录',
  'story.title': '剧情地图',
  'story.empty': '还没有结构资产: 先跑结构分析或手工建 threads/arcs/伏笔。',
  'story.unbound': '这本书还没绑定工作区。',
  'story.threads': '剧情线',
  'story.arcs': '篇章纲',
  'story.foreshadowing': '伏笔',
  'story.reveals': '回收',
  'story.scenes': '场景',
  'story.chapters': '章节',
  'desk.title': '写作台',
  'desk.empty': '暂无内容。',
  'desk.unbound': '这本书还没绑定工作区。',
  'desk.mode.watch': '守望',
  'desk.mode.plan': '计划',
  'desk.mode.review': '评审',
  'desk.mode.reference': '参照',
  'desk.chapters': '章节',
  'desk.objects': '世界对象',
  'desk.reviews': '语义审查',
  'desk.reviews.empty': '还没有语义审查记录。',
}

export const en: Record<NovelcraftKey, string> = {
  'pet.silent': 'Silent',
  'pet.glow': 'Glow',
  'pet.busy': 'Busy',
  'pet.attention': 'Needs you',
  'pet.title': 'NovelCraft Watch',
  'inbox.title': 'Inbox',
  'inbox.empty': 'No open signals.',
  'inbox.unbound': 'No vault bound for this book — open it in an assistant session (one book, one session).',
  'inbox.threshold': 'Attention threshold',
  'inbox.refresh': 'Refresh',
  'inbox.close': 'Close',
  'inbox.verb.accept': 'Accept',
  'inbox.verb.reject': 'Reject',
  'inbox.verb.modify': 'Tweak',
  'inbox.verb.defer': 'Later',
  'inbox.reason.placeholder': 'One-line reason (feeds calibration, required)',
  'inbox.reason.confirm': 'Confirm',
  'inbox.status.open': 'Open',
  'inbox.status.accepted': 'Accepted',
  'inbox.status.rejected': 'Rejected',
  'inbox.status.deferred': 'Deferred',
  'inbox.evidence': 'Evidence',
  'inbox.action': 'Proposed action',
  'inbox.act.fail': 'Action failed',
  'inbox.done.adopt': 'Accept recorded',
  'inbox.done.record': 'Recorded',
  'story.title': 'Story Map',
  'story.empty': 'No structure assets yet — run structure analysis or create threads/arcs/foreshadowing.',
  'story.unbound': 'No vault bound for this book.',
  'story.threads': 'Threads',
  'story.arcs': 'Arcs',
  'story.foreshadowing': 'Foreshadowing',
  'story.reveals': 'Reveals',
  'story.scenes': 'Scenes',
  'story.chapters': 'Chapters',
  'desk.title': 'Writing Desk',
  'desk.empty': 'Nothing here yet.',
  'desk.unbound': 'No vault bound for this book.',
  'desk.mode.watch': 'Watch',
  'desk.mode.plan': 'Plan',
  'desk.mode.review': 'Review',
  'desk.mode.reference': 'Reference',
  'desk.chapters': 'Chapters',
  'desk.objects': 'World objects',
  'desk.reviews': 'Semantic reviews',
  'desk.reviews.empty': 'No semantic reviews yet.',
}
