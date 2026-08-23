// 文案键(中英双语; 语言面由 DSH locale 服务解析)。
export const NS = 'novelcraft'

export type NovelcraftKey =
  | 'pet.silent'
  | 'pet.glow'
  | 'pet.busy'
  | 'pet.attention'
  | 'pet.title'
  | 'atlas.title'
  | 'pet.plot'
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
  | 'inbox.status.resolved'
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
  | 'story.edges'
  | 'story.edge.other'
  | 'story.edge.serves_thread'
  | 'story.edge.belongs_to_arc'
  | 'story.edge.reveals_foreshadowing'
  | 'story.edge.pays_off_in_scene'
  | 'story.edge.references_character'
  | 'story.edge.references_entity'
  | 'story.edge.references_memory'
  | 'story.chapters'
  | 'desk.title'
  | 'desk.empty'
  | 'desk.unbound'
  | 'desk.mode.watch'
  | 'desk.mode.plan'
  | 'desk.mode.review'
  | 'desk.mode.reference'
  | 'desk.mode.import'
  | 'intake.choose'
  | 'intake.hint'
  | 'intake.staging'
  | 'intake.fail'
  | 'intake.tooLarge'
  | 'desk.chapters'
  | 'desk.objects'
  | 'desk.reviews'
  | 'desk.reviews.empty'
  | 'desk.proposals'
  | 'desk.proposals.empty'
  | 'desk.proposals.basis'
  | 'desk.proposals.cost'
  | 'desk.proposals.risk'
  | 'dossier.title'
  | 'dossier.back'
  | 'dossier.unbound'
  | 'dossier.missing'
  | 'dossier.status'
  | 'dossier.words'
  | 'dossier.scenes'
  | 'dossier.scene.goal'
  | 'dossier.scene.conflict'
  | 'dossier.scene.must'
  | 'dossier.scene.mustNot'
  | 'dossier.scene.tag'
  | 'dossier.characters'
  | 'dossier.pov'
  | 'dossier.foreshadowing'
  | 'dossier.foreshadowing.planted'
  | 'dossier.foreshadowing.active'
  | 'dossier.foreshadowing.due'
  | 'dossier.reveals'
  | 'dossier.objects'
  | 'dossier.rhythm'
  | 'dossier.rhythm.words'
  | 'dossier.rhythm.scenes'
  | 'dossier.rhythm.avg'
  | 'dossier.review'
  | 'dossier.signals'
  | 'dossier.proposal'
  | 'dossier.empty'
  | 'preset.title'
  | 'preset.unbound'
  | 'preset.current'
  | 'preset.use'
  | 'preset.default.name'
  | 'preset.default.desc'
  | 'preset.available'
  | 'preset.select.ok'
  | 'preset.select.fail'
  | 'preset.source.seed'
  | 'preset.source.stored'

export const zh: Record<NovelcraftKey, string> = {
  'pet.silent': '静默',
  'pet.glow': '微光',
  'pet.busy': '忙碌',
  'pet.attention': '待确认',
  'pet.title': 'NovelCraft 守望',
  'atlas.title': '地图册',
  'pet.plot': '当前剧情',
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
  'inbox.status.resolved': '已解决',
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
  'story.edges': '关系边',
  'story.edge.other': '其他',
  'story.edge.serves_thread': '服务剧情线',
  'story.edge.belongs_to_arc': '归属篇章',
  'story.edge.reveals_foreshadowing': '回收伏笔',
  'story.edge.pays_off_in_scene': '落地场景',
  'story.edge.references_character': '引用角色',
  'story.edge.references_entity': '引用实体',
  'story.edge.references_memory': '引用记忆',
  'story.chapters': '章节',
  'desk.title': '写作台',
  'desk.empty': '暂无内容。',
  'desk.unbound': '这本书还没绑定工作区。',
  'desk.mode.watch': '守望',
  'desk.mode.plan': '计划',
  'desk.mode.review': '评审',
  'desk.mode.reference': '参照',
  'desk.mode.import': '导入',
  'intake.choose': '选择 .txt / .md 手稿',
  'intake.hint': '文件仅作为当前会话的一次性导入输入。授权后回到对话让助手完成切章与入库。',
  'intake.staging': '正在校验并暂存…',
  'intake.fail': '文件授权失败, 请检查格式后重试。',
  'intake.tooLarge': '文件超过 50MB, 请拆分后重试。',
  'desk.chapters': '章节',
  'desk.objects': '世界对象',
  'desk.reviews': '语义审查',
  'desk.reviews.empty': '还没有语义审查记录。',
  'desk.proposals': '下一步提案',
  'desk.proposals.empty': '还没有续写提案: 在助手侧说「续写下一章」生成。',
  'desk.proposals.basis': '依据',
  'desk.proposals.cost': '成本',
  'desk.proposals.risk': '风险',
  'dossier.title': '章节档案',
  'dossier.back': '返回列表',
  'dossier.unbound': '这本书还没绑定工作区。',
  'dossier.missing': '该章尚未导入, 档案为空。',
  'dossier.status': '状态',
  'dossier.words': '字',
  'dossier.scenes': 'Scene 分解',
  'dossier.scene.goal': '目标',
  'dossier.scene.conflict': '核心冲突',
  'dossier.scene.must': '必发生',
  'dossier.scene.mustNot': '禁发生',
  'dossier.scene.tag': '叙事标签',
  'dossier.characters': '人物在场',
  'dossier.pov': '视角 POV',
  'dossier.foreshadowing': '伏笔对账',
  'dossier.foreshadowing.planted': '种下',
  'dossier.foreshadowing.active': '经过',
  'dossier.foreshadowing.due': '应回收',
  'dossier.reveals': '回收揭示',
  'dossier.objects': '设定引用',
  'dossier.rhythm': '节奏',
  'dossier.rhythm.words': '字数',
  'dossier.rhythm.scenes': 'Scene 数',
  'dossier.rhythm.avg': '均长',
  'dossier.review': '语义审查',
  'dossier.signals': '相关信号',
  'dossier.proposal': '续写提案',
  'dossier.empty': '暂无',
  'preset.title': '模型预设',
  'preset.unbound': '这本书还没绑定工作区。',
  'preset.current': '当前使用',
  'preset.use': '点击应用',
  'preset.default.name': '默认(继承助手配置)',
  'preset.default.desc': '不指定预设, 内容手跟随助手当前模型配置。',
  'preset.available': '可用模型服务',
  'preset.select.ok': '已应用',
  'preset.select.fail': '应用失败, 请稍后再试',
  'preset.source.seed': '内置',
  'preset.source.stored': '自定义',
}

