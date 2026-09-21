import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('@forgeax/interface/i18n', () => ({getLocale:()=> 'en', useTranslation:()=>({t:(key:string)=>key,i18n:{language:'en'}})}));
let openProcesses: Record<string, boolean> = {};
mock.module('../../task-flow/ui-store', () => ({useTaskFlowUiStore:(select:(state:unknown)=>unknown)=>select({openProcesses,toggleProcess:()=>{}})}));
const { RequestCard } = await import('./RequestCard');
function render(actionable=false) {return renderToStaticMarkup(<RequestCard id="session:role:user" count={2} failures={1} actionable={actionable} header={<b>Current state</b>} history={<p>Original error and tools</p>}><p>Latest output</p></RequestCard>);}
test('one header keeps latest output visible and preserves collapsed history with error count',()=>{
 const html=render(); expect(html.match(/Current state/g)).toHaveLength(1);expect(html).toContain('hidden=""');expect(html).toContain('Original error and tools');expect(html).toContain('1 errors, details retained');expect(html).toContain('Latest output');
});
test('pending interaction cannot be hidden by the history disclosure',()=>{
 expect(render(true)).not.toContain('hidden=""');expect(render(true)).toContain('aria-expanded="true"');
});
test('session and role scoped expansion restores on remount',()=>{
 openProcesses={'request:session:role:user':true};expect(render()).not.toContain('hidden=""');openProcesses={'request:another:role:user':true};expect(render()).toContain('hidden=""');openProcesses={};
});
