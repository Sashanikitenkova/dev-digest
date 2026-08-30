/* SkillsTab — the agent editor's Skills tab.

   Lists the skills LINKED to this agent, in `order`. Two switches decide
   whether a link contributes a block to the review prompt, and they are not the
   same thing: the row checkbox is the per-link switch (`AgentSkillLink.enabled`)
   and the skill's own `enabled` flag is global. A link that is switched off
   keeps its slot in the order — which is why dragging stays meaningful for a
   linked-but-off skill, and why this list never hides one.

   Reorder → POST /agents/:id/skills (array order IS block order).
   Checkbox  → PUT  /agents/:id/skills/:skillId.

   A row is NOT draggable at rest — drag is armed by pressing the handle. Same
   rule, same reason as ContextFilesPicker (see its header): a `draggable`
   ancestor suppresses the click on its own interactive children the moment a
   native drag starts, so a checkbox pressed with a pixel of pointer drift did
   nothing. Keep the two lists in step. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Checkbox, Dropdown, EmptyState, Icon, IconBtn, TextInput } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useAgentSkills, useSetAgentSkills, useToggleAgentSkill } from "../../../../../../../lib/hooks/agents";
import { useSkills } from "../../../../../../../lib/hooks/skills";
import { LINK_MENU_WIDTH } from "./constants";
import { countEnabled, matchesFilter, moveItem, toRows, toSkillIds, unlinkedSkills } from "./helpers";
import { s } from "./styles";

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("skills");
  const { data: links, isError } = useAgentSkills(agent.id);
  const { data: skills } = useSkills();
  const setSkills = useSetAgentSkills();
  const toggle = useToggleAgentSkill();

  const serverRows = React.useMemo(() => toRows(links, skills), [links, skills]);

  // Local order so a drag/move lands immediately; reset whenever the server
  // view changes (the reorder mutation writes the canonical order back).
  const [rows, setRows] = React.useState(serverRows);
  const [syncedFrom, setSyncedFrom] = React.useState(serverRows);
  if (syncedFrom !== serverRows) {
    setSyncedFrom(serverRows);
    setRows(serverRows);
  }

  const [filter, setFilter] = React.useState("");
  const [dragFrom, setDragFrom] = React.useState<number | null>(null);
  const [dragOver, setDragOver] = React.useState<number | null>(null);
  const [dragArmed, setDragArmed] = React.useState<number | null>(null);

  // Disarm wherever the gesture ends, not just on the handle — a press that
  // wanders off before release would leave one row draggable, and that row
  // would go on swallowing its own clicks.
  React.useEffect(() => {
    if (dragArmed === null) return;
    const clear = () => setDragArmed(null);
    window.addEventListener("mouseup", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("mouseup", clear);
      window.removeEventListener("dragend", clear);
    };
  }, [dragArmed]);

  // Filtering hides rows that still occupy prompt-block slots, so there is no
  // honest drop target while a filter is active — reordering is disabled then.
  const filtering = filter.trim().length > 0;
  const visible = rows.filter((r) => matchesFilter(r, filter));
  const unlinked = unlinkedSkills(skills, rows);

  const commit = (next: typeof rows) => {
    setRows(next);
    setSkills.mutate({ agentId: agent.id, skillIds: toSkillIds(next) });
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    commit(moveItem(rows, from, to));
  };

  const unlink = (skillId: string) => commit(rows.filter((r) => r.link.skill_id !== skillId));
  const link = (skillId: string) =>
    setSkills.mutate({ agentId: agent.id, skillIds: [...toSkillIds(rows), skillId] });

  const enabled = countEnabled(rows);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("agentTab.heading")}</h2>
        <Badge color="var(--text-secondary)">
          {t("agentTab.enabledCount", { enabled, total: rows.length })}
        </Badge>
        <div style={s.headerRight}>
          <div style={s.filterBox}>
            <TextInput
              value={filter}
              onChange={setFilter}
              placeholder={t("agentTab.filterPlaceholder")}
              aria-label={t("agentTab.filterPlaceholder")}
            />
          </div>
          <Dropdown
            width={LINK_MENU_WIDTH}
            align="right"
            trigger={
              <Button kind="secondary" size="sm" icon="Plus" disabled={unlinked.length === 0}>
                {t("agentTab.addSkills")}
              </Button>
            }
            items={unlinked.map((sk) => ({ label: sk.name, icon: "Sparkles" as const, onClick: () => link(sk.id) }))}
          />
        </div>
      </div>

      <p style={s.caption}>{t("agentTab.caption")}</p>

      {isError && <div style={s.error}>{t("agentTab.loadError")}</div>}
      {setSkills.isError && <div style={s.error}>{t("agentTab.saveError")}</div>}
      {toggle.isError && <div style={s.error}>{t("agentTab.saveError")}</div>}

      {rows.length === 0 ? (
        <EmptyState icon="Sparkles" title={t("agentTab.empty.title")} body={t("agentTab.empty.body")} />
      ) : visible.length === 0 ? (
        <div style={s.noMatch}>{t("agentTab.noMatch")}</div>
      ) : (
        <div style={s.list}>
          {visible.map((row) => {
            const i = rows.indexOf(row);
            const name = row.skill?.name ?? row.link.skill_id;
            return (
              <div
                key={row.link.skill_id}
                draggable={!filtering && dragArmed === i}
                onDragStart={(e) => {
                  // Firefox refuses to start a drag whose dragstart sets no
                  // data, so this is what makes reordering work there at all.
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", row.link.skill_id);
                  setDragFrom(i);
                }}
                onDragOver={(e) => {
                  if (filtering || dragFrom === null) return;
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                  setDragOver(null);
                  setDragArmed(null);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                  setDragArmed(null);
                }}
                style={s.row(!row.link.enabled, dragOver === i && dragFrom !== i)}
              >
                {!filtering && (
                  <span
                    style={s.handle}
                    aria-hidden="true"
                    data-testid="drag-handle"
                    onMouseDown={() => setDragArmed(i)}
                  >
                    <Icon.Menu size={14} />
                  </span>
                )}
                <Checkbox
                  checked={row.link.enabled}
                  onChange={(v) => toggle.mutate({ agentId: agent.id, skillId: row.link.skill_id, enabled: v })}
                />
                <div style={s.main}>
                  <span style={s.name}>{name}</span>
                  {row.skill?.description && <span style={s.description}>{row.skill.description}</span>}
                </div>
                <div style={s.rowRight}>
                  {row.skill && <Badge color="var(--text-muted)">{row.skill.type}</Badge>}
                  {row.skill?.enabled === false && (
                    <Badge color="var(--text-muted)">{t("agentTab.skillDisabled")}</Badge>
                  )}
                  {!filtering && (
                    <>
                      <IconBtn
                        icon="ArrowUp"
                        size={26}
                        label={t("agentTab.moveUp", { name })}
                        onClick={() => move(i, i - 1)}
                      />
                      <IconBtn
                        icon="ArrowDown"
                        size={26}
                        label={t("agentTab.moveDown", { name })}
                        onClick={() => move(i, i + 1)}
                      />
                    </>
                  )}
                  <IconBtn
                    icon="Trash"
                    size={26}
                    danger
                    label={t("agentTab.unlink")}
                    onClick={() => unlink(row.link.skill_id)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
