import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App as AntApp } from 'antd'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleVersion } from '../../api/types'

const exportFileMock = vi.fn()

vi.mock('./exportFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exportFile')>()
  return { ...actual, exportFile: (...args: unknown[]) => exportFileMock(...args) }
})

import ExportArticleModal from './ExportArticleModal'

const VERSION_1: ArticleVersion = {
  id: 'v1',
  article_id: 'a1',
  parent_version_id: null,
  version_number: 1,
  title: '第一版',
  provider: 'fake',
  model: 'fake-model',
  run_id: 'r1',
  created_at: '2026-08-27T10:00:00Z',
  content_markdown: '# 第一版\n\n- 内容一',
  instruction: '初稿',
}

const VERSION_2: ArticleVersion = {
  ...VERSION_1,
  id: 'v2',
  parent_version_id: 'v1',
  version_number: 2,
  title: '第二版',
  run_id: 'r2',
  content_markdown: '# 第二版\n\n- 内容二',
  instruction: '修改',
}

function ModalHarness({
  resolveVersion,
}: {
  resolveVersion: (id: string) => Promise<ArticleVersion>
}) {
  const [open, setOpen] = useState(true)
  const [defaultVersionId, setDefaultVersionId] = useState('v2')
  return (
    <AntApp>
      <button
        onClick={() => {
          setDefaultVersionId('v1')
          setOpen(true)
        }}
      >
        重新打开
      </button>
      <ExportArticleModal
        open={open}
        versions={[VERSION_2, VERSION_1]}
        defaultVersionId={defaultVersionId}
        onCancel={() => setOpen(false)}
        resolveVersion={resolveVersion}
      />
    </AntApp>
  )
}

describe('ExportArticleModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    exportFileMock.mockImplementation(async (input: { content: () => Promise<string> }) => {
      await input.content()
      return 'saved'
    })
  })

  it('默认选择展示版本和 Markdown；切换 TXT 后导出纯文本', async () => {
    const user = userEvent.setup()
    const resolveVersion = vi.fn(async (id: string) => (id === 'v1' ? VERSION_1 : VERSION_2))
    render(<ModalHarness resolveVersion={resolveVersion} />)

    expect(
      screen.getByRole('combobox', { name: '导出版本' }).closest('.ant-select'),
    ).toHaveTextContent('v2 · 第二版')
    expect(screen.getByRole('radio', { name: 'Markdown 文档（.md）' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'TXT 文本（.txt）' }))
    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))

    await waitFor(() => expect(resolveVersion).toHaveBeenCalledWith('v2'))
    const exportInput = exportFileMock.mock.calls[0][0]
    expect(exportInput).toMatchObject({ title: '第二版', versionNumber: 2, format: 'txt' })
    expect(await exportInput.content()).toBe('第二版\n\n内容二\n')
    expect(await screen.findByText('文章已导出')).toBeInTheDocument()
  })

  it('重新打开时按新的展示版本重置，并恢复默认 Markdown 格式', async () => {
    const user = userEvent.setup()
    const resolveVersion = vi.fn(async () => VERSION_2)
    render(<ModalHarness resolveVersion={resolveVersion} />)

    await user.click(screen.getByRole('radio', { name: 'TXT 文本（.txt）' }))
    await user.click(screen.getByRole('button', { name: /^取\s*消$/ }))
    await user.click(screen.getByRole('button', { name: '重新打开' }))

    expect(
      screen.getByRole('combobox', { name: '导出版本' }).closest('.ant-select'),
    ).toHaveTextContent('v1 · 第一版')
    expect(screen.getByRole('radio', { name: 'Markdown 文档（.md）' })).toBeChecked()
  })

  it('弹窗切换版本后解析并导出所选版本，不改变默认版本来源', async () => {
    const user = userEvent.setup()
    const resolveVersion = vi.fn(async (id: string) => (id === 'v1' ? VERSION_1 : VERSION_2))
    render(<ModalHarness resolveVersion={resolveVersion} />)

    await user.click(screen.getByRole('combobox', { name: '导出版本' }))
    await user.click(await screen.findByText('v1 · 第一版'))
    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))

    await waitFor(() => expect(resolveVersion).toHaveBeenCalledWith('v1'))
    const exportInput = exportFileMock.mock.calls[0][0]
    expect(exportInput).toMatchObject({
      title: '第一版',
      versionNumber: 1,
      format: 'markdown',
    })
    expect(await exportInput.content()).toBe(VERSION_1.content_markdown)
  })

  it('用户取消系统保存窗口时保持弹窗且不显示失败', async () => {
    const user = userEvent.setup()
    exportFileMock.mockResolvedValue('cancelled')
    render(<ModalHarness resolveVersion={vi.fn(async () => VERSION_2)} />)

    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))

    await waitFor(() => expect(exportFileMock).toHaveBeenCalledOnce())
    expect(screen.getByRole('dialog', { name: '导出文章' })).toBeInTheDocument()
    expect(screen.queryByText(/导出失败/)).not.toBeInTheDocument()
  })

  it('普通下载降级时提示浏览器下载目录', async () => {
    const user = userEvent.setup()
    exportFileMock.mockResolvedValue('downloaded')
    render(<ModalHarness resolveVersion={vi.fn(async () => VERSION_2)} />)

    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))

    expect(
      await screen.findByText('当前浏览器不支持选择保存路径，文件已保存到浏览器下载目录'),
    ).toBeInTheDocument()
  })

  it('正文读取或文件写入失败时保留弹窗并显示错误', async () => {
    const user = userEvent.setup()
    exportFileMock.mockRejectedValue(new Error('磁盘不可写'))
    render(<ModalHarness resolveVersion={vi.fn(async () => VERSION_2)} />)

    await user.click(screen.getByRole('button', { name: /^导\s*出$/ }))

    expect(await screen.findByText('导出失败：磁盘不可写')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '导出文章' })).toBeInTheDocument()
    expect(screen.queryByText('文章已导出')).not.toBeInTheDocument()
  })
})