export const en: Record<NovelcraftKey, string> = {
  'pet.silent': 'Silent',
  'pet.glow': 'Glow',
  'pet.busy': 'Busy',
  'pet.attention': 'Needs you',
  'pet.title': 'NovelCraft Watch',
  'atlas.title': 'Map atlas',
  'pet.plot': 'Current plot',
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
  'inbox.status.resolved': 'Resolved',
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
  'story.edges': 'Relation edges',
  'story.edge.other': 'Other',
  'story.edge.serves_thread': 'Serves thread',
  'story.edge.belongs_to_arc': 'Belongs to arc',
  'story.edge.reveals_foreshadowing': 'Reveals foreshadowing',
  'story.edge.pays_off_in_scene': 'Pays off in scene',
  'story.edge.references_character': 'References character',
  'story.edge.references_entity': 'References entity',
  'story.edge.references_memory': 'References memory',
  'story.chapters': 'Chapters',
  'desk.title': 'Writing Desk',
  'desk.empty': 'Nothing here yet.',
  'desk.unbound': 'No vault bound for this book.',
  'desk.mode.watch': 'Watch',
  'desk.mode.plan': 'Plan',
  'desk.mode.review': 'Review',
  'desk.mode.reference': 'Reference',
  'desk.mode.import': 'Import',
  'intake.choose': 'Choose a .txt / .md manuscript',
  'intake.hint': 'The file is a one-time input for this session. After authorization, return to chat and ask the assistant to import it.',
  'intake.staging': 'Validating and staging…',
  'intake.fail': 'File authorization failed. Check the format and try again.',
  'intake.tooLarge': 'The file exceeds 50MB. Split it and try again.',
  'desk.chapters': 'Chapters',
  'desk.objects': 'World objects',
  'desk.reviews': 'Semantic reviews',
  'desk.reviews.empty': 'No semantic reviews yet.',
  'desk.proposals': 'Next-chapter proposals',
  'desk.proposals.empty': 'No proposals yet — ask the assistant to propose the next chapter.',
  'desk.proposals.basis': 'Basis',
  'desk.proposals.cost': 'Cost',
  'desk.proposals.risk': 'Risk',
  'dossier.title': 'Chapter Dossier',
  'dossier.back': 'Back to list',
  'dossier.unbound': 'No vault bound for this book.',
  'dossier.missing': 'This chapter is not imported yet — dossier is empty.',
  'dossier.status': 'Status',
  'dossier.words': 'chars',
  'dossier.scenes': 'Scene Breakdown',
  'dossier.scene.goal': 'Goal',
  'dossier.scene.conflict': 'Core conflict',
  'dossier.scene.must': 'Must happen',
  'dossier.scene.mustNot': 'Must not happen',
  'dossier.scene.tag': 'Narrative tag',
  'dossier.characters': 'Characters present',
  'dossier.pov': 'POV',
  'dossier.foreshadowing': 'Foreshadowing',
  'dossier.foreshadowing.planted': 'Planted',
  'dossier.foreshadowing.active': 'Active through',
  'dossier.foreshadowing.due': 'Due payoff',
  'dossier.reveals': 'Reveals',
  'dossier.objects': 'Referenced objects',
  'dossier.rhythm': 'Rhythm',
  'dossier.rhythm.words': 'Word count',
  'dossier.rhythm.scenes': 'Scenes',
  'dossier.rhythm.avg': 'Avg length',
  'dossier.review': 'Review',
  'dossier.signals': 'Signals',
  'dossier.proposal': 'Next-chapter proposal',
  'dossier.empty': 'None',
  'preset.title': 'Model Presets',
  'preset.unbound': 'No vault bound for this book.',
  'preset.current': 'Current',
  'preset.use': 'Click to apply',
  'preset.default.name': 'Default (inherit assistant config)',
  'preset.default.desc': "No preset — the content hand follows the assistant's current model settings.",
  'preset.available': 'Available providers',
  'preset.select.ok': 'Applied',
  'preset.select.fail': 'Apply failed, please try again later',
  'preset.source.seed': 'Built-in',
  'preset.source.stored': 'Custom',
}
