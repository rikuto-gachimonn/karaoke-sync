export const requiredChecks = ['Test', 'Typecheck', 'Build'] as const;
export interface ChangedFile { filename: string; status: string; changes: number; patch?: string; previous_filename?: string }
/** A deliberately narrow allowlist: TSX mixes handlers and presentation, so it requires manual review. */
export function assertLowRisk(files: ChangedFile[], expectedCount: number) {
  if (files.length !== expectedCount || files.length !== 1) throw new Error('手動確認: ファイル数不一致または複数領域の変更');
  const file = files[0]!;
  if (file.filename !== 'src/ui/styles.css' || file.status !== 'modified' || file.previous_filename || !file.patch ||
      !Number.isSafeInteger(file.changes) || file.changes < 1 || file.changes > 200 || file.patch.length > 20000) {
    throw new Error('手動確認: 既存CSSの小さな変更のみ許可');
  }
  const changed = file.patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).join('\n');
  if (/url\s*\(|@import|expression\s*\(|\\|\/\*|\*\//i.test(changed)) throw new Error('手動確認: 外部参照・エスケープ・コメントを含むCSS');
}

export function assertRequiredRules(rules: { type: string; parameters?: { require_code_owner_review?: boolean; dismiss_stale_reviews_on_push?: boolean; strict_required_status_checks_policy?: boolean; required_status_checks?: { context: string; integration_id?: number }[] } }[]) {
  const review = rules.find(rule => rule.type === 'pull_request')?.parameters;
  const checks = rules.find(rule => rule.type === 'required_status_checks')?.parameters;
  if (!review?.require_code_owner_review || !review.dismiss_stale_reviews_on_push || !checks?.strict_required_status_checks_policy ||
      !requiredChecks.every(name => checks.required_status_checks?.some(check => check.context === name && check.integration_id === 15368))) {
    throw new Error('mainの有効なrulesetにPR必須・コードオーナーレビュー/古い承認破棄・最新化必須・GitHub ActionsのTest/Typecheck/Build必須チェックを設定してください');
  }
}
