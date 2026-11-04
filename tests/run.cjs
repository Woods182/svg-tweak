const path = require('path');
const { spawnSync } = require('child_process');

const files = ['io.cjs', 'geometry.cjs', 'text.cjs', 'structure.cjs', 'mos-library.cjs', 'circuit-library.cjs', 'shape-library.cjs', 'shape-library-capture.cjs', 'ai-api.cjs', 'ai-core.cjs', 'ai.cjs', 'ai-versions.cjs', 'ai-preview.cjs', 'i18n.cjs'];

for (const file of files) {
  console.log('\n[test] ' + file);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.error) {
    console.error('Cannot run ' + file + ': ' + result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('\nPASS: ' + files.length + ' test files.');
