import process from 'node:process';
import { run } from './index';

// The shebang is added by the bundler's banner, not here: a second one in the source
// lands on line 2 of the output, where it is a syntax error rather than a shebang.
process.exitCode = run(process.argv.slice(2));
