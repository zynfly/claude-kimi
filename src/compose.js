import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveAndValidateFile, resolveAndValidateDir } from './paths.js';

const ROLE_ORDER = ['spec', 'plan', 'memory', 'context'];
const FIELD_FOR_ROLE = {
  spec: 'spec_files',
  plan: 'plan_files',
  memory: 'memory_files',
  context: 'context_files',
};

function maxFileBytes() {
  return Math.max(1, parseInt(process.env.KIMI_MAX_FILE_BYTES || '200000', 10));
}
function maxTotalBytes() {
  return Math.max(1, parseInt(process.env.KIMI_MAX_TOTAL_BYTES || '1000000', 10));
}

export function composePrompt(args) {
  const { goal, work_dir } = args;
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('goal must be a non-empty string');
  }
  if (typeof work_dir !== 'string' || !work_dir) {
    throw new Error('work_dir is required');
  }
  if (!isAbsolute(work_dir)) {
    throw new Error(`work_dir must be absolute: ${work_dir}`);
  }
  resolveAndValidateDir(work_dir);

  const lines = [];
  lines.push('# Goal', goal.trim(), '');
  lines.push('# Working directory (read/write)', work_dir, '');

  const allowedDirs = args.allowed_dirs || [];
  if (allowedDirs.length) {
    for (const d of allowedDirs) resolveAndValidateDir(d);
    lines.push('# Additional writable directories');
    for (const d of allowedDirs) lines.push(`- ${d}`);
    lines.push('');
  }

  let total = 0;
  const FILE_CAP = maxFileBytes();
  const TOTAL_CAP = maxTotalBytes();
  const blocks = [];
  for (const role of ROLE_ORDER) {
    const paths = args[FIELD_FOR_ROLE[role]] || [];
    for (const p of paths) {
      const { realpath, bytes } = resolveAndValidateFile(p, work_dir);
      if (bytes > FILE_CAP) {
        throw new Error(
          `file ${p} (${bytes} bytes) exceeds KIMI_MAX_FILE_BYTES=${FILE_CAP}`
        );
      }
      total += bytes;
      if (total > TOTAL_CAP) {
        throw new Error(
          `total inlined bytes (${total}) exceeds KIMI_MAX_TOTAL_BYTES=${TOTAL_CAP}`
        );
      }
      const content = readFileSync(realpath, 'utf8');
      blocks.push(
        `[external_file role=${role} path=${p} bytes=${bytes}]\n${content}\n[/external_file]`
      );
    }
  }
  if (blocks.length) {
    lines.push(
      '# External reference files (READ-ONLY — content inlined verbatim, no filesystem access)',
      ''
    );
    lines.push(...blocks, '');
  }

  if (Array.isArray(args.constraints) && args.constraints.length) {
    lines.push('# Constraints');
    for (const c of args.constraints) lines.push(`- ${c}`);
    lines.push('');
  }
  if (typeof args.expected_output === 'string' && args.expected_output.trim()) {
    lines.push('# Expected output', args.expected_output.trim(), '');
  }

  return lines.join('\n');
}
