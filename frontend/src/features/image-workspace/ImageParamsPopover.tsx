import { Button, Popover, Segmented } from 'antd'
import { formatParamsSummary, PARAM_OPTIONS } from './params'

export interface ImageParamsPopoverProps {
  provider: string
  tier: string
  ratio: string
  /** 运行中禁用 */
  disabled?: boolean
  onChange: (params: { tier: string; ratio: string }) => void
}

/**
 * 图片参数浮层（AntD Popover）：
 * - 分辨率档位 / 尺寸比例按当前 provider 提供可选值；
 * - 选择即时生效（随下一次发送指令提交 tier / ratio）。
 */
export default function ImageParamsPopover({
  provider,
  tier,
  ratio,
  disabled,
  onChange,
}: ImageParamsPopoverProps) {
  const options = PARAM_OPTIONS[provider] ?? PARAM_OPTIONS.aliyun_wanxiang

  const content = (
    <div className="image-params-popover">
      <div className="image-params-row">
        <span className="image-params-label">分辨率档位</span>
        <Segmented
          options={options.tiers}
          value={tier}
          onChange={(value) => onChange({ tier: value as string, ratio })}
        />
      </div>
      <div className="image-params-row">
        <span className="image-params-label">尺寸比例</span>
        <Segmented
          options={options.ratios}
          value={ratio}
          onChange={(value) => onChange({ tier, ratio: value as string })}
        />
      </div>
    </div>
  )

  return (
    <Popover content={content} trigger="click" placement="topLeft" arrow={false}>
      <Button disabled={disabled}>图片参数：{formatParamsSummary(tier, ratio)}</Button>
    </Popover>
  )
}
