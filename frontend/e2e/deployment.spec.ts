import { expect, test, type Page } from '@playwright/test'

/**
 * 生产形态验证（webServer 即单进程：FastAPI 托管 dist + API + SSE 同源）：
 * - SPA fallback：5 条路由直接访问与刷新均返回 200 且渲染应用（不 404）；
 * - 静态资源与 API 同源可用。
 */

test('SPA fallback：5 条路由直接访问与刷新均不 404', async ({ page }) => {
  // 准备深链所需的真实资源 ID
  const created = await page.request.post('/api/articles')
  const article = (await created.json()) as { id: string }
  const sessionResponse = await page.request.post('/api/image-sessions', {
    data: { article_id: null },
  })
  const session = (await sessionResponse.json()) as { id: string }

  const routes: Array<{ url: string; landmark: (page: Page) => ReturnType<Page['locator']> }> = [
    { url: '/', landmark: (page) => page.getByText('最近文章') },
    { url: '/articles', landmark: (page) => page.getByRole('button', { name: '新建文章' }).first() },
    { url: '/assets', landmark: (page) => page.getByRole('button', { name: '新建配图' }).first() },
    { url: `/articles/${article.id}`, landmark: (page) => page.locator('.workspace-title') },
    { url: `/image-sessions/${session.id}`, landmark: (page) => page.locator('.workspace-title') },
  ]

  for (const route of routes) {
    // 直接访问（深链）返回 200 并渲染应用
    const response = await page.goto(route.url)
    expect(response?.status(), `直接访问 ${route.url} 应为 200`).toBe(200)
    await expect(route.landmark(page)).toBeVisible()

    // 刷新后仍不 404
    const reloaded = await page.reload()
    expect(reloaded?.status(), `刷新 ${route.url} 应为 200`).toBe(200)
    await expect(route.landmark(page)).toBeVisible()
  }
})

test('静态资源与 API 同源可用', async ({ page }) => {
  // 首屏资源全部加载成功（无失败请求）
  const failed: string[] = []
  page.on('requestfailed', (request) => failed.push(request.url()))
  await page.goto('/articles')
  await expect(page.getByRole('button', { name: '新建文章' }).first()).toBeVisible()
  expect(failed.filter((url) => !url.includes('/api/'))).toEqual([])

  // API 健康检查（同源）
  const health = await page.request.get('/api/health')
  expect(health.ok()).toBeTruthy()
})
