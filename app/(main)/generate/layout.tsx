import { CreationFlowProvider } from '@/components/generate/creation-flow-provider'

export default function GenerateLayout({ children }: { children: React.ReactNode }) {
  return <CreationFlowProvider>{children}</CreationFlowProvider>
}
