import { memo, useMemo } from 'react'
import { Select } from 'antd'
import { modelLabel } from '../../lib/format'
import type { AvailableModel, UnavailableModel } from '../../api/types'

export interface ModelSelectProps {
  available: AvailableModel[]
  /** 未配置供应商：禁用项并显示原因（不显示密钥值） */
  unavailable: UnavailableModel[]
  value: { provider: string; model: string } | null
  /** 运行中/加载中禁用 */
  disabled?: boolean
  onChange: (provider: string, model: string) => void
}

const UNAVAILABLE_PREFIX = '__unavailable__'

/**
 * 模型选择（provider + model）：
 * - 可用模型按 `provider|model` 编码为选项；
 * - 未配置项以禁用选项展示原因；
 * - 当前值不在可用列表时补充展示项，避免显示漂移；
 * - 模型切换只影响后续请求，运行中禁用（由 disabled 控制）。
 */
const ModelSelect = memo(function ModelSelect({
  available,
  unavailable,
  value,
  disabled,
  onChange,
}: ModelSelectProps) {
  const currentValue = value ? `${value.provider}|${value.model}` : undefined

  const options = useMemo(() => {
    const items: { value: string; label: string; disabled?: boolean }[] =
      available.map((item) => ({
        value: `${item.provider}|${item.model}`,
        label: modelLabel(item.provider, item.model),
      }))
    // 当前模型不在可用列表（如供应商被下线）时仍需正确显示
    if (value && !available.some((m) => m.provider === value.provider && m.model === value.model)) {
      items.unshift({
        value: currentValue!,
        label: `${modelLabel(value.provider, value.model)}（当前）`,
      })
    }
    for (const item of unavailable) {
      items.push({
        value: `${UNAVAILABLE_PREFIX}|${item.provider}`,
        label: `${item.provider}（${item.reason}）`,
        disabled: true,
      })
    }
    return items
  }, [available, unavailable, value, currentValue])

  return (
    <Select
      className="model-select"
      aria-label="选择模型"
      value={currentValue}
      options={options}
      disabled={disabled || available.length === 0}
      onChange={(next: string) => {
        if (next.startsWith(UNAVAILABLE_PREFIX)) return
        const [provider, model] = next.split('|')
        onChange(provider, model)
      }}
      style={{ minWidth: 220 }}
    />
  )
})

export default ModelSelect
