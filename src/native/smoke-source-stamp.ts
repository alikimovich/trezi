import assert from 'node:assert/strict'
import { sourceSelector, sourceStamp } from '../preview/source-stamp'

/** Use the real DOM selector engine, with a detached document and no page edits. */
export async function checkSourceStamps(page: (code: string) => Promise<any>) {
  const result = await page(`(() => {
    const sourceSelector = ${sourceSelector.toString()};
    const sourceStamp = ${sourceStamp.toString()};
    const doc = new DOMParser().parseFromString(
      '<div id="conflict" data-trezi-source="new" data-praxis-source="old"></div>' +
      '<div id="legacy" data-praxis-source="old"></div>' +
      '<div id="canonical" data-trezi-source="old"></div>' +
      '<div id="empty" data-trezi-source="" data-praxis-source="old"></div>' +
      '<div id="same" data-trezi-source="old" data-praxis-source="old"></div>', 'text/html');
    const ids = value => Array.from(doc.querySelectorAll(sourceSelector(value)), el => el.id);
    const groups = [ids('old'), ids('new'), ids(''), ids(undefined)];
    const consistent = Array.from(doc.querySelectorAll(sourceSelector())).every(el =>
      el.matches(sourceSelector(sourceStamp(el))));
    // HMR resolution must skip a conflicting legacy stamp earlier in DOM order.
    const healed = doc.querySelector(sourceSelector('old')).id;
    const special = 'src/a["quoted"].tsx:1:2';
    doc.getElementById('canonical').setAttribute('data-trezi-source', special);
    const escaped = ids(special);
    return { groups, consistent, healed, escaped };
  })()`)
  assert.deepEqual(result, {
    groups: [
      ['legacy', 'canonical', 'same'],
      ['conflict'],
      ['empty'],
      ['conflict', 'legacy', 'canonical', 'empty', 'same']
    ],
    consistent: true,
    healed: 'legacy',
    escaped: ['canonical']
  })
  console.log(
    'Native DOM source stamps: canonical precedence, legacy fallback and HMR lookup passed.'
  )
}
