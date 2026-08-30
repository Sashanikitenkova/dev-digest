import type { WorkflowCase } from "../src/index.js";

/**
 * Systemic ("workflow") tier — asserts the real on-disk harness (CLAUDE.md + skills + subagents,
 * loaded via settingSources:["project"]) behaves as documented. Organized by scenario, not by a
 * single artifact, because these behaviors are cross-cutting.
 *
 * Budget: 6 Claude sessions total, covering 13 assertions.
 *   - 4 × trace (multi-facet, ONE session each)           = 4
 *   - 1 × activation pair (positive + near-miss negative) = 2
 *
 * A `trace` folds several assertions into ONE session and stops early (`stopWhen`) once ALL of
 * them are satisfied — so facets are close to free once the session is paid for. Two rules govern
 * what may share a session:
 *
 *   1. Facets must be CAUSALLY LINKED — one realistic task whose natural execution touches all of
 *      them. Independent facets in one prompt multiply flakiness (4 × 0.9 ≈ 0.66) and buy nothing.
 *   2. A dispatch facet goes LAST in the prompt. `stopWhen` needs every facet, so if the subagent
 *      launches before the reads land, the run waits out the whole nested session.
 *
 * Activation NEGATIVES stay unmerged by design: their signal is that a near-miss prompt fails to
 * trigger the skill. Buried in a multi-task prompt, a skill can stay silent because the model is
 * busy elsewhere — the test would pass for the wrong reason.
 *
 * Every path asserted below exists in the repo today; nothing here needs a doc written first.
 */
