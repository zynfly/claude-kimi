import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export function isInside(child, parent) {
  if (child === parent) return false;
  const rel = relative(parent, child);
  if (!rel) return false;
  if (rel.startsWith('..' + sep) || rel === '..') return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function realpathOrThrow(p) {
  try {
    return realpathSync.native(p);
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error(`path does not exist: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }
    throw e;
  }
}

export function resolveAndValidateFile(inputPath, workDir) {
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(`path must be absolute: ${inputPath}`);
  }
  const realpath = realpathOrThrow(inputPath);
  const realWorkDir = realpathOrThrow(workDir);
  const st = statSync(realpath);
  if (!st.isFile()) {
    throw new Error(`path is not a regular file: ${inputPath}`);
  }
  if (isInside(realpath, realWorkDir) || realpath === realWorkDir) {
    throw new Error(
      `file is inside work_dir (${realWorkDir}); kimi can read it via its own tools — don't inline. Reference it by its work_dir-relative path inside goal or constraints. (path: ${inputPath})`
    );
  }
  return { realpath, bytes: st.size };
}

export function resolveAndValidateDir(inputPath) {
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error(`path must be absolute: ${inputPath}`);
  }
  const realpath = realpathOrThrow(inputPath);
  const st = statSync(realpath);
  if (!st.isDirectory()) {
    throw new Error(`path is not a directory: ${inputPath}`);
  }
  return { realpath };
}
