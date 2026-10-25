import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertLowRisk, assertRequiredRules, requiredChecks } from '../scripts/auto-merge-policy';
import { approvedMerge, type Approval } from '../scripts/approved-merge';
const sha = 'a'.repeat(40), merged = 'b'.repeat(40);
const repo = 'rikuto-gachimonn/karaoke-sync', root = `/repos/${repo}`;
const approval: Approval = { repo, actor: 'owner', number: 15, sha, ref: 'refs/heads/main', workflowRef: `${repo}/.github/workflows/low-risk-merge.yml@refs/heads/main` };
const css = () => ({ filename: 'src/ui/styles.css', status: 'modified', changes: 2, patch: '@@ -1 +1 @@\n-.clock { color:black }\n+.clock { color:red }' });
const rules = () => [{ type: 'pull_request', parameters: { require_code_owner_review: true, dismiss_stale_reviews_on_push: true } }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
  required_status_checks: requiredChecks.map(context => ({ context, integration_id: 15368 })) } }];
function fixture() {
  const pull = { number: 15, state: 'open', draft: false, node_id: 'PR_15', changed_files: 1,
    head: { sha, repo: { full_name: repo } }, base: { ref: 'main', repo: { full_name: repo } }, mergeable: true, auto_merge: null };
  const run = { id: 9, head_sha: sha, event: 'pull_request', workflow_id: 8, status: 'completed', conclusion: 'success', pull_requests: [{ number: 15 }] };
  const data = new Map<string, unknown>([
    [`${root}/collaborators/owner/permission`, { permission: 'write' }], [`${root}/pulls/15`, pull],
    [`${root}/rules/branches/main`, rules()], [`${root}/pulls/15/files?per_page=100`, [css()]],
    [`${root}/compare/main...${sha}`, { behind_by: 0, status: 'ahead' }],
    [`${root}/actions/workflows/ci.yml`, { id: 8, path: '.github/workflows/ci.yml', state: 'active' }],
    [`${root}/actions/workflows/8/runs?head_sha=${sha}&event=pull_request&per_page=100`, { workflow_runs: [run] }],
    [`${root}/actions/runs/9/jobs?filter=latest&per_page=100`, { jobs: requiredChecks.map(name => ({ name, conclusion: 'success' })) }],
  ]);
  const writes = vi.fn();
  const request = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (method !== 'GET') { writes(path, method, body); return { merged: true, sha: merged }; }
    if (!data.has(path)) throw new Error('Unknown API request');
    return structuredClone(data.get(path));
  });
  return { pull, run, data, request, writes };
}
describe('承認付き自動マージの拒否境界', () => {
  it('承認されたCSSだけのPR・3チェック成功・必須rulesetでSHAを指定してマージ', async () => {
    const f = fixture(); expect(await approvedMerge(approval, f.request)).toBe(merged);
    expect(f.writes).toHaveBeenCalledExactlyOnceWith(`${root}/pulls/15/merge`, 'PUT', { sha, merge_method: 'squash' });
  });
  it.each(['src/ui/App.tsx', 'src/ui/chromeLink.ts', 'src/domain/detector.ts', 'src/session/controller.ts', 'src/adapters/audio/microphone.ts',
    'src/adapters/youtube/player.ts', 'src/library/model.ts', 'src/library/backup.ts', '.github/workflows/ci.yml', 'scripts/approved-merge.ts', 'package.json'])('%sの変更を自動承認しない', async filename => {
    const f = fixture(); f.data.set(`${root}/pulls/15/files?per_page=100`, [{ ...css(), filename }]);
    await expect(approvedMerge(approval, f.request)).rejects.toThrow('手動確認'); expect(f.writes).not.toHaveBeenCalled();
  });
  it.each(['added', 'removed', 'renamed'])('CSSでも%sは拒否', status => expect(() => assertLowRisk([{ ...css(), status }], 1)).toThrow());
  it('複数領域・欠落パッチ・取得数の不一致・大きい変更・外部CSSを拒否', () => {
    expect(() => assertLowRisk([css(), { ...css(), filename: 'README.md' }], 2)).toThrow();
    expect(() => assertLowRisk([css()], 2)).toThrow();
    for (const patch of [undefined, '', '+a{background:url(https://example.com)}', '+@import "x.css";', '+a{color:r\\65 d}', '+/* x */']) expect(() => assertLowRisk([{ ...css(), patch }], 1)).toThrow();
    expect(() => assertLowRisk([{ ...css(), changes: 201 }], 1)).toThrow();
  });
  it.each(['failure', 'cancelled', 'skipped', null])('CIの%sを成功扱いしない', async conclusion => {
    const f = fixture(); f.run.conclusion = conclusion as string;
    await expect(approvedMerge(approval, f.request)).rejects.toThrow('成功'); expect(f.writes).not.toHaveBeenCalled();
  });
  it('古い成功より最新の失敗を優先し、スキップされた必須ジョブも拒否', async () => {
    const f = fixture(); f.data.set(`${root}/actions/workflows/8/runs?head_sha=${sha}&event=pull_request&per_page=100`, { workflow_runs: [f.run, { ...f.run, id: 10, conclusion: 'failure' }] });
    await expect(approvedMerge(approval, f.request)).rejects.toThrow(); expect(f.writes).not.toHaveBeenCalled();
    const second = fixture(); second.data.set(`${root}/actions/runs/9/jobs?filter=latest&per_page=100`, { jobs: [{ name: 'Test', conclusion: 'success' }, { name: 'Typecheck', conclusion: 'skipped' }, { name: 'Build', conclusion: 'success' }] });
    await expect(approvedMerge(approval, second.request)).rejects.toThrow(); expect(second.writes).not.toHaveBeenCalled();
  });
  it('PR/SHAと無関係の成功run、workflow_dispatchのrunを流用しない', async () => {
    for (const patch of [{ head_sha: merged }, { pull_requests: [{ number: 16 }] }, { event: 'workflow_dispatch' }, { workflow_id: 99 }]) {
      const f = fixture(); Object.assign(f.run, patch);
      await expect(approvedMerge(approval, f.request)).rejects.toThrow(); expect(f.writes).not.toHaveBeenCalled();
    }
  });
  it('承認なし・SHA変更・fork・draft・別base・既存native Auto-mergeを拒否', async () => {
    for (const patch of [{ draft: true }, { state: 'closed' }, { head: { sha: merged, repo: { full_name: repo } } },
      { head: { sha, repo: { full_name: 'other/repo' } } }, { base: { ref: 'other', repo: { full_name: repo } } }, { auto_merge: {} }]) {
      const f = fixture(); Object.assign(f.pull, patch);
      await expect(approvedMerge(approval, f.request)).rejects.toThrow(); expect(f.writes).not.toHaveBeenCalled();
    }
    const f = fixture(); await expect(approvedMerge({ ...approval, sha: '' }, f.request)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it('許可後・マージ直前にPRのSHAが変われば書込みをしない', async () => {
    const f = fixture(); let reads = 0;
    const request = async (path: string, method?: string, body?: unknown) => {
      if (path === `${root}/pulls/15` && ++reads === 2) f.pull.head.sha = merged;
      return f.request(path, method, body);
    };
    await expect(approvedMerge(approval, request)).rejects.toThrow(); expect(f.writes).not.toHaveBeenCalled();
  });
  it('main以外のワークフロー・権限不足・mainに遅れたPRを拒否', async () => {
    const f = fixture(); await expect(approvedMerge({ ...approval, ref: 'refs/heads/feature' }, f.request)).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
    f.data.set(`${root}/collaborators/owner/permission`, { permission: 'read' });
    await expect(approvedMerge(approval, f.request)).rejects.toThrow('権限'); expect(f.writes).not.toHaveBeenCalled();
    const g = fixture(); g.data.set(`${root}/compare/main...${sha}`, { behind_by: 1, status: 'diverged' });
    await expect(approvedMerge(approval, g.request)).rejects.toThrow('main'); expect(g.writes).not.toHaveBeenCalled();
  });
  it('rulesetなし・PR必須なし・必須チェック不足・発行元不一致を拒否', () => {
    expect(() => assertRequiredRules([])).toThrow();
    expect(() => assertRequiredRules(rules().slice(1))).toThrow();
    const unreviewed = rules(); unreviewed[0]!.parameters!.require_code_owner_review = false; expect(() => assertRequiredRules(unreviewed)).toThrow();
    const weak = rules(); weak[1]!.parameters!.strict_required_status_checks_policy = false; expect(() => assertRequiredRules(weak)).toThrow();
    const spoof = rules(); spoof[1]!.parameters!.required_status_checks![0]!.integration_id = 0; expect(() => assertRequiredRules(spoof)).toThrow();
  });
  it('GitHub APIの失敗時に強制マージしない', async () => {
    const f = fixture(); const request = async (path: string) => { if (path.includes('/rules/')) throw new Error('403'); return f.request(path); };
    await expect(approvedMerge(approval, request)).rejects.toThrow('403'); expect(f.writes).not.toHaveBeenCalled();
  });
  it('PR CIはreadのみ、自動マージは手動dispatch限定、PRコードを権限付きで実行しない', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8'), merge = readFileSync('.github/workflows/low-risk-merge.yml', 'utf8');
    expect(ci).toContain('pull_request:'); expect(ci).not.toContain('pull_request_target'); expect(ci).not.toContain(': write');
    expect(merge).toContain('workflow_dispatch:'); expect(merge).not.toContain('pull_request:'); expect(merge).not.toContain('pull_request_target');
    expect(merge).toContain("if: github.ref == 'refs/heads/main'"); expect(merge).toContain('ref: ${{ github.sha }}');
    expect(merge).not.toContain('pnpm install'); expect(merge).toContain('approved_head_sha'); expect(merge).toContain('gh workflow run pages.yml --ref main'); expect(merge).toContain('gh run watch "$run_id" --exit-status');
  });
});
