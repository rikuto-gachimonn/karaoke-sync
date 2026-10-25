import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertLowRisk, assertRequiredRules, requiredChecks, type ChangedFile } from './auto-merge-policy.ts';

type Request = (path: string, method?: string, body?: unknown) => Promise<unknown>;
interface Pull {
  number: number; state: string; draft: boolean; node_id: string; changed_files: number;
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } }; mergeable: boolean | null; auto_merge: unknown;
}
interface Run { id: number; head_sha: string; event: string; conclusion: string | null; status: string; workflow_id: number; pull_requests: { number: number }[] }
export interface Approval { repo: string; actor: string; number: number; sha: string; workflowRef: string; ref: string }

/** Runs only trusted main code, never checks out or executes the PR. Approval binds one exact head SHA. */
export async function approvedMerge(approval: Approval, request: Request) {
  const { repo, actor, number, sha } = approval;
  if (approval.ref !== 'refs/heads/main' || approval.workflowRef !== `${repo}/.github/workflows/low-risk-merge.yml@refs/heads/main` ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('main上のワークフローと正しいPR番号・承認済み40桁SHAが必要です');
  const root = `/repos/${repo}`;
  const permission = await request(`${root}/collaborators/${encodeURIComponent(actor)}/permission`) as { permission: string };
  if (!['admin', 'maintain', 'write'].includes(permission.permission)) throw new Error('承認者にはwrite以上の権限が必要です');
  const getPull = async () => {
    const pr = await request(`${root}/pulls/${number}`) as Pull;
    if (pr.number !== number || pr.state !== 'open' || pr.draft || pr.head.sha !== sha || pr.head.repo?.full_name !== repo ||
        pr.base.ref !== 'main' || pr.base.repo.full_name !== repo || pr.auto_merge) throw new Error('PR・SHA・対象リポジトリが承認条件と一致しません');
    return pr;
  };
  const pr = await getPull();
  // This endpoint returns only active rules. A missing/inaccessible ruleset fails closed.
  assertRequiredRules(await request(`${root}/rules/branches/main`) as Parameters<typeof assertRequiredRules>[0]);
  const files = await request(`${root}/pulls/${number}/files?per_page=100`) as ChangedFile[];
  assertLowRisk(files, pr.changed_files);
  const comparison = await request(`${root}/compare/main...${sha}`) as { behind_by: number; status: string };
  if (comparison.behind_by !== 0 || comparison.status !== 'ahead') throw new Error('mainを取り込んでチェックを再実行してください');
  const workflow = await request(`${root}/actions/workflows/ci.yml`) as { id: number; path: string; state: string };
  if (workflow.path !== '.github/workflows/ci.yml' || workflow.state !== 'active') throw new Error('信頼するPR checksがありません');
  const runs = await request(`${root}/actions/workflows/${workflow.id}/runs?head_sha=${sha}&event=pull_request&per_page=100`) as { workflow_runs: Run[] };
  const latest = runs.workflow_runs.filter(run => run.head_sha === sha && run.event === 'pull_request' && run.workflow_id === workflow.id && run.pull_requests.some(item => item.number === number)).sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error('最新コミットのPR checksが成功していません');
  const jobs = await request(`${root}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`) as { jobs: { name: string; conclusion: string | null }[] };
  if (!requiredChecks.every(name => jobs.jobs.some(job => job.name === name && job.conclusion === 'success'))) throw new Error('Test・Typecheck・Buildの成功が必要です');
  const current = await getPull();
  if (current.mergeable !== true) throw new Error('PRを安全にマージできる状態ではありません');
  // Standard GitHub merge endpoint enforces branch rules; SHA is an atomic stale-approval guard.
  // Do not persist native auto-merge authority across future pushes.
  const result = await request(`${root}/pulls/${number}/merge`, 'PUT', { sha, merge_method: 'squash' }) as { merged: boolean; sha: string };
  if (!result.merged || !/^[a-f0-9]{40}$/.test(result.sha)) throw new Error('GitHubがマージを拒否しました');
  return result.sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKENがありません');
  const request: Request = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${path}。権限・ruleset・必須チェックを確認してください`);
    return response.json();
  };
  try {
    const sha = await approvedMerge({ repo: process.env.GITHUB_REPOSITORY ?? '', actor: process.env.GITHUB_ACTOR ?? '',
      number: Number(process.env.PR_NUMBER), sha: process.env.APPROVED_HEAD_SHA ?? '', ref: process.env.GITHUB_REF ?? '', workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '' }, request);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `merged_sha=${sha}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Approved CSS PR merged: ${sha}. Pages dispatch is the next job.\n`);
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Auto-merge refused. Check this job log for the failing check; no bypass is attempted.\n');
    throw error;
  }
}
