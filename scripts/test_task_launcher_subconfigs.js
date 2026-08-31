const fs = require('fs');
const path = require('path');
const jsdomRoot = process.env.OK_LANG_HINTS_JSDOM_ROOT || path.join(process.env.TEMP, 'ok-lang-hints-jsdom');
const { JSDOM, VirtualConsole } = require(path.join(jsdomRoot, 'node_modules', 'jsdom'));

const root = 'd:/items/project/github_project/ok-lang-hints';
let html = fs.readFileSync(path.join(root, 'media', 'taskLauncher.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src', 'localization.ts'), 'utf8');
const match = /const EN: WebviewStrings = \{([\s\S]*?)\n\};/.exec(source);
if (!match) throw new Error('EN dictionary not found');
const dictionary = {
  parameters: 'Parameters', collapseParameters: 'Collapse Parameters', launchSettings: 'Launch Settings',
  extraArgs: 'Extra Arguments', extraArgsHint: '', environmentVariables: 'Environment Variables', environmentHint: '',
  timeoutSeconds: 'Timeout', timeoutHint: '', saveParameters: 'Save', reset: 'Reset', configGroup: 'Group',
  commonParameters: 'Common', groupParameters: 'Groups', childTaskConfig: 'Children', otherParameters: 'Other',
  noConfigParameters: 'None', saveLaunchSettings: 'Save launch', schemaFailed: 'Failed {error}', current: 'Current',
  currentValue: '{value}', enabled: 'On', disabled: 'Off', holdCtrlMulti: '', structuredJsonHint: '',
  selectedOptionsHint: '{values}', taskTitle: 'Tasks', refresh: 'Refresh', noTasks: 'No tasks',
  triggerTask: 'Trigger', oneTimeTask: 'One-time', launch: 'Launch', stop: 'Stop', running: 'Running',
  stopping: 'Stopping', timeoutStopping: 'Timeout', taskTimedOut: 'Timed out', taskStopped: 'Stopped',
  taskCompleted: 'Completed', taskFailed: 'Failed'
};
html = html.replaceAll('__CSP_NONCE__', 'test').replaceAll('__I18N_JSON__', JSON.stringify(dictionary));
const sent = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { throw error; });
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  },
});
const { window } = dom;
const task = { module: 'demo', className: 'DemoTask', displayName: 'Demo Task' };
const fields = [
  { key: 'boolSwitch', default: false, value: false, displayKey: 'Boolean switch', type: { sub_configs: { True: ['inlineA'] } } },
  { key: 'inlineA', default: 'a', value: 'a', displayKey: 'Inline A', type: {} },
  { key: 'selector', default: 'one', value: 'one', displayKey: 'Selector', type: { type: 'drop_down', options: ['one', 'two'], sub_configs: { one: ['shared', 'oneOnly'], two: ['shared', 'twoOnly'] }, sub_config_labels: { one: 'Group One', two: 'Group Two' } } },
  { key: 'shared', default: 'shared', value: 'shared', displayKey: 'Shared', type: {} },
  { key: 'oneOnly', default: 'one', value: 'one', displayKey: 'One only', type: {} },
  { key: 'twoOnly', default: 'two', value: 'two', displayKey: 'Two only', type: {} },
  { key: 'titleField', default: false, value: false, displayKey: 'Title field', type: { sub_configs: { True: ['titleChild'] } } },
  { key: 'titleChild', default: 'child', value: 'child', displayKey: 'Title child', type: {} },
  { key: 'plainChild', default: 'plain', value: 'plain', displayKey: 'Plain child', type: {} },
  { key: 'groupSelector', default: 'A', value: 'A', displayKey: 'Hidden selector', type: { type: 'drop_down', options: ['A', 'B'], sub_configs: { A: ['aField'], B: ['bField'] } } },
  { key: 'aField', default: 'a', value: 'a', displayKey: 'A field', type: {} },
  { key: 'bField', default: 'b', value: 'b', displayKey: 'B field', type: {} },
];
const schema = {
  fields,
  kind: 'onetime',
  groupSelector: 'groupSelector',
  configGroups: { A: ['aField'], B: ['bField'], titleField: ['titleField', 'plainChild'] },
  groupLabels: { A: 'A Group', B: 'B Group', titleField: 'Title Group' },
};
window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'tasks', tasks: [task], schemas: { 'demo::DemoTask': schema } } }));

const labels = [...window.document.querySelectorAll('.cfg-group-title')].map(node => node.textContent.trim());
const fieldRows = key => [...window.document.querySelectorAll(`.cfg-field[data-key="${key}"]`)];
const groupByTitle = title => [...window.document.querySelectorAll('.cfg-group')].find(group => group.querySelector(':scope > .cfg-group-header .cfg-group-title')?.textContent.trim() === title);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

