
import { PRESETS } from '../../dist/index.js';
import { buildAgentContract } from '../../dist/cli.js';
const c = buildAgentContract();
console.log('PRESETS.length =', PRESETS.length);
console.log('contract.presets.length =', c.presets.length);
console.log('options =', c.options.length, '| config.settings =', c.config.settings.length, '| commands =', c.commands.length);
console.log('names:', PRESETS.map(p => p.name).join(', '));
