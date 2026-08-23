import type { ThemeConfig } from 'antd'

/**
 * 主题 tokens 占位：品牌色、圆角、间距等基础定制（桌面端优先）。
 * 业务页面（T003+）如需扩展组件级 tokens 在此追加。
 */
export const themeTokens: ThemeConfig = {
  token: {
    colorPrimary: '#2f54eb',
    colorLink: '#2f54eb',
    borderRadius: 6,
    fontSize: 14,
  },
  components: {
    Layout: {
      siderBg: '#ffffff',
      headerBg: '#ffffff',
      bodyBg: '#f5f6f8',
    },
  },
}
