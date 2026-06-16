import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { readFileSync } from 'fs';
import {
  bundleSkillsForPrompt,
  bundleSiblingsForPrompt,
  buildSegmentManifest,
  parseAssemblyConfig,
  promptReferencesPath,
  checkRequiredReferences,
} from '../src/file-fetcher';

// Shared, byte-identical with the Python repo's prompt-assembly/golden_vectors.json.
// This test proves the TS implementation reproduces the same contract (SPEC.md) —
// the cross-impl parity guarantee (H1). If it fails, TS has drifted from the spec.
const VECTORS = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'prompt-assembly', 'golden_vectors.json'), 'utf-8'),
);

function makeRepoWith(files: Record<string, string>): { dir: string; sha: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'hosho-golden-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@hosho.local', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git add -A', { cwd: dir });
  execSync('git commit -q -m fixture', { cwd: dir });
  const sha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
  return { dir, sha };
}

describe('golden vectors: bundle_skills (TS↔Python parity)', () => {
  for (const c of VECTORS.bundle_skills) {
    it(c.name, () => {
      const { dir, sha } = makeRepoWith(c.skills);
      const orig = process.cwd();
      process.chdir(dir);
      try {
        const { assembled, bundled, paths } = bundleSkillsForPrompt(c.content, sha, c.skills_dirs);
        expect(bundled).toEqual(c.expected_bundled);
        expect(paths).toEqual(c.expected_paths);
        expect(assembled).toBe(c.expected_assembled);
      } finally {
        process.chdir(orig);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('golden vectors: bundle_siblings (TS↔Python parity)', () => {
  for (const c of VECTORS.bundle_siblings) {
    it(c.name, () => {
      const { dir, sha } = makeRepoWith(c.files);
      const orig = process.cwd();
      process.chdir(dir);
      try {
        const { assembled, bundled, paths } = bundleSiblingsForPrompt(c.content, c.file_path, sha, c.patterns);
        expect(bundled).toEqual(c.expected_bundled);
        expect(paths).toEqual(c.expected_paths);
        expect(assembled).toBe(c.expected_assembled);
      } finally {
        process.chdir(orig);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('golden vectors: build_segment_manifest (TS↔Python parity)', () => {
  for (const c of VECTORS.build_segment_manifest) {
    it(c.name, () => {
      const segs = buildSegmentManifest(
        c.assembled,
        c.main_source,
        new Set<string>(c.known_sections),
        c.source_paths,
      );
      const got = segs.map(s => ({
        source: s.source,
        kind: s.kind,
        blob_start_line: s.blobStartLine,
        source_start_line: s.sourceStartLine,
      }));
      expect(got).toEqual(c.expected_segments);
    });
  }
});

describe('golden vectors: parse_assembly_config (TS↔Python parity)', () => {
  for (const c of VECTORS.parse_assembly_config) {
    it(c.name, () => {
      const cfg = parseAssemblyConfig(c.raw);
      const got = {
        inject_when_referenced: cfg.injectWhenReferenced,
        require_reference: cfg.requireReference.map(r => ({
          file: r.file,
          for: r.for,
          severity: r.severity,
        })),
      };
      expect(got).toEqual(c.expected);
    });
  }
});

describe('golden vectors: prompt_references_path (TS↔Python parity)', () => {
  for (const c of VECTORS.prompt_references_path) {
    it(`${c.path} :: ${c.content.slice(0, 24)}`, () => {
      expect(promptReferencesPath(c.content, c.path)).toBe(c.expected);
    });
  }
});

describe('golden vectors: check_required_references (TS↔Python parity, minimatch glob)', () => {
  for (const c of VECTORS.check_required_references) {
    it(c.name, () => {
      const cfg = parseAssemblyConfig(c.config_raw);
      const got = checkRequiredReferences(c.content, c.file_path, cfg).map(v => v.file);
      expect(got).toEqual(c.expected_violated_files);
    });
  }
});

// resolve_location is intentionally NOT asserted here — the public action has no
// resolver; resolution lives in the private engine, which mirrors SPEC.md §4.
