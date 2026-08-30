/**
 * CI change detector for the harness evals.
 *
 * Reads a newline-separated list of changed files (repo-relative) from $CHANGED_FILES and maps
 * them onto the eval suites that should run for this PR:
 *
 *   .claude/skills/<name>/**   OR  evals/skills/<name>/**   → run evals/skills/<name>  (content tier)
 *   .claude/agents/<name>.md   OR  evals/agents/<name>/**   → run evals/agents/<name>  (tool tier)
 *   CLAUDE.md / .claude/CLAUDE.md / any agent / engine change → run the workflow tier
 *
 * A changed artifact with NO written evals is NOT a failure: it is reported on the `skipped_*`
 * outputs so the job can print a visible "SKIP <name> (no evals)" line instead of going red.
 *
 * The mirror case is also NOT a failure: an eval suite whose artifact does not exist under
 * .claude/ is an EXPERIMENT VARIANT, not a CI gate — e.g. architecture-reviewer-lite, an ablated
 * copy used for local eval:repeat + eval:delta A/B runs. agentTask/skillTask load the artifact
 * from .claude/ by name, so running one in CI would just throw "agent not found". They are
 * reported on the `variants` output and excluded from the matrices.
 *
 * Emits GitHub Actions step outputs (skills, agents, run_workflow, skipped_skills, skipped_agents)
 * to $GITHUB_OUTPUT. Pure filesystem + string work — no deps.
 */

import { existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(EVALS_DIR, "..");

const changed = (process.env.CHANGED_FILES ?? "")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

/** Does evals/<tier>/<name>/ contain at least one *.eval.ts? */
function hasEvals(tier, name) {
  const dir = join(EVALS_DIR, tier, name);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith(".eval.ts"));
}

/** Does the artifact the eval injects actually exist under .claude/? */
function hasArtifact(tier, name) {
  return existsSync(
    tier === "agents"
      ? join(REPO_ROOT, ".claude", "agents", `${name}.md`)
      : join(REPO_ROOT, ".claude", "skills", name, "SKILL.md"),
  );
}

// Docs that live alongside the artifacts but are not artifacts themselves. Without this,
// `.claude/agents/README.md` is read as an agent named "README" and reported as a missing-eval skip.
const NOT_AN_ARTIFACT = new Set(["README", "CLAUDE"]);

/** Collect distinct artifact names touched under a `.claude` and/or `evals` prefix. */
function touched(reClaude, reEvals) {
  const names = new Set();
  for (const f of changed) {
    const m = f.match(reClaude) ?? f.match(reEvals);
    if (m && !NOT_AN_ARTIFACT.has(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

const skillNames = touched(
  /^\.claude\/skills\/([^/]+)\//,
  /^evals\/skills\/([^/]+)\//,
);
const agentNames = touched(
  /^\.claude\/agents\/([^/]+)\.md$/,
  /^evals\/agents\/([^/]+)\//,
);

// Three-way split per tier: runnable / no evals written / experiment variant with no artifact.
const split = (tier, names) => ({
  run: names.filter((n) => hasEvals(tier, n) && hasArtifact(tier, n)),
  noEvals: names.filter((n) => !hasEvals(tier, n) && hasArtifact(tier, n)),
  variant: names.filter((n) => !hasArtifact(tier, n)),
});

const s = split("skills", skillNames);
const a = split("agents", agentNames);
const skills = s.run;
const skippedSkills = s.noEvals;
const agents = a.run;
const skippedAgents = a.noEvals;
const variants = [...s.variant, ...a.variant].sort();

// The workflow tier measures the LIVE harness, so anything that changes it re-triggers it:
// the root or .claude CLAUDE.md, any agent definition, the workflow cases, or the engine itself.
const runWorkflow = changed.some(
  (f) =>
    f === "CLAUDE.md" ||
    f === ".claude/CLAUDE.md" ||
    (/^\.claude\/agents\/(.+)\.md$/.test(f) && !NOT_AN_ARTIFACT.has(f.match(/^\.claude\/agents\/(.+)\.md$/)[1])) ||
    /^evals\/workflow\//.test(f) ||
    /^evals\/src\//.test(f),
);

const out = process.env.GITHUB_OUTPUT;
const write = (k, v) => (out ? appendFileSync(out, `${k}=${v}\n`) : console.log(`${k}=${v}`));

write("skills", JSON.stringify(skills));
write("agents", JSON.stringify(agents));
write("run_workflow", String(runWorkflow));
write("skipped_skills", skippedSkills.join(" "));
write("skipped_agents", skippedAgents.join(" "));
write("variants", variants.join(" "));

// Human-readable summary in the step log.
console.error("── eval change detection ──");
console.error(`changed files : ${changed.length}`);
console.error(`skills → run  : ${skills.join(", ") || "(none)"}`);
console.error(`agents → run  : ${agents.join(", ") || "(none)"}`);
console.error(`workflow tier : ${runWorkflow ? "run" : "skip"}`);
if (skippedSkills.length) console.error(`SKIP skills (no evals): ${skippedSkills.join(", ")}`);
if (skippedAgents.length) console.error(`SKIP agents (no evals): ${skippedAgents.join(", ")}`);
if (variants.length) console.error(`SKIP variants (no .claude artifact — local A/B only): ${variants.join(", ")}`);
