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
  | 'workflow.title'
  | 'workflow.unbound'
  | 'workflow.empty'
  | 'workflow.loading'
  | 'workflow.chatBusy'
  | 'workflow.requested'
  | 'workflow.kind.import'
  | 'workflow.kind.atlas'
  | 'workflow.state.running'
  | 'workflow.state.needs-attention'
  | 'workflow.state.completed'
  | 'workflow.state.failed'
  | 'workflow.progress'
  | 'workflow.resume'
  | 'workflow.abandon'
  | 'workflow.restart'
  | 'workflow.restartHint'
  | 'book.title'
  | 'book.current'
  | 'book.unbound'
  | 'book.empty'
  | 'book.open'
  | 'book.create'
  | 'book.name'
  | 'book.chatBusy'
  | 'book.requested'
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
  | 'outline.workbench'
  | 'outline.target'
  | 'outline.target.story'
  | 'outline.target.thread'
  | 'outline.target.arc'
  | 'outline.task'
  | 'outline.sources'
  | 'outline.sources.empty'
  | 'outline.includeDrafts'
  | 'outline.preview'
  | 'outline.previews'
  | 'outline.previews.empty'
  | 'outline.receipt'
  | 'outline.warnings'
  | 'outline.apply'
  | 'outline.chatBusy'
  | 'outline.requested'
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
  | 'preset.effort'
  | 'preset.effort.default'
  | 'preset.effort.adapterDefault'
  | 'preset.select.ok'
  | 'preset.select.fail'
  | 'preset.source.seed'
  | 'preset.source.stored'
  | 'chapter.view'
  | 'chapter.select'
  | 'chapter.unbound'
  | 'chapter.empty'
  | 'chapter.refresh'
  | 'chapter.title'
  | 'chapter.body'
  | 'chapter.status'
  | 'chapter.edit'
  | 'chapter.save'
  | 'chapter.saving'
  | 'chapter.cancel'
  | 'chapter.saveFailed'
  | 'chapter.chatDraftBusy'
  | 'chapter.history'
  | 'chapter.current'
  | 'chapter.bytes'
  | 'chapter.invalidHash'
  | 'chapter.diff'
  | 'chapter.noDiff'
  | 'chapter.truncated'
  | 'chapter.restore'
  | 'chapter.restoreRequested'
  | 'chapter.review'
  | 'chapter.reviewCurrent'
  | 'chapter.reviewCandidate'
  | 'chapter.reviewRequested'
  | 'chapter.noReview'
  | 'chapter.fresh'
  | 'chapter.stale'
  | 'chapter.selectFinding'
  | 'chapter.reviseSelected'
  | 'chapter.reviseRequested'
  | 'chapter.candidate'
  | 'chapter.adoptCandidate'
  | 'chapter.adoptRequested'
  | 'chapter.rejectReason'
  | 'chapter.rejectCandidate'
  | 'chapter.rejectRequested'

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
  'workflow.title': '长任务',
  'workflow.unbound': '当前会话还没有绑定一本书。',
  'workflow.empty': '还没有可恢复的深度导入或地图册任务。',
  'workflow.loading': '刷新中…',
  'workflow.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'workflow.requested': '请求已交给助手；需要副作用的动作仍会请求审批。',
  'workflow.kind.import': '深度导入',
  'workflow.kind.atlas': '地图册',
  'workflow.state.running': '进行中',
  'workflow.state.needs-attention': '需要确认',
  'workflow.state.completed': '已完成',
  'workflow.state.failed': '失败',
  'workflow.progress': '批次进度',
  'workflow.resume': '继续',
  'workflow.abandon': '审批放弃',
  'workflow.restart': '重新开始',
  'workflow.restartHint': '按已记录范围新开一次导入，不复用旧 run。章节：',
  'book.title': '书库',
  'book.current': '当前',
  'book.unbound': '当前会话尚未绑定书。',
  'book.empty': '书库还没有书，可以在下方创建。',
  'book.open': '审批切换',
  'book.create': '创建新书',
  'book.name': '书名（同时作为书库键）',
  'book.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'book.requested': '请求已交给助手；创建或切换仍需审批。',
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
  'outline.workbench': '总纲与 Scene 工作台',
  'outline.target': '生成目标',
  'outline.target.story': '全书总纲',
  'outline.target.thread': '剧情线',
  'outline.target.arc': '篇章纲',
  'outline.task': '说明本次要解决的结构问题或方向…',
  'outline.sources': '明确参考来源',
  'outline.sources.empty': '尚无可选的总纲、结构、Scene 或世界对象。',
  'outline.includeDrafts': '允许本次显式选中的草稿/候选来源',
  'outline.preview': '请助手生成预览',
  'outline.previews': '最近预览',
  'outline.previews.empty': '还没有总纲或结构预览。',
  'outline.receipt': '实际来源',
  'outline.warnings': '警告',
  'outline.apply': '审批采用',
  'outline.chatBusy': '对话输入框已有未发送内容，请先发送或清空。',
  'outline.requested': '请求已交给助手；预览不写正史，采用仍需审批。',
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
  'preset.effort': '思考等级',
  'preset.effort.default': '清除书级覆盖(继承预设/助手配置)',
  'preset.effort.adapterDefault': '接口默认',
  'preset.select.ok': '已应用',
  'preset.select.fail': '应用失败, 请稍后再试',
  'preset.source.seed': '内置',
  'preset.source.stored': '自定义',
  'chapter.view': '章节正文',
  'chapter.select': '选择章节',
  'chapter.unbound': '当前会话尚未绑定小说工作区。',
  'chapter.empty': '没有可编辑的当前章节。',
  'chapter.refresh': '刷新',
  'chapter.title': '章节标题',
  'chapter.body': '章节正文',
  'chapter.status': '状态',
  'chapter.edit': '编辑',
  'chapter.save': '审批保存',
  'chapter.saving': '暂存中…',
  'chapter.cancel': '结束编辑',
  'chapter.saveFailed': '暂存失败, 请刷新后重试。',
  'chapter.chatDraftBusy': '对话里已有未发送草稿；请先发送或清空，避免覆盖。',
  'chapter.history': '版本历史',
  'chapter.current': '当前',
  'chapter.bytes': '字节',
  'chapter.invalidHash': '旧版本使用历史哈希口径；恢复时会自动修正。',
  'chapter.diff': '对比',
  'chapter.noDiff': '正文没有差异。',
  'chapter.truncated': '差异过长，当前视图已截断。',
  'chapter.restore': '审批恢复',
  'chapter.restoreRequested': '恢复请求已交给助手，确认审批后会生成一个新版本。',
  'chapter.review': '审查与返修',
  'chapter.reviewCurrent': '审查当前章',
  'chapter.reviewCandidate': '独立审查候选',
  'chapter.reviewRequested': '审查请求已交给助手。完成后刷新本页查看 finding。',
  'chapter.noReview': '尚无审查。',
  'chapter.fresh': '当前有效',
  'chapter.stale': '已过期',
  'chapter.selectFinding': '请先选择要处理的 finding。',
  'chapter.reviseSelected': '按所选问题返修',
  'chapter.reviseRequested': '定向返修已交给助手；结果会成为待独立审查候选。',
  'chapter.candidate': '待处理候选',
  'chapter.adoptCandidate': '审批采用',
  'chapter.adoptRequested': '采用请求已交给助手，仍需通过审批与新鲜度复核。',
  'chapter.rejectReason': '拒绝理由（必填，不会用于自动训练）',
  'chapter.rejectCandidate': '拒绝候选',
  'chapter.rejectRequested': '拒绝决定已交给助手；成功后会释放本章待处理槽。',
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
  'workflow.title': 'Long tasks',
  'workflow.unbound': 'This session is not bound to a book yet.',
  'workflow.empty': 'No recoverable import or map-atlas runs yet.',
  'workflow.loading': 'Refreshing…',
  'workflow.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'workflow.requested': 'The request was sent to the assistant; effectful actions still require approval.',
  'workflow.kind.import': 'Deep import',
  'workflow.kind.atlas': 'Map atlas',
  'workflow.state.running': 'Running',
  'workflow.state.needs-attention': 'Needs attention',
  'workflow.state.completed': 'Completed',
  'workflow.state.failed': 'Failed',
  'workflow.progress': 'Batch progress',
  'workflow.resume': 'Resume',
  'workflow.abandon': 'Abandon with approval',
  'workflow.restart': 'Start new',
  'workflow.restartHint': 'Start a new import for the recorded scope instead of replaying the old run. Chapters:',
  'book.title': 'Library',
  'book.current': 'Current',
  'book.unbound': 'This session is not bound to a book yet.',
  'book.empty': 'The library is empty. Create a book below.',
  'book.open': 'Switch with approval',
  'book.create': 'Create book',
  'book.name': 'Book name (also the library key)',
  'book.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'book.requested': 'The request was sent to the assistant; create or switch still requires approval.',
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
  'outline.workbench': 'Outline and Scene workbench',
  'outline.target': 'Generation target',
  'outline.target.story': 'Story outline',
  'outline.target.thread': 'Plot thread',
  'outline.target.arc': 'Outline arc',
  'outline.task': 'Describe the structural question or direction for this preview…',
  'outline.sources': 'Explicit reference sources',
  'outline.sources.empty': 'No outline, structure, Scene, or world-object sources are available yet.',
  'outline.includeDrafts': 'Allow explicitly selected draft or candidate sources for this request',
  'outline.preview': 'Ask assistant for preview',
  'outline.previews': 'Recent previews',
  'outline.previews.empty': 'No outline or structure previews yet.',
  'outline.receipt': 'Actual sources',
  'outline.warnings': 'Warnings',
  'outline.apply': 'Adopt with approval',
  'outline.chatBusy': 'Chat has an unsent draft. Send or clear it first.',
  'outline.requested': 'The request was sent to the assistant; previews do not write canon, and adoption still requires approval.',
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
  'preset.effort': 'Reasoning effort',
  'preset.effort.default': 'Clear book override (inherit preset/assistant config)',
  'preset.effort.adapterDefault': 'Adapter default',
  'preset.select.ok': 'Applied',
  'preset.select.fail': 'Apply failed, please try again later',
  'preset.source.seed': 'Built-in',
  'preset.source.stored': 'Custom',
  'chapter.view': 'Chapter Text',
  'chapter.select': 'Select chapter',
  'chapter.unbound': 'This session is not bound to a novel vault.',
  'chapter.empty': 'No editable current chapter.',
  'chapter.refresh': 'Refresh',
  'chapter.title': 'Chapter title',
  'chapter.body': 'Chapter body',
  'chapter.status': 'Status',
  'chapter.edit': 'Edit',
  'chapter.save': 'Save with approval',
  'chapter.saving': 'Staging…',
  'chapter.cancel': 'Finish editing',
  'chapter.saveFailed': 'Staging failed. Refresh and try again.',
  'chapter.chatDraftBusy': 'Chat already has an unsent draft. Send or clear it first to avoid overwriting it.',
  'chapter.history': 'Version history',
  'chapter.current': 'Current',
  'chapter.bytes': 'bytes',
  'chapter.invalidHash': 'This legacy version used an older hash convention; restore will fix it.',
  'chapter.diff': 'Diff',
  'chapter.noDiff': 'No body changes.',
  'chapter.truncated': 'The diff is too long and was truncated in this view.',
  'chapter.restore': 'Restore with approval',
  'chapter.restoreRequested': 'The restore request was sent to the assistant; approval creates a new version.',
  'chapter.review': 'Review and revise',
  'chapter.reviewCurrent': 'Review current',
  'chapter.reviewCandidate': 'Review candidate',
  'chapter.reviewRequested': 'The review request was sent to the assistant. Refresh this view when it finishes.',
  'chapter.noReview': 'No review yet.',
  'chapter.fresh': 'Fresh',
  'chapter.stale': 'Stale',
  'chapter.selectFinding': 'Select at least one finding first.',
  'chapter.reviseSelected': 'Revise selected findings',
  'chapter.reviseRequested': 'Targeted revision was sent to the assistant; the result must be reviewed independently.',
  'chapter.candidate': 'Pending candidate',
  'chapter.adoptCandidate': 'Adopt with approval',
  'chapter.adoptRequested': 'The adoption request was sent to the assistant and still requires approval and freshness checks.',
  'chapter.rejectReason': 'Rejection reason (required; not used for automatic training)',
  'chapter.rejectCandidate': 'Reject candidate',
  'chapter.rejectRequested': 'The rejection was sent to the assistant; success releases this chapter’s pending slot.',
}
