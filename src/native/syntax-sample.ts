// A realistic TSX file of `lines` lines for the code editor's highlighting checks
// (LKM-183): the unit perf test and the native typing check type after `const total`.
const block = (n: number) => [
  `// Card ${n}: a component with state, JSX, a template literal and a regex.`,
  `interface Card${n}Props {`,
  '  title: string',
  '  items: { id: number; label: string; price: number }[]',
  '  onSelect?: (id: number) => void',
  '}',
  '',
  `export function Card${n}({ title, items, onSelect }: Card${n}Props) {`,
  '  const [open, setOpen] = useState(false)',
  '  const total = items.reduce((sum, item) => sum + item.price, 0)',
  '  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")',
  '  useEffect(() => {',
  `    if (total > ${n * 10}) console.info(\`card \${slug} total \${total.toFixed(2)}\`)`,
  '  }, [slug, total])',
  '  return (',
  `    <section className="card" data-slug={slug} aria-expanded={open}>`,
  '      <h2 onClick={() => setOpen(!open)}>{title}</h2>',
  '      {open && (',
  '        <ul>',
  '          {items.map((item) => (',
  '            <li key={item.id} onClick={() => onSelect?.(item.id)}>',
  '              <Price value={item.price} currency="EUR" />',
  '              {item.label}',
  '            </li>',
  '          ))}',
  '        </ul>',
  '      )}',
  '    </section>',
  '  )',
  '}',
  ''
]

export function tsxSample(lines: number) {
  const out = ["import { useEffect, useState } from 'react'", "import { Price } from './Price'", '']
  for (let n = 1; out.length < lines; n++) out.push(...block(n))
  return out.slice(0, lines).join('\n')
}
