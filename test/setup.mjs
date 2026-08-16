// Loaded via --import before every test file (see the npm test script).
//
// Tests drive the real Runner and the real worker, so a config that forgets
// to pin a fixture agent would spawn the actual claude/agy binary — which
// now runs with permission prompts skipped. This turns that mistake into an
// immediate, obvious spawn failure instead of a live agent on your machine.
process.env.ASTERIM_PIPELINE_BLOCK_REAL_AGENTS = '1';
