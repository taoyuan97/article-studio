import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import AppLayout from './AppLayout'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppLayout />
    </MemoryRouter>,
  )
}

describe('AppLayout 侧边栏', () => {
  it('渲染第 4 项「发布记录」，位于「素材」之后', () => {
    renderAt('/articles')
    const items = screen.getAllByRole('link')
    const labels = items.map((item) => item.textContent)
    expect(labels).toEqual(['首页', '文章', '素材', '发布记录'])
  })

  it('/publish-records 路径下「发布记录」高亮（aria-current=page）', () => {
    renderAt('/publish-records')
    expect(screen.getByRole('link', { name: '发布记录' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: '素材' })).toHaveAttribute(
      'aria-current',
      'false',
    )
  })

  it('/publish-records/:recordId 深链同样高亮「发布记录」', () => {
    renderAt('/publish-records/rec-1')
    expect(screen.getByRole('link', { name: '发布记录' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('/publish 发布向导路径不误命中「发布记录」高亮', () => {
    renderAt('/publish')
    expect(screen.getByRole('link', { name: '发布记录' })).toHaveAttribute(
      'aria-current',
      'false',
    )
  })
})
