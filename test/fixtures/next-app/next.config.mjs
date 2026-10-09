import { fileURLToPath } from 'node:url'
import createMDX from '@next/mdx'
import withTrezi from './.trezi/trezi-next.cjs'
export default withTrezi(createMDX({ options: { remarkPlugins: process.env.NODE_ENV === 'development' ? [fileURLToPath(new URL('./.trezi/trezi-mdx.mjs', import.meta.url))] : [] } })({ transpilePackages: ['trezi-fixture-ui'], pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'md', 'mdx'] }))
