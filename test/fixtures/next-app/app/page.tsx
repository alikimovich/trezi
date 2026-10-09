import Link from 'next/link'
import Card from './Card'; import { Label } from 'trezi-fixture-ui'
export default async function Home() {
  return <main><h1>Server title</h1><Card label="First" /><Card label="Second" /><Link href="/second">Next page</Link><Link href="/docs">Docs</Link><Label text="Workspace package" /></main>
}