export const cases: WorkflowCase[] = [
  // --- trace (1 session, 4 facets): the whole backend-kickoff protocol -------------------------
  // One task drives all four in sequence: package CLAUDE.md -> session protocol (INSIGHTS.md) ->
  // layering skill -> review dispatch. Reading the package CLAUDE.md is asked for explicitly
  // because root CLAUDE.md documents that table as a MANUAL FALLBACK (VS Code AUTO-load bug
  // #24987) — and because an auto-loaded file never appears as a Read tool call, so it would be
  // invisible to `filesRead` either way.
  // Endpoint must NOT already exist, or the model reviews existing code inline instead of
  // planning-then-dispatching. GET /reviews/:id/export is genuinely absent from routes.ts.
  // Note: `expectSkills` matches exactly ("x" or "plugin:x"), so if the model picks the
  // neighbouring onion-architecture-workspace skill instead, this fails — which is the signal
  // you want when two skill descriptions overlap.
  {
    kind: "trace",
    name: "backend kickoff runs the full protocol: package CLAUDE.md → INSIGHTS → onion → reviewer",
    prompt:
      "Я збираюся додати новий модуль у server/src/modules, який віддає ревʼю як markdown через " +
      "НОВИЙ, ще не реалізований ендпоінт GET /reviews/:id/export. Дій строго по порядку: " +
      "(1) прочитай настанови саме цього пакета; (2) виконай session-протокол цього репо для " +
      "пакета, якого стосується робота; (3) звірся з правилами шарування бекенду; (4) і лише " +
      "після цього ОБОВʼЯЗКОВО запусти сабагента architecture-reviewer, щоб він оцінив план — " +
      "не рецензуй сам.",
    expectFilesRead: ["server/CLAUDE.md", "server/INSIGHTS.md"],
    expectSkills: ["onion-architecture"],
    expectSubagents: ["architecture-reviewer"],
    maxTurns: 14,
  },

  // --- trace (1 session, 2 facets): the repo-intel exception + its subsystem doc ---------------
  // Facet 1 is the highest-value routing rule in the repo: work under `server/src/modules/repo-intel`
  // counts as `server/` for the session protocol. That mapping lives only in prose (root CLAUDE.md,
  // restated at server/INSIGHTS.md:11) — it cannot be inferred from the tree.
  //
  // Facet 2 is worded the way it is because of a 2026-08-30 failure. The earlier prompt asked WHICH
  // doc describes the subsystem — and server/CLAUDE.md's "Read when…" row names the file outright,
  // so the model could answer without opening it. In one run it did exactly that, then reported
  // "отримав обидва документи" while the trace proved it read only two: a fabricated read that a
  // prose-judging eval would have scored as excellent. The question now asks for the facade→lesson
  // mapping (L02/L04/L05/L06), which appears ONLY inside that README — not in CLAUDE.md and not in
  // service.ts, so neither citing the routing row nor grepping the source can satisfy it.
  // The rule this encodes: make the artifact NECESSARY to finish the task, never merely instructed.
  {
    kind: "trace",
    name: "repo-intel work maps onto server/ and pulls its subsystem README",
    prompt:
      "Мені треба поправити побудову blast radius у server/src/modules/repo-intel. Дві речі: " +
      "(1) за session-протоколом цього репо — чий INSIGHTS.md стосується такої роботи? прочитай його; " +
      "(2) з документації самої підсистеми зʼясуй, які методи фасаду repoIntel.* уже підключені " +
      "в стартері, а які зарезервовані під пізніші лесони — назви конкретні номери лесонів.",
    expectFilesRead: ["server/INSIGHTS.md", "repo-intel/README.md"],
    maxTurns: 8,
  },

  // --- trace (1 session, 3 facets): the same protocol on the frontend side ---------------------
  // Mirrors the backend kickoff on a different package, so a routing rule that only works for
  // server/ (the package with the richest CLAUDE.md) is caught rather than assumed to generalize.
  {
    kind: "trace",
    name: "frontend kickoff runs the protocol: package CLAUDE.md → INSIGHTS → frontend-architecture",
    prompt:
      "Додаю нову сторінку і data-хук у client/. Перш ніж писати код: (1) прочитай настанови саме " +
      "цього пакета; (2) виконай session-протокол цього репо для нього; (3) звірся з правилами " +
      "розміщення фронтенд-коду.",
    expectFilesRead: ["client/CLAUDE.md", "client/INSIGHTS.md"],
    expectSkills: ["frontend-architecture"],
    maxTurns: 10,
  },

  // --- trace (1 session, 2 facets): spec routing + the agent that owns specs -------------------
  // specs/README.md carries a rule the tree does not: SPEC-NN is unique repo-wide, and a spec lands
  // in specs/ ONLY when it touches two or more packages — hence a deliberately cross-package feature.
  //
  // The feature is described concretely because of a 2026-08-30 failure. The earlier prompt asked for
  // a spec for "a feature touching server/ and client/" without naming one, and the model did the
  // right thing in both runs: it resolved SPEC-03, picked the root folder, said it would delegate —
  // and stopped to ask WHAT feature. That matches spec-creator's own contract ("asks its blocking
  // questions and stops before writing whenever the problem … is undefined"), so the 0/2 was a defect
  // in the eval prompt, not in the agent. Nothing about spec-creator was changed. The last clause
  // keeps the main agent from re-gating on details the subagent is supposed to ask for itself.
  {
    kind: "trace",
    name: "spec task routes to specs/README.md and dispatches spec-creator",
    prompt:
      "Треба написати специфікацію на фічу «експорт ревʼю в markdown»: новий ендпоінт у server/, " +
      "який віддає ревʼю як markdown-файл, і кнопка «Завантажити .md» на сторінці ревʼю в client/. " +
      "Спершу звірся з правилами цього репо щодо специфікацій — нумерація і те, в якій теці файл " +
      "має лежати. Потім ОБОВʼЯЗКОВО делегуй написання сабагенту spec-creator — не пиши сам; " +
      "деталей, яких бракує, хай питає він, а не ти.",
    expectFilesRead: ["specs/README.md"],
    expectSubagents: ["spec-creator"],
    maxTurns: 10,
  },

  // --- activation pair (2 sessions): positive + near-miss negative ------------------------------
  // Unmerged on purpose — see the header note on why a negative cannot share a prompt.
  {
    kind: "activation",
    name: "engineering-insights activates on a genuine discovery",
    prompt:
      "Щойно з'ясував, чому pgvector-запит повертав нуль рядків — розмірність колонки не збіглася " +
      "після зміни моделі ембедингів. Хочу це зафіксувати, щоб більше не наступати.",
    skill: "engineering-insights",
    shouldActivate: true,
    maxTurns: 4,
  },
  {
    kind: "activation",
    name: "near-miss negative — explaining the same topic must NOT record an insight",
    prompt:
      "Поясни, як у pgvector працюють розмірності колонок і чому невідповідність повертає нуль рядків.",
    skill: "engineering-insights",
    shouldActivate: false,
    maxTurns: 4,
  },
];
