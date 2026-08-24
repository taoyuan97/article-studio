import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ModelSelect from './index'

const available = [
  { provider: 'deepseek', model: 'deepseek-chat', context_window: 64_000 },
  { provider: 'moonshot', model: 'kimi-k2', context_window: 128_000 },
]

const unavailable = [{ provider: 'some_vendor', reason: '需要配置 SOME_VENDOR_API_KEY' }]

async function openDropdown() {
  await userEvent.click(screen.getByRole('combobox'))
}

describe('ModelSelect', () => {
  it('渲染当前模型并可切换：onChange 收到 provider 与 model', async () => {
    const onChange = vi.fn()
    render(
      <ModelSelect
        available={available}
        unavailable={[]}
        value={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onChange={onChange}
      />,
    )

    // 当前值展示为 provider|model 编码选项
    expect(screen.getByText('DeepSeek · deepseek-chat')).toBeInTheDocument()

    await openDropdown()
    await userEvent.click(screen.getByTitle('Kimi · kimi-k2'))
    expect(onChange).toHaveBeenCalledWith('moonshot', 'kimi-k2')
  })

  it('运行中 / 加载中禁用', () => {
    const { rerender } = render(
      <ModelSelect
        available={available}
        unavailable={[]}
        value={{ provider: 'deepseek', model: 'deepseek-chat' }}
        disabled
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()

    rerender(
      <ModelSelect
        available={available}
        unavailable={[]}
        value={{ provider: 'deepseek', model: 'deepseek-chat' }}
        disabled={false}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).toBeEnabled()
  })

  it('未配置供应商：选项禁用并显示原因（不显示密钥值）', async () => {
    render(
      <ModelSelect
        available={available}
        unavailable={unavailable}
        value={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onChange={vi.fn()}
      />,
    )

    await openDropdown()

    const unavailableOption = screen.getByTitle('some_vendor（需要配置 SOME_VENDOR_API_KEY）')
    expect(unavailableOption).toHaveClass('ant-select-item-option-disabled')
    // 可用选项不受影响
    expect(screen.getByTitle('Kimi · kimi-k2')).not.toHaveClass('ant-select-item-option-disabled')
  })

  it('点击未配置项不触发 onChange', async () => {
    const onChange = vi.fn()
    render(
      <ModelSelect
        available={available}
        unavailable={unavailable}
        value={{ provider: 'deepseek', model: 'deepseek-chat' }}
        onChange={onChange}
      />,
    )

    await openDropdown()
    await userEvent.click(screen.getByTitle('some_vendor（需要配置 SOME_VENDOR_API_KEY）'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('当前值不在可用列表时补充展示项避免显示漂移', () => {
    render(
      <ModelSelect
        available={available}
        unavailable={[]}
        value={{ provider: 'retired', model: 'old-model' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByText('retired · old-model（当前）')).toBeInTheDocument()
  })

  it('无可用模型时整体禁用', () => {
    render(
      <ModelSelect
        available={[]}
        unavailable={unavailable}
        value={null}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox')).toBeDisabled()
  })
})