assert(fieldRows('groupSelector').length === 0, 'register_config_groups selector must be hidden');
assert(labels.includes('A Group') && labels.includes('B Group'), 'all registered groups must be rendered');
assert(labels.includes('Group One') && labels.includes('Group Two'), 'all option sub-config groups must be rendered');
assert(fieldRows('shared').length >= 2, 'shared field must appear in every option group');
assert(window.document.querySelectorAll('.cfg-group').length >= 5, 'expected permanent collapse groups');
assert(fieldRows('inlineA').length === 1, 'boolean sub-config child must render once');
assert(fieldRows('inlineA')[0].classList.contains('cfg-subconfig'), 'boolean sub-config child must be inline-styled');
assert(!fieldRows('inlineA')[0].closest('.cfg-group'), 'top-level boolean sub-config must not get a collapse group');
assert(fieldRows('inlineA')[0].style.display === 'none', 'false boolean switch must hide True children');
const boolSwitch = fieldRows('boolSwitch')[0].querySelector('input[type="checkbox"]');
boolSwitch.checked = true;
boolSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(fieldRows('inlineA')[0].style.display !== 'none', 'enabling a boolean switch must reveal its inline children');
assert(groupByTitle('Group One') && groupByTitle('Group Two'), 'option groups must not depend on selected value');
assert(!groupByTitle('Group One').classList.contains('open') && !groupByTitle('Group Two').classList.contains('open'), 'collapse state must default closed, independent of config values');
const selector = fieldRows('selector')[0].querySelector('select');
selector.value = '1';
selector.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(groupByTitle('Group One') && groupByTitle('Group Two'), 'changing a selector must not hide or remove any option group');
assert(fieldRows('titleField').length === 1, 'config field may act as a group title without a duplicate row');
assert(fieldRows('titleField')[0].closest('.cfg-group'), 'config field title must still register a collapse group');
assert(fieldRows('titleChild').length === 1 && fieldRows('titleChild')[0].classList.contains('cfg-subconfig'), 'title switch children must remain inline in the title group');
const titleSwitch = fieldRows('titleField')[0].querySelector('input[type="checkbox"]');
titleSwitch.checked = true;
titleSwitch.dispatchEvent(new window.Event('change', { bubbles: true }));
assert(fieldRows('titleChild')[0].style.display !== 'none', 'config-title switch must reveal inline children without changing fold state');
assert(fieldRows('plainChild').length === 1, 'title group regular child must render');

const realSchemaFile = process.argv[2];
let realSummary = null;
if (realSchemaFile) {
  const probe = JSON.parse(fs.readFileSync(realSchemaFile, 'utf8'));
  const dailyEntry = Object.entries(probe.schemas).find(([key]) => key.endsWith('DailyTask::DailyTask'));
  if (!dailyEntry) throw new Error('DailyTask schema not found');
  const [dailyKey, dailySchema] = dailyEntry;
  const dailyTask = { module: dailyKey.split('::')[0], className: 'DailyTask', displayName: dailySchema.displayName || 'DailyTask' };
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'tasks', tasks: [dailyTask], schemas: { [dailyKey]: dailySchema } } }));
  const dailyLabels = [...window.document.querySelectorAll('.cfg-group')].map(group => {
    const header = group.querySelector(':scope > .cfg-group-header');
    return header?.querySelector('.cfg-group-title')?.textContent.trim()
      || header?.querySelector('.cfg-field > label')?.childNodes[0]?.textContent.trim()
      || '';
  }).filter(Boolean);
  const expectedGroups = Object.keys(dailySchema.configGroups || {}).filter(key => key !== '配置选择');
  const boolSubConfigLabels = new Set();
  for (const field of dailySchema.fields) {
    if (typeof field.default !== 'boolean' && typeof field.value !== 'boolean') continue;
    for (const choice of Object.keys(field.type?.sub_configs || {})) boolSubConfigLabels.add(String(choice));
  }
  assert(window.document.querySelectorAll('.cfg-field[data-key="配置选择"]').length === 0, 'real register_config_groups selector must be hidden');
  const missingGroups = expectedGroups.filter(group => !dailyLabels.includes(dailySchema.groupLabels?.[group] || group));
  if (missingGroups.length) console.log('REAL_DEBUG', JSON.stringify({ dailyLabels, missingGroups }));
  assert(!missingGroups.length, 'all real registered groups must be rendered together');
  assert(!dailyLabels.some(label => boolSubConfigLabels.has(label)), 'boolean True/False sub_configs must not become collapse groups');
  realSummary = { dailyGroups: dailyLabels.length, expectedGroups: expectedGroups.length };
}

console.log(JSON.stringify({ groups: labels, sharedCopies: fieldRows('shared').length, hiddenSelector: fieldRows('groupSelector').length, realSummary, sent }));
