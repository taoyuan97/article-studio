import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

// 未开启 vitest globals 时需手动注册用例间 DOM 清理
afterEach(cleanup)
