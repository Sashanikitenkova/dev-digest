import React from "react";
import type { Agent, CiFailOn, Provider, ReviewStrategy } from "@devdigest/shared";
import { useUpdateAgent, useProviderModels } from "../../../../../../../lib/hooks/agents";
import { useToast } from "../../../../../../../lib/toast";
import { toModelOptions } from "../../../../../../../lib/model-label";

// Loosely typed to avoid coupling this hook to next-intl's generic
// `useTranslations` return type — callers pass their scoped `t` directly.
type Translate = (key: string, vars?: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Owns the Config tab's local form state (reset whenever `agent.id` changes),
 * the provider → model-options derivation, and the save mutation. Keeps
 * ConfigTab itself down to layout/markup.
 */
export function useAgentConfigForm(agent: Agent, t: Translate) {
  const toast = useToast();
  const update = useUpdateAgent();
  const [name, setName] = React.useState(agent.name);
  const [description, setDescription] = React.useState(agent.description);
  const [provider, setProvider] = React.useState<Provider>(agent.provider);
  const [model, setModel] = React.useState(agent.model);
  const [systemPrompt, setSystemPrompt] = React.useState(agent.system_prompt);
  const [strategy, setStrategy] = React.useState<ReviewStrategy>(agent.strategy);
  const [ciFailOn, setCiFailOn] = React.useState<CiFailOn>(agent.ci_fail_on);
  const [repoIntel, setRepoIntel] = React.useState(agent.repo_intel);
  const [enabled, setEnabled] = React.useState(agent.enabled);

  // Reset local form when switching agents.
  React.useEffect(() => {
    setName(agent.name);
    setDescription(agent.description);
    setProvider(agent.provider);
    setModel(agent.model);
    setSystemPrompt(agent.system_prompt);
    setStrategy(agent.strategy);
    setCiFailOn(agent.ci_fail_on);
    setRepoIntel(agent.repo_intel);
    setEnabled(agent.enabled);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: models } = useProviderModels(provider);
  // Show the price (USD per 1M in/out tokens) in the label when the provider
  // exposes it (OpenRouter) so a cheap model is easy to pick; value stays the id.
  const modelOptions = toModelOptions(models);
  const hasModel = modelOptions.some((o) => (typeof o === "string" ? o : o.value) === model);
  if (!hasModel) modelOptions.unshift(model);
  // Empty list after load = provider key missing/invalid (listModels failed) —
  // guide the user instead of showing a silent one-item dropdown.
  const noModels = models !== undefined && models.length === 0;

  const save = () =>
    update.mutate(
      {
        id: agent.id,
        patch: {
          name,
          description,
          provider,
          model,
          system_prompt: systemPrompt,
          strategy,
          ci_fail_on: ciFailOn,
          repo_intel: repoIntel,
          enabled,
        },
      },
      {
        // Failures are surfaced by the global mutation error toast; confirm the
        // save with a success toast (not just the inline "Saved (vN)" note).
        onSuccess: (data) => toast.success(t("config.savedToast", { version: data.version })),
      },
    );

  return {
    name,
    setName,
    description,
    setDescription,
    provider,
    setProvider,
    model,
    setModel,
    systemPrompt,
    setSystemPrompt,
    strategy,
    setStrategy,
    ciFailOn,
    setCiFailOn,
    repoIntel,
    setRepoIntel,
    enabled,
    setEnabled,
    modelOptions,
    noModels,
    update,
    save,
  };
}
