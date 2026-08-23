import { QueryClient } from '@tanstack/react-query'

/** 全局唯一 QueryClient 实例与默认配置 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})
