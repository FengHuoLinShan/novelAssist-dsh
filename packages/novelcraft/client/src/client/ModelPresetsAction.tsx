// 模型预设(ModelPresetsAction): 会话头动作, 打开模型预设卡 Modal(N20/D13)。
// 数据源 = /novelcraft presets/list(宿主读 ContentPresetRegistry ∪ 种子); 点击卡片经
// presets/select 回宿主 selectPresetInLlmYml —— N19 写边界: 只动 .assistant/llm.yml 的
// preset 单键(配置非资产, 不过 approval); 预设不存在时宿主拒绝, 不写文件。
// 卡片形态参考父仓库 ai-writing-assist: 名称 → 模型 → 状态行(account-provider-card) +
// 参数摘要(T/P, LlmFormFields presetSummary)。半宽纵向(D10), 全部 --dsw-* token。
import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentPresetCard } from '../wire.ts'
import { NS } from './locales.ts'
import { useModelPresets } from './useWatch.ts'
import css from './novelcraft.module.css'

export type ModelPresetsActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

/** 参数摘要行(对齐父仓库 presetSummary「T x · P y」; 无 T/P 时回退 max_tokens/超时)。 */
function paramSummary(p: ContentPresetCard): string {
  const parts: string[] = []
  if (p.temperature !== undefined) parts.push(`T ${p.temperature}`)
  if (p.top_p !== undefined) parts.push(`P ${p.top_p}`)
  if (parts.length === 0) {
    if (p.max_tokens !== undefined) parts.push(`max ${p.max_tokens}`)
    if (p.timeout_ms !== undefined) parts.push(`${Math.round(p.timeout_ms / 1000)}s`)
  }
  return parts.join(' · ')
}

export function ModelPresetsAction(props: ModelPresetsActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { data, busy, select } = useModelPresets(connection, sessionId)

  const bound = data?.bound != null
  // 顶卡即「默认(继承助手配置)」(preset=null), 网格去重同名 seed 卡。
  const presets = (data?.presets ?? []).filter((p) => p.name !== 'default')
  const active = data?.active ?? null
  const defaultRoute = data?.defaultRoute ?? { provider: 'deepseek', model: 'deepseek-chat' }
  const availableProviders = data?.availableProviders ?? []
  const defaultActive = active == null || active === 'default'

  const apply = async (preset: string | null): Promise<void> => {
    setNotice(null)
    const result = await select(preset)
    if (result === null) {
      setNotice(t('preset.select.fail'))
      return
    }
    // 宿主消息即作者语言; 兜底用文案键。
    setNotice(result.ok ? result.message || t('preset.select.ok') : result.message || t('preset.select.fail'))
  }

  return (
    <>
      <button
        type="button"
        className={css.petTrigger}
        title={t('preset.title')}
        aria-label={t('preset.title')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={css.petLabel}>{t('preset.title')}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('preset.title')}
        closeLabel={t('inbox.close')}
        contentClassName={css.modalContent}
      >
        {!bound || data == null ? (
          <div className={css.empty}>{t('preset.unbound')}</div>
        ) : (
          <div className={css.presets}>
            {/* 顶卡: 默认(继承助手配置) → preset=null(移除 llm.yml preset 键)。 */}
            <button
              type="button"
              className={css.card + (defaultActive ? ' ' + css.cardSelected : '')}
              onClick={() => void apply(null)}
              disabled={busy}
            >
              <span className={css.cardTitle}>{t('preset.default.name')}</span>
              <span className={css.presetRoute}>{defaultRoute.provider} · {defaultRoute.model}</span>
              <span className={css.presetStatusRow}>
                {defaultActive
                  ? <span className={css.presetBadge}>{t('preset.current')}</span>
                  : <span className={css.presetUseHint}>{t('preset.use')}</span>}
                <span className={css.presetParams}>{t('preset.default.desc')}</span>
              </span>
            </button>

            {presets.length > 0 ? (
              <div className={css.presetsGrid}>
                {presets.map((p) => {
                  const selected = active === p.name
                  const params = paramSummary(p)
                  return (
                    <button
                      key={p.name}
                      type="button"
                      className={css.card + (selected ? ' ' + css.cardSelected : '')}
                      onClick={() => void apply(p.name)}
                      disabled={busy}
                    >
                      <span className={css.cardTitle}>{p.label ?? p.name}</span>
                      <span className={css.presetRoute}>{p.provider ?? defaultRoute.provider} · {p.model ?? defaultRoute.model}</span>
                      <span className={css.presetStatusRow}>
                        {selected
                          ? <span className={css.presetBadge}>{t('preset.current')}</span>
                          : <span className={css.presetUseHint}>{t('preset.use')}</span>}
                        {params ? <span className={css.presetParams}> · {params}</span> : null}
                        <span className={css.presetParams}> · {p.source === 'seed' ? t('preset.source.seed') : t('preset.source.stored')}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            <div className={css.presetMeta}>
              {t('preset.available')}: {availableProviders.length > 0 ? availableProviders.join(' / ') : '—'}
            </div>
            {notice ? <div className={css.message}>{notice}</div> : null}
          </div>
        )}
      </Modal>
    </>
  )
}
