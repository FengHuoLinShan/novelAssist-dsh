import { useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RpcCaller } from './index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentPresetCard } from '../wire.ts'
import { NS, type NovelcraftKey } from './locales.ts'
import { useModelPresets } from './useWatch.ts'
import { NovelcraftModal } from './NovelcraftModal.tsx'
import css from './novelcraft.module.css'

export type ModelPresetsActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  PropsLocale<typeof NS> & { connection: RpcCaller | undefined }

const PURPOSE: Record<string, NovelcraftKey> = {
  'writing-day': 'preset.purpose.writing',
  'import-day': 'preset.purpose.import',
  polish: 'preset.purpose.polish',
}

function detailsOf(preset: ContentPresetCard, t: ModelPresetsActionProps['t']): string[] {
  const details: string[] = []
  const effortKey = preset.reasoning_effort && ['low', 'medium', 'high', 'max'].includes(preset.reasoning_effort)
    ? `preset.effort.${preset.reasoning_effort}` as NovelcraftKey
    : null
  if (preset.reasoning_effort) details.push(`${t('preset.effort')}：${effortKey ? t(effortKey) : t('common.statusUnknown')}`)
  if (preset.temperature !== undefined) details.push(`T ${preset.temperature}`)
  if (preset.top_p !== undefined) details.push(`P ${preset.top_p}`)
  if (preset.max_tokens !== undefined) details.push(`${t('preset.maxOutput')}：${preset.max_tokens}`)
  if (preset.timeout_ms !== undefined) details.push(`${t('preset.timeout')}：${Math.round(preset.timeout_ms / 60_000)} ${t('preset.minutes')}`)
  return details
}

export function ModelPresetsAction(props: ModelPresetsActionProps): JSX.Element {
  const { t, connection, sessionId } = props
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { data, loading, error, busy, refresh, select, selectEffort } = useModelPresets(connection, sessionId)

  const presets = (data?.presets ?? []).filter((preset) => preset.name !== 'default')
  const active = data?.active ?? null
  const defaultRoute = data?.defaultRoute ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const defaultActive = active == null || active === 'default'

  const apply = async (preset: string | null): Promise<void> => {
    setNotice(null)
    const result = await select(preset)
    setNotice(result?.message ?? t('preset.select.fail'))
  }

  const applyEffort = async (effort: string | null): Promise<void> => {
    setNotice(null)
    const result = await selectEffort(effort)
    setNotice(result?.message ?? t('preset.select.fail'))
  }

  const presetCard = (preset: ContentPresetCard) => {
    const selected = active === preset.name
    const details = detailsOf(preset, t)
    return (
      <article key={preset.name} className={`${css.presetCard} ${selected ? css.cardSelected : ''}`}>
        <button type="button" className={css.presetCardButton} onClick={() => void apply(preset.name)} disabled={busy}>
          <span className={css.cardHeader}>
            <span className={css.cardTitle}>{preset.label ?? preset.name}</span>
            {selected ? <Pill active>{t('preset.current')}</Pill> : null}
          </span>
          <span className={css.presetPurpose}>{t(PURPOSE[preset.name] ?? 'preset.purpose.custom')}</span>
        </button>
        <details className={css.presetDetails}>
          <summary>{t('preset.details')}</summary>
          <div>{preset.provider ?? defaultRoute.provider} · {preset.model ?? defaultRoute.model}</div>
          {details.length > 0 ? <div>{details.join(' · ')}</div> : null}
          <div>{preset.source === 'seed' ? t('preset.source.seed') : t('preset.source.stored')}</div>
        </details>
      </article>
    )
  }

  return (
    <>
      <button type="button" className={css.petTrigger} title={t('preset.title')}
        aria-label={t('preset.title')} onClick={() => setOpen(true)}>
        <span className={css.petLabel}>{t('preset.title')}</span>
      </button>
      <NovelcraftModal open={open} onClose={() => setOpen(false)} title={t('preset.title')}
        closeLabel={t('inbox.close')} className={css.dialog} contentClassName={css.modalContent}>
        {data === null && !error ? <div className={css.empty}>{t('common.loading')}</div> : null}
        {error ? (
          <div className={css.emptyState} role="alert">
            <span>{t('common.loadFailed')}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {data && data.bound == null ? <div className={css.empty}>{t('preset.unbound')}</div> : null}
        {data?.bound ? (
          <div className={css.presets}>
            <article className={`${css.presetCard} ${defaultActive ? css.cardSelected : ''}`}>
              <button type="button" className={css.presetCardButton} onClick={() => void apply(null)} disabled={busy}>
                <span className={css.cardHeader}>
                  <span className={css.cardTitle}>{t('preset.default.name')}</span>
                  {defaultActive ? <Pill active>{t('preset.current')}</Pill> : null}
                </span>
                <span className={css.presetPurpose}>{t('preset.default.desc')}</span>
              </button>
              <details className={css.presetDetails}>
                <summary>{t('preset.details')}</summary>
                <div>{defaultRoute.provider} · {defaultRoute.model}</div>
              </details>
            </article>
            {presets.length > 0 ? <div className={css.presetsGrid}>{presets.map(presetCard)}</div> : null}
            <details className={css.disclosure}>
              <summary>{t('preset.advanced')}</summary>
              <div className={css.workflowPanel}>
                {data.reasoning?.status === 'ready' ? (
                  <label className={css.presetControl}>
                    <span>{t('preset.effort')}</span>
                    <select value={data.reasoning.selected ?? ''}
                      onChange={(event) => void applyEffort(event.currentTarget.value || null)} disabled={busy}>
                      <option value="">{t('preset.effort.default')}</option>
                      {data.reasoning.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}{option.id === data.reasoning?.adapter_default ? ` · ${t('preset.effort.adapterDefault')}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : data.reasoning?.message ? <div className={css.helperText}>{data.reasoning.message}</div> : null}
                <div className={css.helperText}>
                  {t('preset.available')}：{data.availableProviders.length > 0 ? data.availableProviders.join(' / ') : '—'}
                </div>
              </div>
            </details>
            {notice ? <div className={css.message} role="status">{notice}</div> : null}
            {loading ? <div className={css.helperText}>{t('workflow.loading')}</div> : null}
          </div>
        ) : null}
      </NovelcraftModal>
    </>
  )
}
